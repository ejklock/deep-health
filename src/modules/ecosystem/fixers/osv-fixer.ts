import { logger } from '@infra/utils/logger';
import type { FixerCallOptions, FixerCallResult } from './index';

/**
 * OSV fixer no-op: when strategy='osv', the real OSV fix is coordinated by the orchestrator
 * before the updater is called (via applyOsvFixViaStaging).  The packages_updated list is
 * populated from the staging-apply result (OsvFixApplyResult.packagesUpdated) by the updater,
 * not from auto_safe_packages here.
 *
 * Authorized breaking changes are also applied at orchestration level using the npm runner —
 * never inside the updater.
 *
 * This function returns an empty packagesUpdated list; the actual evidence comes from the
 * orchestrator's osvFixOutcome passed down to runNpmUpdater.
 */
export async function applyOsvNoOp(_opts: FixerCallOptions): Promise<FixerCallResult> {
  const packagesUpdated: string[] = [];

  logger.debug('[OSV fixer] OSV strategy: remediation is coordinated by the orchestrator (no-op in updater)');

  // No breaking install error — breaking changes are handled at orchestration level
  return { breakingInstallError: null, packagesUpdated };
}

