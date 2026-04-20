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

/** osv-scanner post-update verification scan for npm lockfile */
const OSV_SCAN_NPM = 'osv-scanner --lockfile package-lock.json --format json';

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
  await runner.run('npm install', { cwd });
}

async function verifyResidualVulnerabilities(runner: CommandRunner, cwd: string): Promise<void> {
  logger.info(`Running post-update OSV verification: ${OSV_SCAN_NPM}`);
  await runner.run(OSV_SCAN_NPM, { cwd });
}

export async function runNpmUpdater(
  runner: CommandRunner,
  _config: unknown,
  scanResult: ScanResultJson,
  cwd: string,
  authorizeBreaking = false,
  validationCommands: ValidationCommandConfig[] = [],
  fixerStrategy: FixerStrategyId = 'osv',
): Promise<UpdateResultJson> {
  logger.info('Running npm safe updates...');

  const npmEcosystem = scanResult.ecosystems['npm'] ?? emptyEcosystem();

  // Resolve which fixer function to use
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
    logger.info(`[DRY-RUN] Would execute: ${OSV_SCAN_NPM}`);
    return { ...base, validations: skippedValidations };
  }

  try {
    const backups = await backupFiles(NPM_FILES, cwd);

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

    // Run configured validation commands
    const validationResult = await runValidations({
      runner,
      cwd,
      commands: validationCommands,
    });

    if (!validationResult.allPassed) {
      logger.error('Validation failed — reverting npm changes...');
      await revertNpmChanges(runner, backups, cwd);
      return {
        ...base,
        status: 'error',
        validations: validationResult.entries,
        error: 'Validation failed after npm update — changes reverted',
      };
    }

    // Post-update OSV verification (osv-scanner must be available via the runner)
    await verifyResidualVulnerabilities(runner, cwd);

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
