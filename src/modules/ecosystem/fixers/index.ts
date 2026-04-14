import type { CommandRunner } from '@core/types/common';
import type { ScanResultJson } from '@core/types/scan';
import type { FixerStrategyId } from '@core/types/config';
import { applyOsvFix } from './osv-fixer';
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
 */
export const FIXER_MAP: Record<FixerStrategyId, FixerFn> = {
  osv: applyOsvFix,
  'npm-audit': applyNpmAuditFix,
};

export { applyOsvFix } from './osv-fixer';
export { applyNpmAuditFix } from './npm-audit-fixer';
