import type { ScannerEngine, ScannerEngineContext } from './types';
import type { ScanResultJson } from '@core/types/scan';
import type { SonarQubeScanMetadata, SonarQubeIssue, SonarQubeQualityGateCondition } from '@core/types/sonarqube';
import { DockerSonarQubeProvisioner } from '@infra/provisioner/docker-sonarqube';
import { DockerSonarScannerRunner } from '@infra/provisioner/docker-sonar-scanner';
import { EnvironmentError } from '@core/errors';
import { logger } from '@infra/utils/logger';
import { getPlatformInstallHint } from '@infra/utils/platform';
import { SONARQUBE_PROJECT_KEY_REGEX } from '@core/types/config';
import { readSonarProperties, sanitizeAndWriteProperties, type SanitizedPropertiesFile } from './sonar-properties';
import fs from 'node:fs';
import { rm } from 'node:fs/promises';
import { CLI_NAME } from '@infra/brand';

// ─── SonarQube API types (minimal) ─────────────────────────────────────────────

interface SonarQubeQualityGateStatus {
  projectStatus: {
    status: 'OK' | 'WARN' | 'ERROR' | 'NONE';
    conditions?: SonarQubeQualityGateCondition[];
  };
}

interface SonarQubeMeasuresResponse {
  component: {
    measures?: Array<{
      metric: string;
      value?: string;
    }>;
  };
}

interface SonarQubeIssuesResponse {
  total?: number;
  issues?: SonarQubeIssue[];
}

interface SonarQubeUserTokensResponse {
  userTokens?: Array<{ name: string }>;
}

interface SonarQubeGenerateTokenResponse {
  token?: string;
  name?: string;
}

interface SonarQubeCeTaskResponse {
  task?: {
    status: 'PENDING' | 'IN_PROGRESS' | 'SUCCESS' | 'FAILED' | 'CANCELED';
    analysisId?: string;
  };
}

// Exclusions and sources are now sourced from the project's sonar-project.properties.
// Ecosystem-aware defaults moved to the init-time template generator in
// src/app/commands/init.ts — generating once at setup is simpler than mixing
// defaults at scan time.

// ─── CE-task waiting ──────────────────────────────────────────────────────────

/**
 * Parse the sonar-scanner CE task ID from `.scannerwork/report-task.txt`.
 *
 * sonar-scanner writes this file to `<cwd>/.scannerwork/report-task.txt`
 * after completing analysis submission.  It contains lines of `key=value`.
 *
 * We read `ceTaskId` from that file using `hostUrl` for subsequent API calls
 * (NOT `serverUrl` from the file — the file's serverUrl may reflect an internal
 * Docker network address, whereas hostUrl is always the address we can reach).
 *
 * Returns null when the file is absent or the key is not found.
 */
function parseCeTaskId(cwd: string): string | null {
  try {
    const reportTaskPath = `${cwd}/.scannerwork/report-task.txt`;
    const content = fs.readFileSync(reportTaskPath, 'utf8');
    for (const line of content.split('\n')) {
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (key === 'ceTaskId') return value || null;
    }
    return null;
  } catch {
    // File absent or unreadable — not an error; fall back to immediate QG fetch
    return null;
  }
}

/**
 * Remove the .scannerwork/ directory that sonar-scanner creates in the project root.
 * Best-effort: never throws, never fails the pipeline.
 */
