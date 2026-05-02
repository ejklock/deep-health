import type { CommandRunner } from '@core/types/common';
import type { ScanResultJson } from '@core/types/scan';
import type { FixerStrategyId } from '@core/types/config';
import { applyNpmAuditFix } from './npm-audit-fixer';
import { applyOsvNoOp } from './osv-fixer';
import { applyOsvThenAuditFix } from './osv-then-audit-fixer';

/**
 * Evidence returned by the orchestrator's OSV staging-apply phase.
 * Single source of truth — imported by EcosystemUpdaterContext and any fixer that
 * needs to merge or surface OSV-sourced package evidence.
 */
export interface OsvFixOutcome {
  applied: boolean;
  packagesUpdated: Array<{ name: string; versionFrom: string; versionTo: string }>;
}

export interface FixerCallOptions {
  runner: CommandRunner;
  cwd: string;
  scanResult: ScanResultJson;
  authorizeBreaking: boolean;
  /**
   * When present, contains the evidence of what OSV staging-apply wrote to disk.
   * Fixers use this to return the real packages list instead of an empty array.
   * - `osv-fixer`: returns packagesUpdated from this field.
   * - `osv-then-audit-fixer`: merges this with its own audit-verified list (last-writer-wins).
   */
  osvFixOutcome?: OsvFixOutcome;
}

export interface FixerCallResult {
  breakingInstallError: string | null;
  packagesUpdated: string[];
  /**
   * For osv-then-audit strategy: post-OSV lockfile snapshot taken before npm audit fix ran.
   * Keys are file paths relative to cwd; values are file contents.
   * Retained for test introspection and backward compatibility.
   */
  intermediateBackup?: Map<string, string>;
  /**
   * When present, called by the updater on validation failure before
   * falling back to full revert. The callable restores to the
   * intermediate (post-OSV) state and re-bootstraps, giving the caller
   * a chance to re-validate before committing to a full revert.
   *
   * Throws if the partial-revert bootstrap fails — the updater must
   * propagate that as a PhaseError.
   */
  partialRevert?: (runner: CommandRunner, cwd: string) => Promise<void>;
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
