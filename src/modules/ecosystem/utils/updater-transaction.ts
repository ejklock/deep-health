import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandRunner } from '@core/types/common';
import type { UpdateResultJson, ValidationEntry } from '@core/types/update';
import { backupFiles, restoreFiles } from '@infra/utils/fs-backup';
import { logger } from '@infra/utils/logger';

/**
 * Describes how to reinstall dependencies during a revert.
 * Binary + args are static per updater and passed directly to runner.runArgs
 * (shell: false) — no variable data, no shell injection risk.
 *
 * Covers revert bootstrap only, NOT pre-flight env-checks.
 */
export interface BootstrapSpec {
  binary: string;
  args: readonly string[];
  label: string;
}

export interface BeginUpdaterTransactionOptions {
  /** Files to back up at transaction start (skipped if preExistingBackups provided). */
  files: readonly string[];
  /** Pre-built success-shaped UpdateResultJson (with skippedEntries already populated). */
  base: UpdateResultJson;
  cwd: string;
  /** CommandRunner to use for the revert bootstrap and any revert I/O. */
  runner: CommandRunner;
  /** Describes how to reinstall dependencies during revert (e.g. `npm ci`, `composer install …`). */
  bootstrapSpec: BootstrapSpec;
  /**
   * Caller-provided backups (e.g. from osv-scanner staging-fix pre-phase).
   * When present, the transaction adopts them and does NOT take its own backup.
   */
  preExistingBackups?: Map<string, string>;
  /**
   * Snapshot of file contents taken before any mutation. Used for a warn-only
   * dirty-tree check after the revert completes. When absent the check is skipped.
   */
  preRunSnapshots?: Map<string, string>;
}

export interface UpdaterTransaction {
  /** Backups managed by this transaction (read-only from caller's POV). */
  readonly backups: Map<string, string>;

  /** Build a success-shaped result. Does NOT touch files. */
  success(opts: { packages_updated: string[]; validations: ValidationEntry[] }): UpdateResultJson;

  /**
   * Run the revert protocol and build an error-shaped result.
   *
   * Protocol: restoreFiles → bootstrapSpec (stream:true) → restoreFiles again (in finally) →
   *           warn-only dirty-tree check vs preRunSnapshots.
   *
   * Throws when the bootstrap exits non-zero — callers' outer try/catch wraps
   * propagated errors as PhaseError, preserving the existing error-surfacing contract
   * at the orchestration boundary.
   */
  abortWithError(opts: {
    error: string;
    validations: ValidationEntry[];
  }): Promise<UpdateResultJson>;
}

/**
 * Run the full revert protocol.
 *
 * restore → bootstrap (stream:true) → restore again (in finally) → warn-only dirty-tree check
 *
 * Throws when the bootstrap exits non-zero. The second restore runs inside a `try/finally`
 * so it fires even when the bootstrap command throws (e.g. runner disconnects mid-stream).
 *
 * Exported so fixers can build `partialRevert` callables that share the same protocol
 * (e.g. osv-then-audit restores to the intermediate post-OSV state before re-bootstrapping).
 */
export async function revertWithBootstrap(
  runner: CommandRunner,
  bootstrapSpec: BootstrapSpec,
  backups: Map<string, string>,
  cwd: string,
  preRunSnapshots?: Map<string, string>,
): Promise<void> {
  // ── Step 1: restore before bootstrap ──
  await restoreFiles(backups, cwd);

  // ── Step 2: run bootstrap; re-restore in finally ──
  logger.info(`Running ${bootstrapSpec.label} to restore dependencies after revert...`);
  try {
    const revertResult = await runner.runArgs(bootstrapSpec.binary, [...bootstrapSpec.args], {
      cwd,
      stream: true,
    });
    if (revertResult.exitCode !== 0) {
      logger.error(
        [
          `${bootstrapSpec.label} failed!`,
          `  command : ${revertResult.command}`,
          `  exit    : ${revertResult.exitCode}`,
          revertResult.stdout ? `  stdout  :\n${revertResult.stdout}` : null,
          revertResult.stderr ? `  stderr  :\n${revertResult.stderr}` : null,
        ]
          .filter(Boolean)
          .join('\n'),
      );
      throw new Error(
        `${bootstrapSpec.label} failed (exit ${revertResult.exitCode}): ${revertResult.stderr || revertResult.stdout || '(no output)'}`,
      );
    }
  } finally {
    // The bootstrap can mutate the lockfile even on exit 0 (format normalization, etc.).
    // Re-restore from the in-memory snapshot so the on-disk files are byte-identical
    // to the pre-update state regardless of what the bootstrap did.
    await restoreFiles(backups, cwd);
  }

  // ── Step 3: warn-only dirty-tree check ──
  // Best-effort only — warn and continue; never fail the revert.
  if (preRunSnapshots && preRunSnapshots.size > 0) {
    for (const [filename, preRunContent] of preRunSnapshots) {
      let onDiskContent: string | undefined;
      try {
        onDiskContent = (await readFile(join(cwd, filename), 'utf-8')) as string;
      } catch {
        // File not readable — skip comparison for this file
        continue;
      }
      if (onDiskContent !== preRunContent) {
        logger.warn(
          `[revert] ${filename} on disk after revert differs from pre-run state — external changes during the run may have been lost`,
        );
      }
    }
  }
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
    async abortWithError({ error, validations }) {
      await revertWithBootstrap(
        opts.runner,
        opts.bootstrapSpec,
        backups,
        opts.cwd,
        opts.preRunSnapshots,
      );
      return { ...opts.base, status: 'error', validations, error };
    },
  };
}
