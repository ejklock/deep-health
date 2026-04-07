import type { ScannerEngine, ScannerEngineContext } from './types.js';
import type { ScanResultJson } from '../types/scan.js';
import { DockerSonarQubeProvisioner } from '../provisioner/docker-sonarqube.js';
import { EnvironmentError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { getPlatformInstallHint } from '../utils/platform.js';

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

// ─── Shared scan execution (used by both external and managed modes) ────────────

/**
 * Build auth args for sonar-scanner.
 *
 * External mode: uses the configured token from env.
 * Managed mode (MVP): uses default admin/admin credentials of the ephemeral container.
 * This is acceptable because the container is fully ephemeral and immediately torn down.
 */
function buildAuthArg(mode: 'external' | 'managed', token: string): string {
  if (mode === 'managed') {
    // Ephemeral container — default admin credentials. Phase 3 may introduce
    // token injection via the SonarQube API after provisioning.
    return `-Dsonar.login=admin -Dsonar.password=admin`;
  }
  return `-Dsonar.token=${token}`;
}

/**
 * Execute sonar-scanner and collect quality gate + metrics from the SonarQube API.
 * Returns the final ScanResultJson.
 */
async function executeSonarScan(
  ctx: ScannerEngineContext,
  hostUrl: string,
  projectKey: string,
  token: string,
  mode: 'external' | 'managed',
  base: ScanResultJson,
): Promise<ScanResultJson> {
  const { runner, cwd } = ctx;

  if (runner.dryRun) {
    logger.info(
      `[DRY-RUN] Would execute: sonar-scanner ` +
      `-Dsonar.host.url=${hostUrl} -Dsonar.projectKey=${projectKey}`,
    );
    return { ...base, status: 'success' };
  }

  // Build sonar-scanner command
  const authArg = buildAuthArg(mode, token);
  const cmd = [
    'sonar-scanner',
    `-Dsonar.host.url=${hostUrl}`,
    `-Dsonar.projectKey=${projectKey}`,
    authArg,
  ].join(' ');

  logger.debug(`Running: sonar-scanner -Dsonar.host.url=${hostUrl} -Dsonar.projectKey=${projectKey} [auth omitted]`);

  const scanRun = await runner.run(cmd, { cwd });

  if (scanRun.exitCode !== 0) {
    return {
      ...base,
      status: 'error',
      error: `sonar-scanner exited with code ${scanRun.exitCode}: ${scanRun.stderr || scanRun.stdout}`,
    };
  }

  logger.info('SonarQube: scan complete, collecting quality gate status...');

  // Determine token to use for API calls
  const apiToken = mode === 'managed' ? 'admin' : token;

  // Collect metadata from SonarQube API (best-effort; never blocks the pipeline)
  const [qualityGate, metrics, issues] = await Promise.all([
    fetchSonarQualityGate(hostUrl, projectKey, apiToken),
    fetchSonarMetrics(hostUrl, projectKey, apiToken),
    fetchSonarIssues(hostUrl, projectKey, apiToken),
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
 * Phase 1 (external mode):
 * - sonar-scanner CLI must be pre-installed
 * - Connects to an existing SonarQube instance at host_url
 * - Token via env var (token_env, defaults to SONAR_TOKEN)
 *
 * Phase 2 (managed mode):
 * - Provisions an ephemeral SonarQube Community Edition Docker container
 * - Waits for readiness via API polling
 * - Runs sonar-scanner against the ephemeral instance
 * - Collects quality gate + metrics as in external mode
 * - Tears down the container in a finally block (guaranteed cleanup)
 * - MVP: uses default admin/admin credentials (ephemeral container only)
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

    const mode = sonarConfig.mode ?? 'external';
    const { project_key, token_env } = sonarConfig;

    // ─── Managed mode ────────────────────────────────────────────────────────
    if (mode === 'managed') {
      return this._scanManaged(ctx, project_key, base);
    }

    // ─── External mode (Phase 1 path, preserved) ─────────────────────────────
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

    return executeSonarScan(ctx, sonarConfig.host_url, project_key, token, 'external', base);
  }

  // ─── Private: managed mode execution ─────────────────────────────────────────

  private async _scanManaged(
    ctx: ScannerEngineContext,
    projectKey: string,
    base: ScanResultJson,
  ): Promise<ScanResultJson> {
    const { runner } = ctx;

    logger.info('SonarQube: running in managed mode — provisioning ephemeral container...');

    // Verify sonar-scanner is installed before provisioning (fail fast)
    await this.assertAvailable(ctx);

    const provisioner = new DockerSonarQubeProvisioner();

    let hostUrl: string;
    try {
      const { baseUrl } = await provisioner.provision();
      hostUrl = baseUrl;

      logger.info(`SonarQube: waiting for container to be ready at ${hostUrl}...`);
      await provisioner.waitReady();
      logger.info('SonarQube: container ready');

      if (runner.dryRun) {
        logger.info(
          `[DRY-RUN] Would execute: sonar-scanner ` +
          `-Dsonar.host.url=${hostUrl} -Dsonar.projectKey=${projectKey}`,
        );
        return { ...base, status: 'success' };
      }

      return await executeSonarScan(ctx, hostUrl, projectKey, 'admin', 'managed', base);
    } finally {
      await provisioner.teardown();
    }
  }
}
