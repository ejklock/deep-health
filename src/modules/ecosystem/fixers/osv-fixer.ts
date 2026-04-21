import type { ScanResultJson } from '@core/types/scan';
import { emptyEcosystem } from '@core/types/scan';
import { logger } from '@infra/utils/logger';
import type { FixerCallOptions, FixerCallResult } from './index';

/** osv-scanner in-place fix command for npm lockfile */
const OSV_FIX_NPM = 'osv-scanner fix --strategy=in-place -L package-lock.json';

/**
 * OSV fixer no-op: when strategy='osv', the real OSV fix is coordinated by the orchestrator
 * before the updater is called.  Authorized breaking changes are also applied at orchestration
 * level using the npm runner — never inside the updater.
 *
 * This function simply returns the auto_safe_packages list from the scan result so the
 * update result correctly reflects which packages were remediated by the orchestrator's OSV step.
 */
export async function applyOsvNoOp(opts: FixerCallOptions): Promise<FixerCallResult> {
  const { scanResult } = opts;
  const npmEcosystem = scanResult.ecosystems['npm'] ?? emptyEcosystem();
  const packagesUpdated = npmEcosystem.auto_safe_packages;

  logger.debug('[OSV fixer] OSV strategy: remediation is coordinated by the orchestrator (no-op in updater)');

  // No breaking install error — breaking changes are handled at orchestration level
  return { breakingInstallError: null, packagesUpdated };
}

export { OSV_FIX_NPM };

