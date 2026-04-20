import type { CommandRunner } from '@core/types/common';
import type { ScanResultJson } from '@core/types/scan';
import type { FixerStrategyId } from '@core/types/config';
import { applyNpmAuditFix } from './npm-audit-fixer';

export interface FixerCallOptions {
  runner: CommandRunner;
  cwd: string;
  scanResult: ScanResultJson;
  authorizeBreaking: boolean;
}

export interface FixerCallResult {
  breakingInstallError: string | null;
  packagesUpdated: string[];
}

export type FixerFn = (opts: FixerCallOptions) => Promise<FixerCallResult>;

/**
 * Typed dispatch map from FixerStrategyId to the corresponding fixer function.
 * All fixer functions share the same FixerCallOptions/FixerCallResult signature
 * for uniform call-site dispatch in updaters.
 *
 * Note: 'osv' strategy is intentionally NOT in this map.
 * The osv-scanner fix step is coordinated explicitly by the orchestrator
 * using a dedicated OSV CommandRunner before the npm updater runs.
 */
export const FIXER_MAP: Record<Exclude<FixerStrategyId, 'osv'>, FixerFn> = {
  'npm-audit': applyNpmAuditFix,
};

export { applyNpmAuditFix } from './npm-audit-fixer';
