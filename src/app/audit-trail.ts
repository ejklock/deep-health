import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ScanResultJson } from '@core/types/scan';
import type { UpdateResultJson } from '@core/types/update';
import { logger } from '@infra/utils/logger';

export interface AuditTrailRecord {
  /** ISO 8601 timestamp of the run start */
  timestamp: string;
  /** CLI version — populated from package.json or falls back to 'unknown' */
  cli_version: string;
  /** Whether the run used --dry-run mode */
  dry_run: boolean;
  /** Scan result at time of execution (before-fix snapshot from Gate A) */
  scan: ScanResultJson | null;
  /** Per-ecosystem update results */
  updates: Record<string, UpdateResultJson>;
  /** Overall pipeline status */
  overall_status: string;
  /** True if vulnerabilities remain after the run */
  has_pending_vulns: boolean;
}

/**
 * Write a JSON audit trail record for this pipeline run.
 *
 * Writes to `<reportsDir>/runs/<timestamp>.json`.
 * When `reportsDir` is not provided, falls back to `<cwd>/.deep-health/runs`.
 * Timestamps use ISO 8601 format with colons replaced by hyphens for filesystem safety
 * (e.g. "2026-04-23T14-30-00.000Z.json").
 *
 * Never throws — failures are logged as warnings so they never block the pipeline.
 */
export async function writeAuditTrail(
  cwd: string,
  record: AuditTrailRecord,
  reportsDir?: string,
): Promise<void> {
  const safeTimestamp = record.timestamp.replace(/:/g, '-');
  const runsDir = join(reportsDir ?? join(cwd, '.deep-health'), 'runs');
  const filePath = join(runsDir, `${safeTimestamp}.json`);

  try {
    await mkdir(runsDir, { recursive: true });
    await writeFile(filePath, JSON.stringify(record, null, 2), 'utf-8');
    logger.info(`[audit trail] Written to ${filePath}`);
  } catch (err) {
    logger.warn(`[audit trail] Failed to write audit trail to ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Read the CLI version from the package.json nearest to this module.
 * Returns 'unknown' if unavailable.
 */
export async function resolveCliVersion(): Promise<string> {
  try {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const pkg = require('../../../package.json') as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}
