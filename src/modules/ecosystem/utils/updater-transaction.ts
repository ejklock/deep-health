import { backupFiles } from '@infra/utils/git';
import type { UpdateResultJson, ValidationEntry } from '@core/types/update';

export interface BeginUpdaterTransactionOptions {
  /** Files to back up at transaction start (skipped if preExistingBackups provided). */
  files: readonly string[];
  /** Pre-built success-shaped UpdateResultJson (with skippedEntries already populated). */
  base: UpdateResultJson;
  cwd: string;
  /**
   * Caller-provided backups (e.g. from osv-scanner staging-fix pre-phase).
   * When present, the transaction adopts them and does NOT take its own backup.
   */
  preExistingBackups?: Map<string, string>;
}

export interface UpdaterTransaction {
  /** Backups managed by this transaction (read-only from caller's POV). */
  readonly backups: Map<string, string>;

  /** Build a success-shaped result. Does NOT touch files. */
  success(opts: { packages_updated: string[]; validations: ValidationEntry[] }): UpdateResultJson;

  /**
   * Run revert and build an error-shaped result.
   *
   * - `revert` is invoked exactly once. Errors thrown by `revert` propagate to
   *   the caller — this is intentional. The decision to swallow vs propagate
   *   belongs to the ecosystem-specific revert helper (e.g. pip/composer log
   *   and continue; npm throws on failed `npm ci` to surface ambiguous on-disk
   *   state). The outer try/catch in each updater wraps propagated errors as
   *   PhaseError, preserving the existing error-surfacing behavior.
   * - When `revert` succeeds, the returned result has status='error', the
   *   provided error string, and the provided validation entries.
   */
  abortWithError(opts: {
    error: string;
    validations: ValidationEntry[];
    revert: () => Promise<void>;
  }): Promise<UpdateResultJson>;
}

export async function beginUpdaterTransaction(
  opts: BeginUpdaterTransactionOptions,
): Promise<UpdaterTransaction> {
  const backups =
    opts.preExistingBackups ??
    (await backupFiles(Array.from(opts.files), opts.cwd));

  return {
    backups,
    success({ packages_updated, validations }) {
      return { ...opts.base, packages_updated, validations };
    },
    async abortWithError({ error, validations, revert }) {
      await revert();
      return { ...opts.base, status: 'error', validations, error };
    },
  };
}
