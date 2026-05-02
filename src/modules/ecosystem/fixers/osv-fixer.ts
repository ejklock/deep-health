import { logger } from '@infra/utils/logger';
import type { FixerCallOptions, FixerCallResult } from './index';

/**
 * OSV fixer no-op: when strategy='osv', the real OSV fix is coordinated by the orchestrator
 * before the updater is called (via applyOsvFixViaStaging).  The packages_updated list is
 * populated from opts.osvFixOutcome (the staging-apply result) passed down via FixerCallOptions.
 *
 * Authorized breaking changes are also applied at orchestration level using the npm runner —
 * never inside the updater.
 *
 * When opts.osvFixOutcome is present, returns the packages it applied. When absent (e.g. dry-run,
 * or strategy was demoted before osv-scanner ran), returns an empty packagesUpdated list.
 */
export async function applyOsvNoOp(opts: FixerCallOptions): Promise<FixerCallResult> {
  const packagesUpdated: string[] = opts.osvFixOutcome
    ? opts.osvFixOutcome.packagesUpdated.map((p) => `${p.name}@${p.versionTo}`)
    : [];

  logger.debug('[OSV fixer] OSV strategy: remediation is coordinated by the orchestrator (no-op in updater)');

  // No breaking install error — breaking changes are handled at orchestration level
  return { breakingInstallError: null, packagesUpdated };
}

