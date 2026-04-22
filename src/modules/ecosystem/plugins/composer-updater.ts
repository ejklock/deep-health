import type { CommandRunner, CommandResult } from '@core/types/common';
import type { ValidationCommandConfig } from '@core/types/config';
import type { UpdateResultJson, ValidationEntry } from '@core/types/update';
import type { ScanResultJson } from '@core/types/scan';
import { emptyEcosystem } from '@core/types/scan';
import { PhaseError } from '@core/errors';
import { backupFiles, restoreFiles } from '@infra/utils/git';
import { logger } from '@infra/utils/logger';
import { runValidations } from '../utils/validation-runner';

const COMPOSER_FILES = ['composer.json', 'composer.lock'];

function extractPackageNames(packageRefs: string[]): string[] {
  return packageRefs.map((ref) => {
    const atIndex = ref.lastIndexOf('@');
    return atIndex > 0 ? ref.slice(0, atIndex) : ref;
  });
}

// Shared composer flags for all write-path commands.
// --no-interaction : no prompts (CI context)
// --no-scripts     : skip post-install-cmd, post-autoload-dump, post-update-cmd, etc.
//                    These framework hooks (e.g. Laravel's `artisan package:discover`)
//                    bootstrap app state that depends on runtime services (db, cache, queue)
//                    — not available inside a dependency-upgrade flow. Running them here
//                    turns dep failures into app-bootstrap failures and makes rollback
//                    noisier. The user's explicit validationCommands can still invoke them
//                    if needed.
const COMPOSER_AUTOMATION_FLAGS = '--no-interaction --no-scripts';

async function checkCurrentState(runner: CommandRunner, cwd: string): Promise<void> {
  logger.debug('Running composer outdated --direct (informational)...');
  await runner.run('composer outdated --direct', { cwd });
}

async function applyComposerUpdate(
  runner: CommandRunner,
  packageNames: string[],
  cwd: string,
): Promise<CommandResult> {
  const pkgList = packageNames.join(' ');
  logger.info(`Updating packages: ${pkgList}`);
  return runner.run(
    `composer update ${pkgList} --with-all-dependencies ${COMPOSER_AUTOMATION_FLAGS}`,
    { cwd, stream: true },
  );
}

async function revertComposerChanges(
  runner: CommandRunner,
  backups: Map<string, string>,
  cwd: string,
): Promise<void> {
  await restoreFiles(backups, cwd);
  try {
    await runner.run(`composer install ${COMPOSER_AUTOMATION_FLAGS}`, { cwd });
  } finally {
    // composer install rewrites composer.lock on any drift; re-restore from the
    // in-memory snapshot so the on-disk lockfile is byte-identical to pre-update.
    await restoreFiles(backups, cwd);
  }
}

export async function runComposerUpdater(
  runner: CommandRunner,
  _config: unknown,
  scanResult: ScanResultJson,
  cwd: string,
  authorizeBreaking = false,
  validationCommands: ValidationCommandConfig[] = [],
): Promise<UpdateResultJson> {
  logger.info('Running Composer safe updates...');

  const composerEcosystem = scanResult.ecosystems['composer'] ?? emptyEcosystem();

  // Build skipped validation entries for early-return paths
  const skippedEntries: ValidationEntry[] =
    validationCommands.length > 0
      ? validationCommands.map((vc) => ({
          name: vc.name,
          status: 'skipped' as const,
          detail: 'No validation commands configured — skipped',
        }))
      : [{ name: 'validation', status: 'skipped', detail: 'No validation commands configured' }];

  const base: UpdateResultJson = {
    $schema: 'osv-update-result/v1',
    agent: 'composer-safe-update',
    status: 'success',
    packages_updated: [],
    packages_skipped: [],
    packages_pending_breaking: composerEcosystem.breaking_packages,
    validations: skippedEntries,
    error: null,
  };

  const autoSafePackageNames = extractPackageNames(composerEcosystem.auto_safe_packages);
  const breakingPackageNames = authorizeBreaking
    ? extractPackageNames(composerEcosystem.breaking_packages)
    : [];
  const packageNamesToUpdate = [...new Set([...autoSafePackageNames, ...breakingPackageNames])];

  if (packageNamesToUpdate.length === 0) {
    return { ...base, validations: [{ name: 'validation', status: 'skipped', detail: 'No packages to update' }] };
  }

  if (runner.dryRun) {
    logger.info(`[DRY-RUN] Would execute: composer update ${packageNamesToUpdate.join(' ')} --no-interaction`);
    if (validationCommands.length > 0) {
      for (const vc of validationCommands) {
        logger.info(`[DRY-RUN] Would execute: ${vc.command}`);
      }
    }
    const dryRunEntries: ValidationEntry[] =
      validationCommands.length > 0
        ? validationCommands.map((vc) => ({
            name: vc.name,
            status: 'skipped' as const,
            detail: 'Dry-run — not executed',
          }))
        : [{ name: 'validation', status: 'skipped', detail: 'No validation commands configured — skipped' }];
    return {
      ...base,
      packages_updated: composerEcosystem.auto_safe_packages,
      validations: dryRunEntries,
    };
  }

  try {
    const backups = await backupFiles(COMPOSER_FILES, cwd);

    await checkCurrentState(runner, cwd);

    const updateResult = await applyComposerUpdate(runner, packageNamesToUpdate, cwd);
    if (updateResult.exitCode !== 0) {
      // composer update may fail AFTER writing composer.lock (post-autoload-dump
      // scripts, e.g. Laravel's `artisan package:discover`, run at the end and can
      // return non-zero even though the lockfile is already on disk). Revert so
      // the working tree is left byte-identical to the pre-update state.
      logger.error('composer update failed — reverting Composer changes...');
      await revertComposerChanges(runner, backups, cwd);
      return {
        ...base,
        status: 'error',
        validations: [{ name: 'validation', status: 'skipped', detail: 'composer update failed — changes reverted' }],
        error: `composer update failed: ${updateResult.stderr}`,
      };
    }

    // Run configured validation commands
    const validationResult = await runValidations({
      runner,
      cwd,
      commands: validationCommands,
    });

    if (!validationResult.allPassed) {
      logger.error('Validations failed — reverting Composer updates...');
      await revertComposerChanges(runner, backups, cwd);
      return {
        ...base,
        status: 'error',
        validations: validationResult.entries,
        error: 'Validations failed after composer update — changes reverted',
      };
    }

    return {
      ...base,
      packages_updated: composerEcosystem.auto_safe_packages,
      validations: validationResult.entries,
    };
  } catch (err) {
    throw new PhaseError(
      `Composer updater phase failed: ${err instanceof Error ? err.message : String(err)}`,
      'composer-updater',
      err,
    );
  }
}
