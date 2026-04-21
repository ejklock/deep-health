import type { CommandRunner } from '@core/types/common';
import type { ValidationCommandConfig } from '@core/types/config';
import type { UpdateResultJson, ValidationEntry } from '@core/types/update';
import type { ScanResultJson } from '@core/types/scan';
import { emptyEcosystem } from '@core/types/scan';
import { PhaseError } from '@core/errors';
import { backupFiles, restoreFiles } from '@infra/utils/git';
import { logger } from '@infra/utils/logger';
import { runValidations } from '../utils/validation-runner';

const PIP_FILES = ['requirements.txt'];

/**
 * Strip pip version specifiers and extras from a package reference.
 *
 * Rules (applied in order):
 * 1. Strip trailing `[extras]` group (e.g. `pkg[security]` → `pkg`)
 * 2. Split on first occurrence of `==|>=|<=|~=|!=|>|<|@` — keep left side
 * 3. Trim whitespace
 *
 * Examples:
 *   'requests==2.31'         → 'requests'
 *   'requests>=2.0'          → 'requests'
 *   'requests[security]==2'  → 'requests'
 *   'requests[a,b]>=1'       → 'requests'
 *   'requests@1.0'           → 'requests'
 *   'requests'               → 'requests'
 */
export function stripPipVersion(ref: string): string {
  // Strip extras brackets first
  let cleaned = ref.replace(/\[[^\]]*\]/g, '');
  // Split on first version specifier operator
  const match = cleaned.match(/^([^=!<>~@]*)/);
  cleaned = match ? (match[1] ?? cleaned) : cleaned;
  return cleaned.trim();
}

async function checkCurrentState(runner: CommandRunner, cwd: string): Promise<void> {
  logger.debug('Running pip list --outdated (informational)...');
  // Ignore exit code — informational only
  await runner.run('pip list --outdated', { cwd });
}

async function revertPipChanges(
  runner: CommandRunner,
  backups: Map<string, string>,
  cwd: string,
): Promise<void> {
  await restoreFiles(backups, cwd);
  logger.info('Running pip install -r requirements.txt to restore dependencies after revert...');
  const revertResult = await runner.run('pip install -r requirements.txt', { cwd, stream: true });
  if (revertResult.exitCode !== 0) {
    logger.error(
      [
        'pip install -r requirements.txt (revert) failed!',
        `  command : ${revertResult.command}`,
        `  exit    : ${revertResult.exitCode}`,
        revertResult.stdout ? `  stdout  :\n${revertResult.stdout}` : null,
        revertResult.stderr ? `  stderr  :\n${revertResult.stderr}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
}

export async function runPipUpdater(
  runner: CommandRunner,
  _config: unknown,
  scanResult: ScanResultJson,
  cwd: string,
  authorizeBreaking = false,
  validationCommands: ValidationCommandConfig[] = [],
): Promise<UpdateResultJson> {
  logger.info('Running pip safe updates...');

  const pipEcosystem = scanResult.ecosystems['pip'] ?? emptyEcosystem();

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
    agent: 'pip-safe-update',
    status: 'success',
    packages_updated: [],
    packages_skipped: [],
    packages_pending_breaking: pipEcosystem.breaking_packages,
    validations: skippedEntries,
    error: null,
  };

  const autoSafePackageNames = pipEcosystem.auto_safe_packages.map(stripPipVersion);
  const breakingPackageNames = authorizeBreaking
    ? pipEcosystem.breaking_packages.map(stripPipVersion)
    : [];
  const packageNamesToUpdate = [...new Set([...autoSafePackageNames, ...breakingPackageNames])];

  if (packageNamesToUpdate.length === 0) {
    return { ...base, validations: [{ name: 'validation', status: 'skipped', detail: 'No packages to update' }] };
  }

  if (runner.dryRun) {
    logger.info(`[DRY-RUN] Would execute: pip install -U ${packageNamesToUpdate.join(' ')}`);
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
      packages_updated: pipEcosystem.auto_safe_packages,
      validations: dryRunEntries,
    };
  }

  try {
    const backups = await backupFiles(PIP_FILES, cwd);

    await checkCurrentState(runner, cwd);

    const pkgList = packageNamesToUpdate.join(' ');
    logger.info(`Updating packages: ${pkgList}`);
    const updateResult = await runner.run(`pip install -U ${pkgList}`, { cwd, stream: true });
    if (updateResult.exitCode !== 0) {
      return {
        ...base,
        status: 'error',
        validations: [{ name: 'validation', status: 'skipped', detail: 'pip install -U failed — validations not run' }],
        error: `pip install -U failed: ${updateResult.stderr}`,
      };
    }

    // Run configured validation commands
    const validationResult = await runValidations({
      runner,
      cwd,
      commands: validationCommands,
    });

    if (!validationResult.allPassed) {
      logger.error('Validations failed — reverting pip updates...');
      await revertPipChanges(runner, backups, cwd);
      return {
        ...base,
        status: 'error',
        validations: validationResult.entries,
        error: 'Validations failed after pip update — changes reverted',
      };
    }

    return {
      ...base,
      packages_updated: pipEcosystem.auto_safe_packages,
      validations: validationResult.entries,
    };
  } catch (err) {
    throw new PhaseError(
      `pip updater phase failed: ${err instanceof Error ? err.message : String(err)}`,
      'pip-updater',
      err,
    );
  }
}
