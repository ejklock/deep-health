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

async function checkCurrentState(runner: CommandRunner, cwd: string): Promise<void> {
  logger.debug('Running npm outdated and npm audit (informational)...');
  await runner.run('npm outdated', { cwd });
  await runner.run('npm audit', { cwd });
}

async function revertNpmChanges(
  runner: CommandRunner,
  backups: Map<string, string>,
  cwd: string,
): Promise<void> {
  await restoreFiles(backups, cwd);
  logger.info('Running npm install to restore dependencies after revert...');
  const revertResult = await runner.run('npm install', { cwd, stream: true });
  if (revertResult.exitCode !== 0) {
    logger.error(
      [
        'npm install (revert) failed!',
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
      `npm install (revert) failed (exit ${revertResult.exitCode}): ${revertResult.stderr || revertResult.stdout || '(no output)'}`,
    );
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

  try {
    // Use caller-provided backups (e.g. taken before osv-scanner fix) when available.
    // This is required for the 'osv' strategy where the orchestrator runs osv-scanner fix
    // before invoking the updater — at that point files are already mutated, so a backup
    // taken here would capture the post-fix state rather than the pre-fix state.
    const backups = preFixBackups ?? await backupFiles(NPM_FILES, cwd);

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
        await revertNpmChanges(runner, backups, cwd);
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
    });

    if (!validationResult.allPassed) {
      const failedEntry = validationResult.entries.find((e) => e.status === 'fail');
      if (failedEntry) {
        logger.error(
          `Validation "${failedEntry.name}" did not pass. Detail: ${failedEntry.detail ?? '(no detail)'}`,
        );
      }
      logger.error('Validation failed — reverting npm changes...');
      await revertNpmChanges(runner, backups, cwd);
      return {
        ...base,
        status: 'error',
        validations: validationResult.entries,
        error: 'Validation failed after npm update — changes reverted',
      };
    }

    return {
      ...base,
      packages_updated: fixerResult.packagesUpdated,
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
