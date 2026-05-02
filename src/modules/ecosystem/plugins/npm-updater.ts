import type { CommandRunner } from '@core/types/common';
import type { FixerStrategyId, ValidationCommandConfig } from '@core/types/config';
import type { UpdateResultJson, ValidationEntry } from '@core/types/update';
import type { ScanResultJson } from '@core/types/scan';
import { emptyEcosystem } from '@core/types/scan';
import { PhaseError } from '@core/errors';
import { backupFiles } from '@infra/utils/fs-backup';
import { logger } from '@infra/utils/logger';
import { beginUpdaterTransaction } from '../utils/updater-transaction';
import { FIXER_MAP } from '../fixers/index';
import type { OsvFixOutcome } from '../fixers/index';
import { runValidations } from '../utils/validation-runner';

const NPM_FILES = ['package.json', 'package-lock.json'];
// Files osv-scanner fix cannot repair but that may drift during the update flow
// (postinstall scripts, hybrid yarn+npm projects, etc). Backed up for rollback only.
const NPM_ADVISOR_FILES = ['yarn.lock'];

async function checkCurrentState(runner: CommandRunner, cwd: string): Promise<void> {
  logger.debug('Running npm outdated and npm audit (informational)...');
  await runner.runArgs('npm', ['outdated'], { cwd });
  await runner.runArgs('npm', ['audit'], { cwd });
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
  osvFixOutcome?: OsvFixOutcome,
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
    logger.tagged('npm', 'DRY-RUN', `Would execute fixer strategy: ${fixerStrategy}`);
    if (authorizeBreaking) logger.tagged('npm', 'DRY-RUN', 'Would install authorized breaking-change packages');
    return { ...base, validations: skippedValidations };
  }

  if (validationCommands.length === 0) {
    logger.warn(
      'No validation commands configured for npm ecosystem — changes will land without test signal',
    );
  }

  try {
    // Advisor files (e.g. yarn.lock) are never mutated by osv-scanner fix, so backing up
    // here — after the orchestrator's OSV pre-phase — is safe. We still snapshot them so
    // a postinstall/resolver side-effect during validation can be rolled back.
    const advisorBackups = await backupFiles(NPM_ADVISOR_FILES, cwd);
    // Use caller-provided backups (e.g. taken before osv-scanner fix) when available.
    // This is required for the 'osv' strategy where the orchestrator runs osv-scanner fix
    // before invoking the updater — at that point files are already mutated, so a backup
    // taken here would capture the post-fix state rather than the pre-fix state.
    const primaryBackups = preFixBackups ?? await backupFiles(NPM_FILES, cwd);
    const tx = await beginUpdaterTransaction({
      files: NPM_FILES, // unused when preExistingBackups provided, but required by type
      base,
      cwd,
      runner,
      bootstrapSpec: { binary: 'npm', args: ['ci'], label: 'npm ci (revert)' },
      preExistingBackups: new Map([...primaryBackups, ...advisorBackups]),
      preRunSnapshots,
    });

    await checkCurrentState(runner, cwd);

    // Apply the configured fixer strategy, passing osvFixOutcome so the fixer can
    // return the correct packages list without the updater needing to know the strategy.
    const fixerResult = await fixerFn({ runner, cwd, scanResult, authorizeBreaking, osvFixOutcome });

    // When fixer reports a breaking install error, no files were mutated — no revert needed
    if (fixerResult.breakingInstallError) {
      return tx.abortWithError({
        error: fixerResult.breakingInstallError,
        validations: [{ name: 'validation', status: 'fail', detail: fixerResult.breakingInstallError }],
      });
    }

    // Bootstrap dependencies before running validations
    if (validationCommands.length > 0) {
      logger.info('Running npm ci to ensure clean dependency state before validation...');
      const ciResult = await runner.runArgs('npm', ['ci'], { cwd, stream: true });
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
        return tx.abortWithError({
          error: 'npm ci failed before validation — changes reverted',
          validations: [{ name: 'npm ci', status: 'fail', detail }],
        });
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

      // Strategy-agnostic partial revert: when the fixer provides a partialRevert callable,
      // attempt to restore the intermediate state and re-validate before falling back to a
      // full pre-fix revert. Throws PhaseError when the partial-revert bootstrap fails.
      if (fixerResult.partialRevert) {
        try {
          await fixerResult.partialRevert(runner, cwd);
          logger.tagged('npm', 'partial-revert', 'Partial revert succeeded; re-validating...');
          const reValidation = await runValidations({ runner, cwd, commands: validationCommands });
          if (reValidation.allPassed) {
            logger.tagged('npm', 'partial-revert', 'Post-intermediate state validates successfully. Partial revert preserved.');
            const osvOnly = osvFixOutcome?.packagesUpdated.map((p) => `${p.name}@${p.versionTo}`) ?? [];
            return tx.success({
              packages_updated: osvOnly,
              validations: reValidation.entries,
            });
          }
          logger.tagged('npm', 'partial-revert', 'Post-intermediate state also failed validation. Performing full revert...', 'warn');
        } catch (err) {
          throw new PhaseError(
            `npm updater partial-revert bootstrap failed: ${err instanceof Error ? err.message : String(err)}`,
            'partial-revert-bootstrap',
            err,
          );
        }
      }

      logger.error('Validation failed — reverting npm changes...');
      return tx.abortWithError({
        error: 'Validation failed after npm update — changes reverted',
        validations: validationResult.entries,
      });
    }

    return tx.success({
      packages_updated: fixerResult.packagesUpdated,
      validations: validationResult.entries,
    });
  } catch (err) {
    throw new PhaseError(
      `npm updater phase failed: ${err instanceof Error ? err.message : String(err)}`,
      'npm-updater',
      err,
    );
  }
}
