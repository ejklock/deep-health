import type { CommandRunner, CommandResult } from '@core/types/common';
import type { ProjectConfig } from '@core/types/config';
import type { UpdateResultJson, ValidationEntry } from '@core/types/update';
import type { ScanResultJson } from '@core/types/scan';
import { emptyEcosystem } from '@core/types/scan';
import { PhaseError } from '@core/errors';
import { backupFiles, restoreFiles } from '@infra/utils/git';
import { logger } from '@infra/utils/logger';

const COMPOSER_FILES = ['composer.json', 'composer.lock'];

/** osv-scanner post-update verification scan for composer lockfile */
const OSV_SCAN_COMPOSER = 'osv-scanner --lockfile composer.lock --format json';

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

async function runTestSuite(
  runner: CommandRunner,
  testCommand: string,
  cwd: string,
): Promise<CommandResult> {
  logger.info(`Running tests: ${testCommand}`);
  return runner.run(testCommand, { cwd, stream: true });
}

async function revertComposerChanges(
  runner: CommandRunner,
  backups: Map<string, string>,
  cwd: string,
): Promise<void> {
  await restoreFiles(backups, cwd);
  await runner.run('composer install --no-interaction', { cwd });
}

async function verifyResidualVulnerabilities(runner: CommandRunner, cwd: string): Promise<void> {
  logger.info(`Running post-update OSV verification: ${OSV_SCAN_COMPOSER}`);
  await runner.run(OSV_SCAN_COMPOSER, { cwd });
}

export async function runComposerUpdater(
  runner: CommandRunner,
  config: ProjectConfig,
  scanResult: ScanResultJson,
  cwd: string,
  authorizeBreaking = false,
): Promise<UpdateResultJson> {
  logger.info('Running Composer safe updates...');

  const composerEcosystem = scanResult.ecosystems['composer'] ?? emptyEcosystem();

  const base: UpdateResultJson = {
    $schema: 'osv-update-result/v1',
    agent: 'composer-safe-update',
    status: 'success',
    packages_updated: [],
    packages_skipped: [],
    packages_pending_breaking: composerEcosystem.breaking_packages,
    validations: [{ name: 'tests', status: 'skipped', detail: 'No test_command configured — skipped' }],
    error: null,
  };

  const autoSafePackageNames = extractPackageNames(composerEcosystem.auto_safe_packages);
  const breakingPackageNames = authorizeBreaking
    ? extractPackageNames(composerEcosystem.breaking_packages)
    : [];
  const packageNamesToUpdate = [...new Set([...autoSafePackageNames, ...breakingPackageNames])];

  if (packageNamesToUpdate.length === 0) {
    return { ...base, validations: [{ name: 'tests', status: 'skipped', detail: 'No packages to update' }] };
  }

  if (runner.dryRun) {
    logger.info(`[DRY-RUN] Would execute: composer update ${packageNamesToUpdate.join(' ')} --no-interaction`);
    if (config.runtime.test_command) {
      logger.info(`[DRY-RUN] Would execute: ${config.runtime.test_command}`);
    }
    logger.info(`[DRY-RUN] Would execute: ${OSV_SCAN_COMPOSER}`);
    return {
      ...base,
      packages_updated: composerEcosystem.auto_safe_packages,
      validations: [
        config.runtime.test_command
          ? { name: 'tests', status: 'skipped', detail: 'Dry-run — not executed' }
          : { name: 'tests', status: 'skipped', detail: 'No test_command configured — skipped' },
      ],
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
        validations: [{ name: 'tests', status: 'skipped', detail: 'composer update failed — tests not run' }],
        error: `composer update failed: ${updateResult.stderr}`,
      };
    }

    let testsValidation: ValidationEntry = { name: 'tests', status: 'skipped', detail: 'No test_command configured — skipped' };

    if (config.runtime.test_command) {
      const testResult = await runTestSuite(runner, config.runtime.test_command, cwd);
      if (testResult.exitCode !== 0) {
        logger.error('Tests failed — reverting Composer updates...');
        await revertComposerChanges(runner, backups, cwd);
        return {
          ...base,
          status: 'error',
          validations: [{ name: 'tests', status: 'fail', detail: testResult.stdout || testResult.stderr }],
          error: 'Tests failed after composer update — changes reverted',
        };
      }
      const detail = testResult.stdout.trim().split('\n').slice(-2).join(' ') || 'Tests passed';
      testsValidation = { name: 'tests', status: 'pass', detail };
    }

    await verifyResidualVulnerabilities(runner, cwd);

    return {
      ...base,
      packages_updated: composerEcosystem.auto_safe_packages,
      validations: [testsValidation],
    };
  } catch (err) {
    throw new PhaseError(
      `Composer updater phase failed: ${err instanceof Error ? err.message : String(err)}`,
      'composer-updater',
      err,
    );
  }
}