export async function cleanupScannerWorkDir(cwd: string): Promise<void> {
  const scannerWorkPath = `${cwd}/.scannerwork`;
  try {
    await rm(scannerWorkPath, { recursive: true, force: true });
    logger.debug('SonarQube: cleaned up .scannerwork/');
  } catch (err) {
    logger.debug(`SonarQube: could not clean up .scannerwork/ — ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Poll the SonarQube CE task until it reaches a terminal state (SUCCESS/FAILED/CANCELED)
 * or until `timeoutMs` is exceeded.
 *
 * Uses `hostUrl` (not the serverUrl written by sonar-scanner to report-task.txt) because
 * the file's serverUrl may reflect an internal Docker network address.
 *
 * Back-off: starts at 2 s, doubles each poll, capped at 15 s.
 *
 * @returns `'success'` | `'failed'` | `'timeout'` | `'skipped'` (task id unavailable)
 */
async function waitForCeTask(
  hostUrl: string,
  taskId: string | null,
  authHeader: string,
  timeoutMs: number,
): Promise<'success' | 'failed' | 'timeout' | 'skipped'> {
  if (!taskId) {
    logger.debug('SonarQube CE: no task ID available — skipping CE wait, proceeding to quality gate fetch immediately');
    return 'skipped';
  }
  if (timeoutMs <= 0) {
    logger.debug('SonarQube CE: ce_task_timeout_seconds=0 — CE wait disabled');
    return 'skipped';
  }

  const base = hostUrl.replace(/\/$/, '');
  const deadline = Date.now() + timeoutMs;
  let delay = 2_000; // start at 2 s

  logger.info(`SonarQube CE: waiting for task ${taskId} to complete (timeout: ${Math.round(timeoutMs / 1000)}s)...`);

  while (Date.now() < deadline) {
    try {
      const url = `${base}/api/ce/task?id=${encodeURIComponent(taskId)}`;
      const response = await fetch(url, {
        headers: { Authorization: authHeader },
      });

      if (!response.ok) {
        logger.warn(`SonarQube CE: task poll returned HTTP ${response.status} — will retry`);
      } else {
        const data = (await response.json()) as SonarQubeCeTaskResponse;
        const status = data.task?.status;
        logger.debug(`SonarQube CE: task status = ${status ?? 'unknown'}`);

        if (status === 'SUCCESS') {
          logger.info('SonarQube CE: task completed successfully');
          return 'success';
        }
        if (status === 'FAILED' || status === 'CANCELED') {
          logger.warn(`SonarQube CE: task ended with status "${status}"`);
          return 'failed';
        }
        // PENDING or IN_PROGRESS — keep polling
      }
    } catch (err) {
      logger.warn(`SonarQube CE: poll error — ${err instanceof Error ? err.message : String(err)}`);
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const wait = Math.min(delay, remaining);
    await new Promise<void>((resolve) => setTimeout(resolve, wait));
    delay = Math.min(delay * 2, 15_000); // cap at 15 s
  }

  logger.warn(
    `SonarQube CE: task ${taskId} did not complete within timeout (${Math.round(timeoutMs / 1000)}s). ` +
    `Proceeding to quality gate fetch — results may be from a previous analysis.`,
  );
  return 'timeout';
}

// ─── Metrics to collect ────────────────────────────────────────────────────────

const SONAR_METRICS = [
  'bugs',
  'vulnerabilities',
  'code_smells',
  'coverage',
  'duplicated_lines_density',
  'security_hotspots',
].join(',');

// ─── SonarQube API helpers ─────────────────────────────────────────────────────

async function fetchSonarQualityGate(
  hostUrl: string,
  projectKey: string,
  authHeader: string,
): Promise<SonarQubeQualityGateStatus | null> {
  try {
    const url = `${hostUrl.replace(/\/$/, '')}/api/qualitygates/project_status?projectKey=${encodeURIComponent(projectKey)}`;
    const response = await fetch(url, {
      headers: {
        Authorization: authHeader,
      },
    });
    if (!response.ok) {
      logger.warn(`SonarQube: quality gate API returned ${response.status} ${response.statusText}`);
      return null;
    }
    return (await response.json()) as SonarQubeQualityGateStatus;
  } catch (err) {
    logger.warn(`SonarQube: failed to fetch quality gate status — ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function fetchSonarMetrics(
  hostUrl: string,
  projectKey: string,
  authHeader: string,
): Promise<Record<string, string> | null> {
  try {
    const url = `${hostUrl.replace(/\/$/, '')}/api/measures/component?component=${encodeURIComponent(projectKey)}&metricKeys=${SONAR_METRICS}`;
    const response = await fetch(url, {
      headers: {
        Authorization: authHeader,
      },
    });
    if (!response.ok) {
      logger.warn(`SonarQube: measures API returned ${response.status} ${response.statusText}`);
      return null;
    }
    const data = (await response.json()) as SonarQubeMeasuresResponse;
    const metrics: Record<string, string> = {};
    for (const measure of data.component.measures ?? []) {
      if (measure.value !== undefined) {
        metrics[measure.metric] = measure.value;
      }
    }
    return metrics;
  } catch (err) {
    logger.warn(`SonarQube: failed to fetch metrics — ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Fetch a limited list of issues from SonarQube (best-effort, max 50).
 * Used to produce the "affected files" section in reports.
 * Limits to OPEN, BLOCKER/CRITICAL/MAJOR issues, capped at MAX_ISSUES_FOR_REPORT.
 */
const MAX_ISSUES_FOR_REPORT = 50;

async function fetchSonarIssues(
  hostUrl: string,
  projectKey: string,
  authHeader: string,
): Promise<SonarQubeIssuesResponse['issues'] | null> {
  try {
    const severities = 'BLOCKER,CRITICAL,MAJOR';
    const url =
      `${hostUrl.replace(/\/$/, '')}/api/issues/search` +
      `?componentKeys=${encodeURIComponent(projectKey)}` +
      `&statuses=OPEN` +
      `&severities=${severities}` +
      `&ps=${MAX_ISSUES_FOR_REPORT}`;
    const response = await fetch(url, {
      headers: { Authorization: authHeader },
    });
    if (!response.ok) {
      logger.warn(`SonarQube: issues API returned ${response.status} ${response.statusText}`);
      return null;
    }
    const data = (await response.json()) as SonarQubeIssuesResponse;
    return data.issues ?? null;
  } catch (err) {
    logger.warn(`SonarQube: failed to fetch issues — ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ─── Dynamic timeout helpers ─────────────────────────────────────────────────────

/**
 * Scanner timeout threshold (seconds) above which a warning is emitted.
 * Constant — not a config field.
 */
const LARGE_SCANNER_TIMEOUT_THRESHOLD_S = 1800;

/**
 * Fetch ncloc (non-commented lines of code) from the last SonarQube analysis.
 * Best-effort — returns null on any error (no prior analysis, API unavailable, etc.).
 * Only called for external mode before scan submission.
 */
async function fetchNcloc(
  hostUrl: string,
  projectKey: string,
  authHeader: string,
): Promise<number | null> {
  try {
    const url = `${hostUrl.replace(/\/$/, '')}/api/measures/component?component=${encodeURIComponent(projectKey)}&metricKeys=ncloc`;
    const response = await fetch(url, {
      headers: { Authorization: authHeader },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as SonarQubeMeasuresResponse;
    const measure = data.component.measures?.find((m) => m.metric === 'ncloc');
    if (!measure?.value) return null;
    const n = parseInt(measure.value, 10);
    return isNaN(n) ? null : n;
  } catch {
    return null;
  }
}

/**
 * Compute effective scanner and CE timeouts.
 *
 * When ncloc is available and dynamic_timeout is not false, applies:
 *   scanner = max(floor, ceil(60 + kloc * scanner_seconds_per_kloc) * 1000)
 *   ce      = max(floor, ceil(30 + kloc * ce_seconds_per_kloc) * 1000)
 *
 * Static configured values (scanner_timeout_seconds, ce_task_timeout_seconds)
 * always serve as the floor — dynamic scaling never reduces them.
 */
function computeEffectiveTimeouts(
  sonarConfig: { scanner_timeout_seconds?: number; ce_task_timeout_seconds?: number; dynamic_timeout?: boolean; timeout_scale?: { scanner_seconds_per_kloc?: number; ce_seconds_per_kloc?: number } },
  ncloc: number | null,
): { scannerTimeoutMs: number; ceTimeoutMs: number } {
  const floorScannerMs = (sonarConfig.scanner_timeout_seconds ?? 300) * 1_000;
  const floorCeMs = (sonarConfig.ce_task_timeout_seconds ?? 120) * 1_000;

  if (sonarConfig.dynamic_timeout === false || ncloc === null) {
    return { scannerTimeoutMs: floorScannerMs, ceTimeoutMs: floorCeMs };
  }

  const scale = sonarConfig.timeout_scale ?? {};
  const scannerPerKloc = scale.scanner_seconds_per_kloc ?? 3;
  const cePerKloc = scale.ce_seconds_per_kloc ?? 1.5;
  const kloc = ncloc / 1_000;

  const dynamicScannerMs = Math.ceil(60 + kloc * scannerPerKloc) * 1_000;
  const dynamicCeMs = Math.ceil(30 + kloc * cePerKloc) * 1_000;

  const scannerTimeoutMs = Math.max(floorScannerMs, dynamicScannerMs);
  const ceTimeoutMs = Math.max(floorCeMs, dynamicCeMs);

  logger.info(
    `SonarQube: dynamic timeout — ncloc=${ncloc} (${kloc.toFixed(1)}k lines) → ` +
    `scanner=${Math.round(scannerTimeoutMs / 1000)}s, ce=${Math.round(ceTimeoutMs / 1000)}s`,
  );

  const scannerTimeoutS = Math.round(scannerTimeoutMs / 1000);
  if (scannerTimeoutS > LARGE_SCANNER_TIMEOUT_THRESHOLD_S) {
    logger.warn(
      `SonarQube: computed scanner timeout is ${scannerTimeoutS}s (ncloc=${ncloc ?? 'n/a'}) — ` +
      `this exceeds ${LARGE_SCANNER_TIMEOUT_THRESHOLD_S}s. ` +
      `Consider reducing timeout_scale.scanner_seconds_per_kloc or setting scanner_timeout_seconds manually.`,
    );
  }

  return { scannerTimeoutMs, ceTimeoutMs };
}

// ─── Ephemeral token generation ────────────────────────────────────────────────

/**
 * Generate a short-lived user token against the ephemeral SonarQube instance
 * using the default admin credentials.
 *
 * SonarQube ≥9.x deprecated `sonar.login` / `sonar.password` in favour of
 * `sonar.token`. Rather than keeping deprecated auth, we generate a real token
 * via the admin REST API and use it for both sonar-scanner and API calls.
 *
 * The token is intentionally NOT logged.
 *
 * @param hostUrl   - Base URL of the ephemeral SonarQube instance.
 * @param tokenName - Name to give the generated token (informational).
 * @returns The generated token string, or `null` if generation failed.
 */
async function generateEphemeralToken(
  hostUrl: string,
  tokenName: string,
): Promise<string | null> {
  const base = hostUrl.replace(/\/$/, '');
  // Basic auth with default admin/admin credentials of the ephemeral container
  const credentials = Buffer.from('admin:admin').toString('base64');
  const authHeader = `Basic ${credentials}`;

  try {
    // Delete the token first (idempotent — best-effort, ignore 404)
    await fetch(`${base}/api/user_tokens/revoke`, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `name=${encodeURIComponent(tokenName)}`,
    }).catch(() => undefined);

    // Generate a fresh token
    const response = await fetch(`${base}/api/user_tokens/generate`, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `name=${encodeURIComponent(tokenName)}&type=USER_TOKEN`,
    });

    if (!response.ok) {
      logger.warn(`SonarQube: token generation returned HTTP ${response.status} — will retry with global analysis token type`);

      // Fallback: try without type (older SonarQube CE versions)
      const fallback = await fetch(`${base}/api/user_tokens/generate`, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `name=${encodeURIComponent(tokenName)}`,
      });

      if (!fallback.ok) {
        logger.warn(`SonarQube: token generation failed (HTTP ${fallback.status}) — managed scan will use Basic auth fallback`);
        return null;
      }

      const fallbackData = (await fallback.json()) as SonarQubeGenerateTokenResponse;
      return fallbackData.token || null;
    }

    const data = (await response.json()) as SonarQubeGenerateTokenResponse;
    return data.token || null;
  } catch (err) {
    logger.warn(`SonarQube: failed to generate ephemeral token — ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ─── Shared scan execution (used by both external and managed modes) ────────────

/**
 * Shape shared by both scan paths (local vs container scanner).
 *
 * `sanitized` is the staged sonar-project.properties copy: the user's file
 * minus deprecated/CLI-owned keys, with any overrides (host.url + token for
 * managed mode) applied. Passed to sonar-scanner via `-Dproject.settings=<path>`.
 * Caller owns the cleanup in a finally block.
 */
interface SonarScanExecContext {
  hostUrl: string;
  projectKey: string;
  token: string;
  branch: string | null;
  ceTimeoutMs: number;
  scannerTimeoutMs: number;
  sanitized: SanitizedPropertiesFile;
  /** Authorization header for REST API calls (CE polling, quality gate, etc).
   * Defaults to `Bearer ${token}` when absent.
   * Managed mode sets this to Basic admin:admin for reliability. */
  pollAuthHeader?: string;
  /** JVM options passed to sonar-scanner via SONAR_SCANNER_OPTS env var.
   * When set, injected via the runner env option (local) or DockerSonarScannerRunner env (container). */
  scannerJvmOpts?: string;
}

/** Build the `-D` args common to both local and container scanner invocations. */
function buildSonarScanCliArgs(ec: SonarScanExecContext): string[] {
  const args: string[] = [
    // project.settings wins the file-loading race: scanner uses OUR sanitized
    // copy instead of the user's original sonar-project.properties. Everything
    // else passed as `-D` has higher precedence than the file — safe overrides.
    `-Dproject.settings=${ec.sanitized.path}`,
    `-Dsonar.host.url=${ec.hostUrl}`,
    `-Dsonar.projectKey=${ec.projectKey}`,
    `-Dsonar.login=${ec.token}`,   // sonar-scanner 4.x compat
    `-Dsonar.token=${ec.token}`,   // sonar-scanner 5.x+
  ];
  if (ec.branch) {
    args.push(`-Dsonar.branch.name=${ec.branch}`);
  }
  return args;
}

/**
 * Execute sonar-scanner via the local runner (CommandRunner.runArgs) and
 * collect quality gate + metrics.
 *
 * Security: token and branch are always passed via runner.runArgs() (shell=false),
 * preventing shell-injection.  runner.run() is never used for scan invocations.
 */
async function executeSonarScan(
  ctx: ScannerEngineContext,
  base: ScanResultJson,
  ec: SonarScanExecContext,
): Promise<ScanResultJson> {
  const { runner, cwd } = ctx;

  if (runner.dryRun) {
    logger.info(
      `[DRY-RUN] Would execute: sonar-scanner ` +
      `-Dsonar.host.url=${ec.hostUrl} -Dsonar.projectKey=${ec.projectKey}`,
    );
    return { ...base, status: 'success' };
  }

  const scanArgs = buildSonarScanCliArgs(ec);
  const authHeader = ec.pollAuthHeader ?? `Bearer ${ec.token}`;

  if (ec.scannerJvmOpts) {
    logger.info(`SonarQube: applying JVM options via SONAR_SCANNER_OPTS: ${ec.scannerJvmOpts}`);
  }

  logger.info(
    `SonarQube: running sonar-scanner (timeout: ${Math.round(ec.scannerTimeoutMs / 1000)}s) — ` +
    `host: ${ec.hostUrl}, projectKey: ${ec.projectKey}` +
    (ec.branch ? `, branch: ${ec.branch}` : ''),
  );

  const scanStartMs = Date.now();
  const scanRun = await runner.runArgs('sonar-scanner', scanArgs, {
    cwd,
    timeout: ec.scannerTimeoutMs,
    onLine: (line) => logger.info(line),
    ...(ec.scannerJvmOpts ? { env: { SONAR_SCANNER_OPTS: ec.scannerJvmOpts } } : {}),
  });
  const scanDurationMs = scanRun.durationMs ?? (Date.now() - scanStartMs);
  const elapsedS = Math.round(scanDurationMs / 1000);

  logger.info(`SonarQube: sonar-scanner finished in ${elapsedS}s`);

  if (scanRun.timedOut) {
    return {
      ...base,
      status: 'error',
      error: `sonar-scanner timed out after ${elapsedS}s (computed timeout: ${Math.round(ec.scannerTimeoutMs / 1000)}s)`,
    };
  }

  if (scanRun.exitCode !== 0) {
    return {
      ...base,
      status: 'error',
      error: `sonar-scanner exited with code ${scanRun.exitCode}: ${scanRun.stderr || scanRun.stdout}`,
    };
  }

  try {
    const taskId = parseCeTaskId(cwd);
    const ceTaskOutcome = await waitForCeTask(ec.hostUrl, taskId, authHeader, ec.ceTimeoutMs);

    if (ceTaskOutcome === 'timeout') {
      logger.warn(
        `SonarQube: CE task did not complete in time — quality gate results may reflect a previous analysis.`,
      );
    }

    return await collectSonarMetadataAndBuildResult(ec.hostUrl, ec.projectKey, authHeader, base, ceTaskOutcome, scanDurationMs);
  } finally {
    await cleanupScannerWorkDir(cwd);
  }
}

/**
 * Execute sonar-scanner inside an ephemeral container (fallback when local
 * sonar-scanner is not installed) and collect quality gate + metrics.
 *
 * NOTE: when using this path, `ec.sanitized.path` MUST be inside `cwd` (the
 * container mounts only that directory). The caller is responsible for
 * passing a sanitized file built with `location: 'cwd-hidden'`.
 */
async function executeSonarScanViaContainer(
  cwd: string,
  base: ScanResultJson,
  ec: SonarScanExecContext,
  scannerImage?: string,
): Promise<ScanResultJson> {
  if (ec.scannerJvmOpts) {
    logger.info(`SonarQube: applying JVM options via SONAR_SCANNER_OPTS: ${ec.scannerJvmOpts}`);
  }

  const scannerRunner = new DockerSonarScannerRunner({
    projectDir: cwd,
    sonarHostUrl: ec.hostUrl,
    ...(scannerImage ? { image: scannerImage } : {}),
    ...(ec.scannerJvmOpts ? { env: { SONAR_SCANNER_OPTS: ec.scannerJvmOpts } } : {}),
  });

  // The scanner runner injects `-Dsonar.host.url` itself (translating localhost
  // → host.docker.internal). Strip our duplicate so we don't pass it twice.
  const extraArgs = buildSonarScanCliArgs(ec).filter((a) => !a.startsWith('-Dsonar.host.url='));
  const authHeader = ec.pollAuthHeader ?? `Bearer ${ec.token}`;

  logger.info(
    `SonarQube: running sonar-scanner via container (timeout: ${Math.round(ec.scannerTimeoutMs / 1000)}s) — ` +
    `host: ${ec.hostUrl}, projectKey: ${ec.projectKey}` +
    (ec.branch ? `, branch: ${ec.branch}` : ''),
  );

  const timeoutMs = ec.scannerTimeoutMs;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const containerScanStartMs = Date.now();
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(Object.assign(new Error(`sonar-scanner (container) timed out after ${Math.round(timeoutMs / 1000)}s (computed timeout: ${Math.round(timeoutMs / 1000)}s)`), { isScannerTimeout: true })),
      timeoutMs,
    );
  });

  let scanRun: Awaited<ReturnType<typeof scannerRunner.run>>;
  try {
    scanRun = await Promise.race([scannerRunner.run(extraArgs, (line) => logger.info(line)), timeoutPromise]);
    clearTimeout(timeoutId);
  } catch (err) {
    clearTimeout(timeoutId);
    const containerDurationMs = Date.now() - containerScanStartMs;
    const containerElapsedS = Math.round(containerDurationMs / 1000);
    logger.info(`SonarQube: sonar-scanner (container) finished in ${containerElapsedS}s`);
    // Only swallow timeout errors — let scanner errors propagate so callers'
    // finally blocks (e.g. provisioner teardown) still execute.
    if ((err as { isScannerTimeout?: boolean }).isScannerTimeout) {
      return { ...base, status: 'error', error: (err as Error).message };
    }
    throw err;
  }

  const containerDurationMs = Date.now() - containerScanStartMs;
  const containerElapsedS = Math.round(containerDurationMs / 1000);
  logger.info(`SonarQube: sonar-scanner (container) finished in ${containerElapsedS}s`);

  if (scanRun.exitCode !== 0) {
    return {
      ...base,
      status: 'error',
      error: `sonar-scanner (container) exited with code ${scanRun.exitCode}: ${scanRun.stderr || scanRun.stdout}`,
    };
  }

  try {
    const taskId = parseCeTaskId(cwd);
    const ceTaskOutcome = await waitForCeTask(ec.hostUrl, taskId, authHeader, ec.ceTimeoutMs);

    if (ceTaskOutcome === 'timeout') {
      logger.warn(
        `SonarQube: CE task did not complete in time — quality gate results may reflect a previous analysis.`,
      );
    }

    return await collectSonarMetadataAndBuildResult(ec.hostUrl, ec.projectKey, authHeader, base, ceTaskOutcome, containerDurationMs);
  } finally {
    await cleanupScannerWorkDir(cwd);
  }
}

/**
 * After a successful sonar-scanner execution (local or container),
 * fetch quality gate + metrics and assemble the final ScanResultJson.
 */
async function collectSonarMetadataAndBuildResult(
  hostUrl: string,
  projectKey: string,
  authHeader: string,
  base: ScanResultJson,
  ceTaskOutcome: 'success' | 'timeout' | 'failed' | 'skipped',
  scanDurationMs: number,
): Promise<ScanResultJson> {
  logger.info('SonarQube: scan complete, collecting quality gate status...');

  // Collect metadata from SonarQube API (best-effort; never blocks the pipeline)
  const [qualityGate, metrics, issues] = await Promise.all([
    fetchSonarQualityGate(hostUrl, projectKey, authHeader),
    fetchSonarMetrics(hostUrl, projectKey, authHeader),
    fetchSonarIssues(hostUrl, projectKey, authHeader),
  ]);

  const qualityGateStatus = qualityGate?.projectStatus?.status ?? 'UNKNOWN';
  const qualityGatePassed = qualityGateStatus === 'OK';

  if (!qualityGatePassed) {
    logger.warn(`SonarQube: quality gate status is "${qualityGateStatus}"`);
  } else {
    logger.info(`SonarQube: quality gate passed (${qualityGateStatus})`);
  }

  const metadata: SonarQubeScanMetadata = {
    qualityGateStatus,
    qualityGatePassed,
    ...(qualityGate?.projectStatus?.conditions
      ? { qualityGateConditions: qualityGate.projectStatus.conditions }
      : {}),
    ...(metrics ? { metrics } : {}),
    ...(issues ? { issues } : {}),
    ceTaskOutcome,
    scanDurationMs,
  };

  return {
    ...base,
    status: 'success',
    metadata,
  };
}

// ─── SonarQubeEngine ───────────────────────────────────────────────────────────

/**
 * Scanner engine wrapping the sonar-scanner CLI + SonarQube REST API.
 *
 * External mode (default):
 * - sonar-scanner CLI must be pre-installed
 * - Connects to an existing SonarQube instance at host_url
 * - Token via env var (token_env, defaults to SONAR_TOKEN)
 *
 * Managed mode:
 * - Provisions an ephemeral SonarQube Community Edition Docker container
 * - Waits for readiness via API polling
 * - Generates a short-lived token from the ephemeral instance (admin API)
 * - Runs sonar-scanner against the ephemeral instance using sonar.token
 * - Collects quality gate + metrics as in external mode
 * - Tears down the container in a finally block (guaranteed cleanup)
 *
 * Token security:
 * - External mode: token comes from env var, never logged
 * - Managed mode: ephemeral token generated via admin API, never logged
 *   If token generation fails, falls back to Basic auth via admin credentials
 *   (acceptable for ephemeral containers only, and logged as a warning)
 *
 * on_failure: 'warn' (default) — failure emits a warning and continues
 * on_failure: 'fail' — failure propagates as an error
 *
 * This engine's results are stored in `engineResults` of the aggregated result.
 * They do NOT feed Gate A (which is always driven by OSV output).
 */
export class SonarQubeEngine implements ScannerEngine {
  readonly id = 'sonarqube';
  readonly name = 'SonarQube';
  readonly order = 100;
  /**
   * SonarQube runs in the post-fix phase so it analyses the final state of the
   * code after all ecosystem fixers have completed.
   */
  readonly phase = 'post-fix' as const;

  /**
   * Verify that sonar-scanner CLI is available.
   * Only called when SonarQube is enabled in config.
   * Throws EnvironmentError with platform-specific install hint if not found.
   */
  async assertAvailable(ctx: ScannerEngineContext): Promise<void> {
    const result = await ctx.runner.run('sonar-scanner --version', { cwd: ctx.cwd });
    if (result.exitCode !== 0) {
      const hint = getPlatformInstallHint('sonar-scanner');
      throw new EnvironmentError(
        `sonar-scanner not found. ${hint}`,
      );
    }
  }

  /**
   * Probe whether a local sonar-scanner is available.
   * Returns true/false — never throws.
   * Used by managed mode to decide whether to use local scanner or container fallback.
   */
  private async _isLocalScannerAvailable(ctx: ScannerEngineContext): Promise<boolean> {
    try {
      const result = await ctx.runner.run('sonar-scanner --version', { cwd: ctx.cwd });
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  /**
   * Execute SonarQube scan.
   *
   * - If SonarQube is not configured or disabled: returns a 'skipped' result immediately.
   * - If sonar-scanner is unavailable: throws EnvironmentError (caller handles warn/fail).
   * - mode='external' (default): uses sonar.host.url from sonar-project.properties
   *   and SONAR_TOKEN from the environment.
   * - mode='managed': provisions an ephemeral SonarQube container, generates a token,
   *   overrides host.url+token via CLI args, scans, tears down.
   *
   * In both modes the sonar-project.properties is sanitized into a temp copy
   * before being handed to sonar-scanner (strips sonar.login/sonar.password
   * which sonar-scanner ≥5 rejects outright).
   */
  async scan(ctx: ScannerEngineContext): Promise<ScanResultJson> {
    const { runner, config, cwd } = ctx;

    const base: ScanResultJson = {
      $schema: 'sonarqube-scan-result/v1',
      agent: 'sonarqube',
      status: 'skipped',
      environment: runner.environment,
      ecosystems: {},
      error: null,
    };

    const sonarConfig = config.scanners?.sonarqube;

    // Not configured or explicitly disabled — skip silently
    if (!sonarConfig || !sonarConfig.enabled) {
      logger.debug('SonarQube: scan skipped (not enabled in config)');
      return base;
    }

    // Read sonar.projectKey from the project's sonar-project.properties — the
    // SonarQube-convention source of truth. Missing file is a hard error:
    // run `${CLI_NAME} init` to generate a template.
    const userProps = await readSonarProperties(cwd);
    if (!userProps) {
      throw new EnvironmentError(
        `SonarQube: sonar-project.properties not found at ${cwd}. ` +
        `Run \`${CLI_NAME} init\` (with SonarQube enabled) to generate a template, ` +
        `or create the file manually at your project root.`,
      );
    }

    const projectKey = userProps.get('sonar.projectKey');
    if (!projectKey) {
      throw new EnvironmentError(
        `SonarQube: sonar-project.properties is missing \`sonar.projectKey\`. ` +
        `Add a line like: sonar.projectKey=my-project`,
      );
    }
    if (!SONARQUBE_PROJECT_KEY_REGEX.test(projectKey)) {
      throw new EnvironmentError(
        `SonarQube: invalid sonar.projectKey "${projectKey}" in sonar-project.properties. ` +
        `Project keys may only contain letters, digits, hyphens (-), underscores (_), periods (.), and colons (:).`,
      );
    }

    const mode = sonarConfig.mode ?? 'external';

    // Compute static floor timeouts first (used for managed mode and as floor for external)
    let ncloc: number | null = null;

    if (mode === 'managed') {
      logger.debug('SonarQube: managed mode — using static timeouts (no prior ncloc available)');
      const { scannerTimeoutMs, ceTimeoutMs } = computeEffectiveTimeouts(sonarConfig, null);
      return this._scanManaged(ctx, projectKey, sonarConfig.scanner_image, (sonarConfig as any).server_image as string | undefined, base, sonarConfig.send_branch_name ?? false, ceTimeoutMs, scannerTimeoutMs, sonarConfig.scanner_jvm_opts);
    }

    // ─── External mode ────────────────────────────────────────────────────────
    // Token resolution precedence (highest to lowest):
    //   1. SONAR_TOKEN env var  — recommended; keeps secrets out of the repo
    //   2. sonar.token in sonar-project.properties  — modern SonarQube key (9.x+)
    //   3. sonar.login in sonar-project.properties  — legacy key (pre-9.x)
    // Only throw when ALL three sources are absent.
    const envToken = process.env['SONAR_TOKEN'] ?? '';
    const propsToken = userProps.get('sonar.token') ?? '';
    const propsLogin = userProps.get('sonar.login') ?? '';

    let token: string;
    if (envToken) {
      token = envToken;
    } else if (propsToken) {
      token = propsToken;
      logger.warn(
        `SonarQube: using sonar.token from sonar-project.properties as a fallback. ` +
        `For better security, set the SONAR_TOKEN environment variable instead.`,
      );
    } else if (propsLogin) {
      token = propsLogin;
      logger.warn(
        `SonarQube: using sonar.login from sonar-project.properties as a fallback. ` +
        `For better security, set the SONAR_TOKEN environment variable instead.`,
      );
    } else {
      throw new EnvironmentError(
        `SonarQube: the SONAR_TOKEN environment variable is not set. ` +
        `Set it before running the scan (generate a token in your SonarQube UI at User → My Account → Security).`,
      );
    }

    const hostUrl = userProps.get('sonar.host.url');
    if (!hostUrl) {
      throw new EnvironmentError(
        `SonarQube: sonar-project.properties is missing \`sonar.host.url\` (required in external mode). ` +
        `Add a line like: sonar.host.url=http://your-sonarqube-server:9000`,
      );
    }

    // Fetch ncloc for dynamic timeout scaling (external + non-dryRun only)
    // Both token and hostUrl are guaranteed available at this point.
    if (!runner.dryRun && sonarConfig.dynamic_timeout !== false) {
      ncloc = await fetchNcloc(hostUrl, projectKey, `Bearer ${token}`);
    }

    const { scannerTimeoutMs, ceTimeoutMs } = computeEffectiveTimeouts(sonarConfig, ncloc);

    logger.info('SonarQube: running sonar-scanner (external mode)...');
    await this.assertAvailable(ctx);

    const effectiveBranch = sonarConfig.send_branch_name ? (ctx.branch ?? null) : null;

    const sanitized = await sanitizeAndWriteProperties({
      cwd,
      location: 'os-tmpdir', // local scanner: any readable path works
      overrides: {
        'sonar.host.url': hostUrl,
        'sonar.projectKey': projectKey,
      },
    });

    try {
      return await executeSonarScan(ctx, base, {
        hostUrl,
        projectKey,
        token,
        branch: effectiveBranch,
        ceTimeoutMs,
        scannerTimeoutMs,
        sanitized,
        ...(sonarConfig.scanner_jvm_opts ? { scannerJvmOpts: sonarConfig.scanner_jvm_opts } : {}),
      });
    } finally {
      await sanitized.cleanup();
    }
  }

  // ─── Private: managed mode execution ─────────────────────────────────────────

  private async _scanManaged(
    ctx: ScannerEngineContext,
    projectKey: string,
    scannerImage: string | undefined,
    serverImage: string | undefined,
    base: ScanResultJson,
    sendBranchName: boolean,
    ceTimeoutMs: number,
    scannerTimeoutMs: number,
    scannerJvmOpts?: string,
  ): Promise<ScanResultJson> {
    const { runner, cwd } = ctx;

    // Dry-run short-circuit: must happen BEFORE any provisioner or sonar-scanner
    // availability check is invoked. No Docker container is ever started in dry-run.
    if (runner.dryRun) {
      logger.info(
        `[DRY-RUN] Would provision ephemeral SonarQube container and execute: sonar-scanner ` +
        `-Dsonar.host.url=<managed> -Dsonar.projectKey=${projectKey}`,
      );
      return { ...base, status: 'success' };
    }

    logger.info('SonarQube: running in managed mode — provisioning ephemeral container...');

    // Check whether local sonar-scanner is available (no throw — we fall back on miss).
    const localAvailable = await this._isLocalScannerAvailable(ctx);

    if (localAvailable) {
      logger.info('SonarQube: local sonar-scanner found — using local scanner');
    } else {
      logger.info('SonarQube: local sonar-scanner not found — will use sonarsource/sonar-scanner-cli container fallback');
    }

    const provisioner = new DockerSonarQubeProvisioner(
      serverImage ? { image: serverImage } : {}
    );
    const branch = sendBranchName ? (ctx.branch ?? null) : null;

    let hostUrl: string;
    try {
      const { baseUrl } = await provisioner.provision();
      hostUrl = baseUrl;

      logger.info(`SonarQube: waiting for container to be ready at ${hostUrl}...`);
      await provisioner.waitReady();
      logger.info('SonarQube: container ready');

      logger.info('SonarQube: generating ephemeral scan token...');
      const ephemeralToken = await generateEphemeralToken(hostUrl, `${CLI_NAME}-scan`);

      if (!ephemeralToken) {
        logger.warn('SonarQube: ephemeral token generation failed — managed scan cannot proceed safely');
        return {
          ...base,
          status: 'error',
          error: 'SonarQube managed mode: failed to generate ephemeral token from admin API. Ensure the ephemeral container started correctly.',
        };
      }

      logger.info('SonarQube: ephemeral token generated (value not logged)');

      // Build sanitized properties with the managed-mode overrides. Location
      // depends on the execution path:
      //   - local scanner: can read anywhere → use os.tmpdir
      //   - container scanner: only sees cwd (mounted volume) → use hidden cwd file
      const sanitized = await sanitizeAndWriteProperties({
        cwd,
        location: localAvailable ? 'os-tmpdir' : 'cwd-hidden',
        overrides: {
          'sonar.host.url': hostUrl,
          'sonar.projectKey': projectKey,
        },
      });

      try {
        const adminAuthHeader = `Basic ${Buffer.from('admin:admin').toString('base64')}`;
        const ec = {
          hostUrl,
          projectKey,
          token: ephemeralToken,
          branch,
          ceTimeoutMs,
          scannerTimeoutMs,
          sanitized,
          pollAuthHeader: adminAuthHeader,
          ...(scannerJvmOpts ? { scannerJvmOpts } : {}),
        };
        if (localAvailable) {
          return await executeSonarScan(ctx, base, ec);
        }
        return await executeSonarScanViaContainer(cwd, base, ec, scannerImage);
      } finally {
        await sanitized.cleanup();
      }
    } finally {
      await provisioner.teardown();
    }
  }
}

// Export for testing — not part of the public scanner engine API
export { computeEffectiveTimeouts, fetchNcloc };
