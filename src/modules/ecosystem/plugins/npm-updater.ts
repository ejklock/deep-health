import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandRunner } from '@core/types/common';
import type { FixerStrategyId, ValidationCommandConfig } from '@core/types/config';
import type { UpdateResultJson, ValidationEntry } from '@core/types/update';
import type { ScanResultJson } from '@core/types/scan';
import { emptyEcosystem } from '@core/types/scan';
import { PhaseError } from '@core/errors';
import { backupFiles, restoreFiles } from '@infra/utils/git';
import { logger } from '@infra/utils/logger';
import { FIXER_MAP } from '../fixers/index';
import { runValidations } from '../utils/validation-runner';

const NPM_FILES = ['package.json', 'package-lock.json'];
// Files osv-scanner fix cannot repair but that may drift during the update flow
// (postinstall scripts, hybrid yarn+npm projects, etc). Backed up for rollback only.
const NPM_ADVISOR_FILES = ['yarn.lock'];

async function checkCurrentState(runner: CommandRunner, cwd: string): Promise<void> {
  logger.debug('Running npm outdated and npm audit (informational)...');
  await runner.run('npm outdated', { cwd });
  await runner.run('npm audit', { cwd });
}

async function revertNpmChanges(
  runner: CommandRunner,
  backups: Map<string, string>,
  cwd: string,
  preRunSnapshots?: Map<string, string>,
): Promise<void> {
  await restoreFiles(backups, cwd);
  logger.info('Running npm ci to restore dependencies after revert...');
  try {
    const revertResult = await runner.run('npm ci', { cwd, stream: true });
    if (revertResult.exitCode !== 0) {
      logger.error(
        [
          'npm ci (revert) failed!',
          `  command : ${revertResult.command}`,
          `  exit    : ${revertResult.exitCode}`,
          revertResult.stdout ? `  stdout  :\n${revertResult.stdout}` : null,
          revertResult.stderr ? `  stderr  :\n${revertResult.stderr}` : null,
        ]
          .filter(Boolean)
          .join('\n'),
      );
      // Surface to caller so the error is not silently swallowed
      throw new Error(
        `npm ci (revert) failed (exit ${revertResult.exitCode}): ${revertResult.stderr || revertResult.stdout || '(no output)'}`,
      );
    }
  } finally {
    // npm ci can mutate package-lock.json (lockfile-format migration or normalization)
    // even when it exits 0. Re-restore from the in-memory snapshot so the on-disk lockfile
    // is byte-identical to the pre-update state regardless of what npm did.
    await restoreFiles(backups, cwd);
  }

  // Dirty-tree detection: compare on-disk state after full revert against pre-run snapshots.
  // Best-effort only — warn and continue; never fail the revert.
  if (preRunSnapshots && preRunSnapshots.size > 0) {
    for (const [filename, preRunContent] of preRunSnapshots) {
      let onDiskContent: string | undefined;
      try {
        onDiskContent = await readFile(join(cwd, filename), 'utf-8') as string;
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

export async function runNpmUpdater(
  runner: CommandRunner,
  _config: unknown,
  scanResult: ScanResultJson,
  cwd: string,
  authorizeBreaking = false,
  validationCommands: ValidationCommandConfig[] = [],
  fixerStrategy: FixerStrategyId = 'osv',
  preFixBackups?: Map<string, string>,
  osvFixOutcome?: { applied: boolean; packagesUpdated: Array<{ name: string; versionFrom: string; versionTo: string }> },
  preRunSnapshots?: Map<string, string>,
): Promise<UpdateResultJson> {
  logger.info('Running npm safe updates...');

  const npmEcosystem = scanResult.ecosystems['npm'] ?? emptyEcosystem();

  const fixerFn = FIXER_MAP[fixerStrategy];

  const skippedValidations: ValidationEntry[] =
    validationCommands.length > 0
      ? validationCommands.map((vc) => ({
          name: vc.name,
          status: 'skipped' as const,
          detail: 'Dry-run — not executed',
        }))
      : [{ name: 'validation', status: 'skipped', detail: 'No validation commands configured' }];

  const base: UpdateResultJson = {
    $schema: 'osv-update-result/v1',
    agent: 'npm-safe-update',
    status: 'success',
    packages_updated: [],
    packages_skipped: [],
    packages_pending_breaking: npmEcosystem.breaking_packages,
    validations: skippedValidations,
    error: null,
  };

  if (runner.dryRun) {
    logger.info(`[DRY-RUN] Would execute fixer strategy: ${fixerStrategy}`);
    if (authorizeBreaking) logger.info('[DRY-RUN] Would install authorized breaking-change packages');
    return { ...base, validations: skippedValidations };
  }

  if (validationCommands.length === 0) {
    logger.warn(
      'No validation commands configured for npm ecosystem — changes will land without test signal',
    );
  }

  try {
    // Use caller-provided backups (e.g. taken before osv-scanner fix) when available.
    // This is required for the 'osv' strategy where the orchestrator runs osv-scanner fix
    // before invoking the updater — at that point files are already mutated, so a backup
    // taken here would capture the post-fix state rather than the pre-fix state.
    const primaryBackups = preFixBackups ?? await backupFiles(NPM_FILES, cwd);
    // Advisor files (e.g. yarn.lock) are never mutated by osv-scanner fix, so backing up
    // here — after the orchestrator's OSV pre-phase — is safe. We still snapshot them so
    // a postinstall/resolver side-effect during validation can be rolled back.
    const advisorBackups = await backupFiles(NPM_ADVISOR_FILES, cwd);
    const backups = new Map<string, string>([...primaryBackups, ...advisorBackups]);

    await checkCurrentState(runner, cwd);

    // Apply the configured fixer strategy
    const fixerResult = await fixerFn({ runner, cwd, scanResult, authorizeBreaking });

    if (fixerResult.breakingInstallError) {
      return {
        ...base,
        status: 'error',
        validations: [{ name: 'validation', status: 'fail', detail: fixerResult.breakingInstallError }],
        error: fixerResult.breakingInstallError,
      };
    }

    // Bootstrap dependencies before running validations
    if (validationCommands.length > 0) {
      logger.info('Running npm ci to ensure clean dependency state before validation...');
      const ciResult = await runner.run('npm ci', { cwd, stream: true });
      if (ciResult.exitCode !== 0) {
        const detail = [
          `npm ci failed (exit ${ciResult.exitCode})`,
          `  command : ${ciResult.command}`,
          ciResult.stdout ? `  stdout  :\n${ciResult.stdout}` : null,
          ciResult.stderr ? `  stderr  :\n${ciResult.stderr}` : null,
        ]
          .filter(Boolean)
          .join('\n');
        logger.error(`npm ci failed before validation:\n${detail}`);
        logger.error('Reverting npm changes...');
        await revertNpmChanges(runner, backups, cwd, preRunSnapshots);
        return {
          ...base,
          status: 'error',
          validations: [{
            name: 'npm ci',
            status: 'fail',
            detail,
          }],
          error: 'npm ci failed before validation — changes reverted',
        };
      }
    }

    // Run configured validation commands
    const validationResult = await runValidations({
      runner,
      cwd,
      commands: validationCommands,
      failIfAllSkipped: true,
    });

    if (!validationResult.allPassed) {
      const failedEntry = validationResult.entries.find((e) => e.status === 'fail');
      if (failedEntry) {
        logger.error(
          `Validation "${failedEntry.name}" did not pass. Detail: ${failedEntry.detail ?? '(no detail)'}`,
        );
      }

      // osv-then-audit: before a full revert, try to preserve the post-OSV state
      if (fixerStrategy === 'osv-then-audit' && fixerResult.intermediateBackup) {
        logger.warn(
          '[osv-then-audit] Validation failed after audit-fix. Reverting audit-fix changes, keeping OSV state...',
        );
        await restoreFiles(fixerResult.intermediateBackup, cwd);

        logger.info('[osv-then-audit] Running npm ci after partial revert...');
        const reCiResult = await runner.run('npm ci', { cwd, stream: true });

        if (reCiResult.exitCode === 0) {
          // npm ci can mutate the lockfile even when it exits 0 (format normalization).
          // Re-restore from the snapshot so disk is byte-identical to the pre-audit-fix state
          // before running re-validation, mirroring the double-restore in revertNpmChanges.
          await restoreFiles(fixerResult.intermediateBackup, cwd);
          const reValidation = await runValidations({ runner, cwd, commands: validationCommands });
          if (reValidation.allPassed) {
            logger.info(
              '[osv-then-audit] Post-OSV state validates successfully. Audit-fix changes reverted; OSV changes preserved.',
            );
            const osvOnly = osvFixOutcome?.packagesUpdated.map((p) => `${p.name}@${p.versionTo}`) ?? [];
            return {
              ...base,
              packages_updated: osvOnly,
              validations: reValidation.entries,
            };
          }
          logger.warn(
            '[osv-then-audit] Post-OSV state also failed validation. Performing full revert...',
          );
        } else {
          logger.warn(
            '[osv-then-audit] npm ci failed after partial revert. Performing full revert...',
          );
        }
      }

      logger.error('Validation failed — reverting npm changes...');
      await revertNpmChanges(runner, backups, cwd, preRunSnapshots);
      return {
        ...base,
        status: 'error',
        validations: validationResult.entries,
        error: 'Validation failed after npm update — changes reverted',
      };
    }

    // When OSV strategy ran, use the applier's evidence; fall back to fixer result
    const osvPackages =
      (fixerStrategy === 'osv' || fixerStrategy === 'osv-then-audit') && osvFixOutcome
        ? osvFixOutcome.packagesUpdated.map((p) => `${p.name}@${p.versionTo}`)
        : [];

    // Deduplicate osv-then-audit: audit overwrites OSV for the same package (last-writer-wins)
    const merged = new Map<string, string>();
    for (const spec of [...osvPackages, ...fixerResult.packagesUpdated]) {
      const at = spec.lastIndexOf('@');
      const name = at > 0 ? spec.slice(0, at) : spec;
      merged.set(name, spec);
    }

    const actualPackagesUpdated =
      fixerStrategy === 'osv-then-audit'
        ? [...merged.values()]
        : fixerStrategy === 'osv' && osvFixOutcome
          ? osvPackages
          : fixerResult.packagesUpdated;

    return {
      ...base,
      packages_updated: actualPackagesUpdated,
      validations: validationResult.entries,
    };
  } catch (err) {
    throw new PhaseError(
      `npm updater phase failed: ${err instanceof Error ? err.message : String(err)}`,
      'npm-updater',
      err,
    );
  }
}
