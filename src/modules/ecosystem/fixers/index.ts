import type { CommandRunner } from '@core/types/common';
import type { ScanResultJson } from '@core/types/scan';
import type { FixerStrategyId } from '@core/types/config';
import { applyNpmAuditFix } from './npm-audit-fixer';
import { applyOsvNoOp } from './osv-fixer';
import { applyOsvThenAuditFix } from './osv-then-audit-fixer';

export interface FixerCallOptions {
  runner: CommandRunner;
  cwd: string;
  scanResult: ScanResultJson;
  authorizeBreaking: boolean;
}

export interface FixerCallResult {
  breakingInstallError: string | null;
  packagesUpdated: string[];
  /**
   * For osv-then-audit strategy: post-OSV lockfile snapshot taken before npm audit fix ran.
   * Keys are file paths relative to cwd; values are file contents.
   * When present and validation fails, the updater attempts a partial revert to this state
   * before falling back to a full pre-fix revert.
   */
  intermediateBackup?: Map<string, string>;
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
 * - 'osv-then-audit': runs `npm audit fix` on top of the OSV-fixed state; supports partial
 *   rollback to the OSV-only state if validation fails after the audit-fix step.
 */
export const FIXER_MAP: Record<FixerStrategyId, FixerFn> = {
  'osv': applyOsvNoOp,
  'npm-audit': applyNpmAuditFix,
  'osv-then-audit': applyOsvThenAuditFix,
};

export { applyNpmAuditFix } from './npm-audit-fixer';
export { applyOsvNoOp } from './osv-fixer';
export { applyOsvThenAuditFix } from './osv-then-audit-fixer';
