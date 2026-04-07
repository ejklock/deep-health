import type { ScannerEngine, ScannerEngineContext } from './types.js';
import type { ScanResultJson } from '../types/scan.js';
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

// ─── SonarQubeEngine ───────────────────────────────────────────────────────────

/**
 * Scanner engine wrapping the sonar-scanner CLI + SonarQube REST API.
 *
 * Phase 1 scope:
 * - External mode only (pre-installed sonar-scanner CLI required)
 * - No Docker mode
 * - No branch analysis
 * - Quality gate + basic metrics collected via SonarQube API
 * - on_failure: 'warn' (default) — failure emits a warning and continues
 * - on_failure: 'fail' — failure propagates as an error
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
   * - Otherwise: runs sonar-scanner, then collects quality gate + metrics from API.
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

    const { host_url, project_key, token_env } = sonarConfig;
    const token = process.env[token_env] ?? '';

    if (!token) {
      throw new EnvironmentError(
        `SonarQube: token environment variable "${token_env}" is not set. ` +
        `Set it before running the scan.`,
      );
    }

    logger.info('SonarQube: running sonar-scanner...');

    // Verify sonar-scanner is installed
    await this.assertAvailable(ctx);

    if (runner.dryRun) {
      logger.info(
        `[DRY-RUN] Would execute: sonar-scanner ` +
        `-Dsonar.host.url=${host_url} -Dsonar.projectKey=${project_key}`,
      );
      return { ...base, status: 'success' };
    }

    // Build sonar-scanner command
    const cmd = [
      'sonar-scanner',
      `-Dsonar.host.url=${host_url}`,
      `-Dsonar.projectKey=${project_key}`,
      `-Dsonar.token=${token}`,
    ].join(' ');

    logger.debug(`Running: sonar-scanner -Dsonar.host.url=${host_url} -Dsonar.projectKey=${project_key} [token omitted]`);

    const scanRun = await runner.run(cmd, { cwd });

    if (scanRun.exitCode !== 0) {
      return {
        ...base,
        status: 'error',
        error: `sonar-scanner exited with code ${scanRun.exitCode}: ${scanRun.stderr || scanRun.stdout}`,
      };
    }

    logger.info('SonarQube: scan complete, collecting quality gate status...');

    // Collect metadata from SonarQube API (best-effort; never blocks the pipeline)
    const [qualityGate, metrics] = await Promise.all([
      fetchSonarQualityGate(host_url, project_key, token),
      fetchSonarMetrics(host_url, project_key, token),
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
    };

    return {
      ...base,
      status: 'success',
      metadata,
    };
  }
}
