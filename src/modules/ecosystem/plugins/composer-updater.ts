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
  return runner.run(`composer update ${pkgList} --with-all-dependencies --no-interaction`, { cwd, stream: true });
}

async function revertComposerChanges(
  runner: CommandRunner,
  backups: Map<string, string>,
  cwd: string,
): Promise<void> {
  await restoreFiles(backups, cwd);
  await runner.run('composer install --no-interaction', { cwd });
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
      return {
        ...base,
        status: 'error',
        validations: [{ name: 'validation', status: 'skipped', detail: 'composer update failed — validations not run' }],
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
