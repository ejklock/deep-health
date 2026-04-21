import type { CommandRunner } from '@core/types/common';
import type { ScanResultJson } from '@core/types/scan';
import type { FixerStrategyId } from '@core/types/config';
import { applyNpmAuditFix } from './npm-audit-fixer';
import { applyOsvNoOp } from './osv-fixer';

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
 * - 'osv': no-op inside the updater — the real OSV fix is coordinated by the orchestrator.
 *   The orchestrator runs `osv-scanner fix` before calling the updater; authorized breaking
 *   changes are also applied at orchestration level with the npm runner.
 * - 'npm-audit': runs `npm audit fix` via the npm runner.
 */
export const FIXER_MAP: Record<FixerStrategyId, FixerFn> = {
  'osv': applyOsvNoOp,
  'npm-audit': applyNpmAuditFix,
};

export { applyNpmAuditFix } from './npm-audit-fixer';
export { applyOsvNoOp } from './osv-fixer';
