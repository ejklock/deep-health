import type { ScannerEngine, ScannerEngineContext } from './types';
import type { ScanResultJson } from '@core/types/scan';
import { DockerSonarQubeProvisioner } from '@infra/provisioner/docker-sonarqube';
import { DockerSonarScannerRunner } from '@infra/provisioner/docker-sonar-scanner';
import { EnvironmentError } from '@core/errors';
import { logger } from '@infra/utils/logger';
import { getPlatformInstallHint } from '@infra/utils/platform';
import { SONARQUBE_PROJECT_KEY_REGEX } from '@core/types/config';

// ─── SonarQube API types (minimal) ─────────────────────────────────────────────

interface SonarQubeQualityGateStatus {
  projectStatus: {
    status: 'OK' | 'WARN' | 'ERROR' | 'NONE';
    conditions?: Array<{
      status: string;
      metricKey: string;
      comparator: string;
      errorThreshold?: string;
      actualValue?: string;
    }>;
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
  issues?: Array<{
    key: string;
    rule: string;
    severity: string;
    component: string;
    line?: number;
    message: string;
    type: string;
    status: string;
  }>;
}

interface SonarQubeUserTokensResponse {
  userTokens?: Array<{ name: string }>;
}

interface SonarQubeGenerateTokenResponse {
  token?: string;
  name?: string;
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
  token: string,
): Promise<SonarQubeQualityGateStatus | null> {
  try {
    const url = `${hostUrl.replace(/\/$/, '')}/api/qualitygates/project_status?projectKey=${encodeURIComponent(projectKey)}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
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
  token: string,
): Promise<Record<string, string> | null> {
  try {
    const url = `${hostUrl.replace(/\/$/, '')}/api/measures/component?component=${encodeURIComponent(projectKey)}&metricKeys=${SONAR_METRICS}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
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
  token: string,
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
      headers: { Authorization: `Bearer ${token}` },
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
      return fallbackData.token ?? null;
    }

    const data = (await response.json()) as SonarQubeGenerateTokenResponse;
    return data.token ?? null;
  } catch (err) {
    logger.warn(`SonarQube: failed to generate ephemeral token — ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ─── Shared scan execution (used by both external and managed modes) ────────────

/**
 * Build sonar-scanner auth args as an array (no shell quoting hazards).
 * Used when invoking via DockerSonarScannerRunner.
 */
function buildAuthArgs(token: string): string[] {
  return [`-Dsonar.token=${token}`];
}

/**
 * Execute sonar-scanner and collect quality gate + metrics from the SonarQube API.
 * Returns the final ScanResultJson.
 *
 * Security: token and branch are always passed via runner.runArgs() (shell=false),
 * preventing shell-injection.  runner.run() is never used for scan invocations.
 *
 * @param branch - Git branch to forward as -Dsonar.branch.name, or null to omit it.
 *   Callers must only pass a non-null value when send_branch_name is explicitly enabled;
 *   the default (CE-safe) behaviour is to pass null regardless of detected branch.
 */
async function executeSonarScan(
  ctx: ScannerEngineContext,
  hostUrl: string,
  projectKey: string,
  token: string,
  base: ScanResultJson,
  branch: string | null,
): Promise<ScanResultJson> {
  const { runner, cwd } = ctx;

  if (runner.dryRun) {
    logger.info(
      `[DRY-RUN] Would execute: sonar-scanner ` +
      `-Dsonar.host.url=${hostUrl} -Dsonar.projectKey=${projectKey}`,
    );
    return { ...base, status: 'success' };
  }

  // Build sonar-scanner args as an array — no shell quoting hazards.
  // Token and branch values are never shell-interpolated.
  const scanArgs = [
    `-Dsonar.host.url=${hostUrl}`,
    `-Dsonar.projectKey=${projectKey}`,
    `-Dsonar.token=${token}`,
    ...(branch ? [`-Dsonar.branch.name=${branch}`] : []),
  ];

  logger.debug(
    `Running: sonar-scanner -Dsonar.host.url=${hostUrl} -Dsonar.projectKey=${projectKey}` +
    (branch ? ` -Dsonar.branch.name=${branch}` : '') +
    ` [token omitted]`,
  );

  // Always use shell-free runArgs() — no fallback to run().
  // runner.runArgs is required by the CommandRunner contract.
  const scanRun = await runner.runArgs('sonar-scanner', scanArgs, { cwd });

  if (scanRun.exitCode !== 0) {
    return {
      ...base,
      status: 'error',
      error: `sonar-scanner exited with code ${scanRun.exitCode}: ${scanRun.stderr || scanRun.stdout}`,
    };
  }

  return collectSonarMetadataAndBuildResult(hostUrl, projectKey, token, base);
}

/**
 * Execute sonar-scanner inside an ephemeral container (fallback when local
 * sonar-scanner is not installed) and collect quality gate + metrics.
 */
async function executeSonarScanViaContainer(
  cwd: string,
  hostUrl: string,
  projectKey: string,
  token: string,
  base: ScanResultJson,
  scannerImage?: string,
  branch?: string | null,
): Promise<ScanResultJson> {
  const scannerRunner = new DockerSonarScannerRunner({
    projectDir: cwd,
    sonarHostUrl: hostUrl,
    ...(scannerImage ? { image: scannerImage } : {}),
  });

  const authArgs = buildAuthArgs(token);
  const extraArgs = [
    `-Dsonar.projectKey=${projectKey}`,
    ...authArgs,
    ...(branch ? [`-Dsonar.branch.name=${branch}`] : []),
  ];

  logger.debug(
    `Running sonar-scanner via container — host: ${hostUrl}, projectKey: ${projectKey}` +
    (branch ? `, branch: ${branch}` : '') +
    ` [token omitted]`,
  );

  const scanRun = await scannerRunner.run(extraArgs);

  if (scanRun.exitCode !== 0) {
    return {
      ...base,
      status: 'error',
      error: `sonar-scanner (container) exited with code ${scanRun.exitCode}: ${scanRun.stderr || scanRun.stdout}`,
    };
  }

  return collectSonarMetadataAndBuildResult(hostUrl, projectKey, token, base);
}

/**
 * After a successful sonar-scanner execution (local or container),
 * fetch quality gate + metrics and assemble the final ScanResultJson.
 */
async function collectSonarMetadataAndBuildResult(
  hostUrl: string,
  projectKey: string,
  token: string,
  base: ScanResultJson,
): Promise<ScanResultJson> {
  logger.info('SonarQube: scan complete, collecting quality gate status...');

  // Collect metadata from SonarQube API (best-effort; never blocks the pipeline)
  const [qualityGate, metrics, issues] = await Promise.all([
    fetchSonarQualityGate(hostUrl, projectKey, token),
    fetchSonarMetrics(hostUrl, projectKey, token),
    fetchSonarIssues(hostUrl, projectKey, token),
  ]);

  const qualityGateStatus = qualityGate?.projectStatus?.status ?? 'UNKNOWN';
  const qualityGatePassed = qualityGateStatus === 'OK';

  if (!qualityGatePassed) {
    logger.warn(`SonarQube: quality gate status is "${qualityGateStatus}"`);
  } else {
    logger.info(`SonarQube: quality gate passed (${qualityGateStatus})`);
  }

  const metadata: Record<string, unknown> = {
    qualityGateStatus,
    qualityGatePassed,
    ...(qualityGate?.projectStatus?.conditions
      ? { qualityGateConditions: qualityGate.projectStatus.conditions }
      : {}),
    ...(metrics ? { metrics } : {}),
    ...(issues ? { issues } : {}),
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
   * - mode='external' (default): connects to configured host_url.
   * - mode='managed': provisions ephemeral Docker container, scans, tears down.
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

    // Defensive runtime guard: project_key must be valid even if it passed schema
    // (e.g. when config was constructed programmatically without Zod validation).
    const { project_key, token_env } = sonarConfig;
    if (!SONARQUBE_PROJECT_KEY_REGEX.test(project_key)) {
      throw new EnvironmentError(
        `SonarQube: invalid project_key "${project_key}". ` +
        `Project keys may only contain letters, digits, hyphens (-), underscores (_), periods (.), and colons (:). ` +
        `Update your project-config.yml and set scanners.sonarqube.project_key to a valid value (e.g. "my-project").`,
      );
    }

    const mode = sonarConfig.mode ?? 'external';

    // ─── Managed mode ────────────────────────────────────────────────────────
    if (mode === 'managed') {
      return this._scanManaged(ctx, project_key, sonarConfig.scanner_image, base, sonarConfig.send_branch_name ?? false);
    }

    // ─── External mode ────────────────────────────────────────────────────────
    const token = process.env[token_env] ?? '';

    if (!token) {
      throw new EnvironmentError(
        `SonarQube: token environment variable "${token_env}" is not set. ` +
        `Set it before running the scan.`,
      );
    }

    logger.info('SonarQube: running sonar-scanner (external mode)...');

    // Verify sonar-scanner is installed
    await this.assertAvailable(ctx);

    // Only forward branch when explicitly opted-in — Community Edition does not support branch analysis.
    const effectiveBranch = sonarConfig.send_branch_name ? (ctx.branch ?? null) : null;

    return executeSonarScan(ctx, sonarConfig.host_url, project_key, token, base, effectiveBranch);
  }

  // ─── Private: managed mode execution ─────────────────────────────────────────

  private async _scanManaged(
    ctx: ScannerEngineContext,
    projectKey: string,
    scannerImage: string | undefined,
    base: ScanResultJson,
    sendBranchName: boolean,
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

    const provisioner = new DockerSonarQubeProvisioner();
    // Only forward branch when explicitly opted-in — Community Edition does not support branch analysis.
    const branch = sendBranchName ? (ctx.branch ?? null) : null;

    let hostUrl: string;
    try {
      const { baseUrl } = await provisioner.provision();
      hostUrl = baseUrl;

      logger.info(`SonarQube: waiting for container to be ready at ${hostUrl}...`);
      await provisioner.waitReady();
      logger.info('SonarQube: container ready');

      // Generate an ephemeral token from the admin API — avoids deprecated sonar.login/sonar.password
      logger.info('SonarQube: generating ephemeral scan token...');
      const ephemeralToken = await generateEphemeralToken(hostUrl, 'deep-health-scan');

      if (!ephemeralToken) {
        logger.warn('SonarQube: ephemeral token generation failed — managed scan cannot proceed safely');
        return {
          ...base,
          status: 'error',
          error: 'SonarQube managed mode: failed to generate ephemeral token from admin API. Ensure the ephemeral container started correctly.',
        };
      }

      logger.info('SonarQube: ephemeral token generated (value not logged)');

      if (localAvailable) {
        // ── Local scanner path ──────────────────────────────────────────────
        return await executeSonarScan(ctx, hostUrl, projectKey, ephemeralToken, base, branch);
      } else {
        // ── Container fallback path ─────────────────────────────────────────
        return await executeSonarScanViaContainer(cwd, hostUrl, projectKey, ephemeralToken, base, scannerImage, branch);
      }
    } finally {
      await provisioner.teardown();
    }
  }
}
