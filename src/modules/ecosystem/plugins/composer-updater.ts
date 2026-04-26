import type { CommandRunner, CommandResult } from '@core/types/common';
import type { ProjectConfig, ValidationCommandConfig } from '@core/types/config';
import type { UpdateResultJson, ValidationEntry } from '@core/types/update';
import type { ScanResultJson } from '@core/types/scan';
import { emptyEcosystem } from '@core/types/scan';
import { PhaseError } from '@core/errors';
import { restoreFiles } from '@infra/utils/git';
import { logger } from '@infra/utils/logger';
import { runValidations } from '../utils/validation-runner';
import { beginUpdaterTransaction } from '../utils/updater-transaction';

const COMPOSER_FILES = ['composer.json', 'composer.lock'];

function extractPackageNames(packageRefs: string[]): string[] {
  return packageRefs.map((ref) => {
    const atIndex = ref.lastIndexOf('@');
    return atIndex > 0 ? ref.slice(0, atIndex) : ref;
  });
}

/**
 * Build shared composer flags for all write-path commands (array form for runArgs).
 * --no-interaction      : no prompts (CI context)
 * --no-scripts          : skip post-install-cmd, post-autoload-dump, post-update-cmd, etc.
 *                         Framework hooks (e.g. Laravel's `artisan package:discover`)
 *                         bootstrap app state that depends on runtime services (db, cache, queue)
 *                         — not available inside a dependency-upgrade flow.
 * --ignore-platform-reqs: (Docker mode only, unless overridden) skips PHP extension checks.
 *                         The Docker container is a CI runner, not the production environment.
 *                         Production has ext-intl, ext-gd, ext-exif, etc.; the container does not.
 */
function buildComposerAutomationArgs(runner: CommandRunner, config: ProjectConfig): string[] {
  const composerConfig = config.scanners?.composer;
  const ignorePlatformReqs =
    composerConfig?.ignore_platform_reqs ?? runner.environment === 'docker';

  return [
    '--no-interaction',
    '--no-scripts',
    ...(ignorePlatformReqs ? ['--ignore-platform-reqs'] : []),
  ];
}

async function checkCurrentState(runner: CommandRunner, cwd: string): Promise<void> {
  logger.debug('Running composer outdated --direct (informational)...');
  // SEC: static args only — no variable data
  await runner.runArgs('composer', ['outdated', '--direct'], { cwd });
}

async function applyComposerUpdate(
  runner: CommandRunner,
  packageNames: string[],
  cwd: string,
  automationArgs: string[],
): Promise<CommandResult> {
  const pkgList = packageNames.join(' ');
  logger.info(`Updating packages: ${pkgList}`);
  // SEC: use runArgs (shell: false) — packageNames from scanner are variable data
  return runner.runArgs(
    'composer',
    ['update', ...packageNames, '--with-all-dependencies', ...automationArgs],
    { cwd, stream: true },
  );
}

async function revertComposerChanges(
  runner: CommandRunner,
  backups: Map<string, string>,
  cwd: string,
  automationArgs: string[],
): Promise<void> {
  await restoreFiles(backups, cwd);
  try {
    // SEC: static args only — no variable data
    await runner.runArgs('composer', ['install', ...automationArgs], { cwd });
  } finally {
    // composer install rewrites composer.lock on any drift; re-restore from the
    // in-memory snapshot so the on-disk lockfile is byte-identical to pre-update.
    await restoreFiles(backups, cwd);
  }
}

export async function runComposerUpdater(
  runner: CommandRunner,
  config: ProjectConfig,
  scanResult: ScanResultJson,
  cwd: string,
  authorizeBreaking = false,
  validationCommands: ValidationCommandConfig[] = [],
): Promise<UpdateResultJson> {
  logger.info('Running Composer safe updates...');

  const automationArgs = buildComposerAutomationArgs(runner, config);
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
    logger.info(`[DRY-RUN] Would execute: composer install ${automationArgs.join(' ')} (env-check)`);
    logger.info(`[DRY-RUN] Would execute: composer update ${packageNamesToUpdate.join(' ')} ${automationArgs.join(' ')}`);
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
    // ── Environment check: verify PHP + composer are functional BEFORE any mutation ──
    // Runs `composer install` to validate the environment before any mutations.
    // Returns a structured error result (not a thrown exception) so the caller can
    // surface the diagnostic cleanly without aborting the pipeline unexpectedly.
    logger.info(`[composer env-check] Running composer install ${automationArgs.join(' ')} to verify environment...`);
    // SEC: static args only — no variable data
    const envCheckResult = await runner.runArgs('composer', ['install', ...automationArgs], { cwd });
    if (envCheckResult.exitCode !== 0) {
      const detail = envCheckResult.stderr || envCheckResult.stdout || '(no output)';
      logger.error('[composer env-check] Environment check failed — aborting update.');
      return {
        ...base,
        status: 'error',
        validations: [{ name: 'validation', status: 'skipped', detail: 'Composer environment check failed — skipped' }],
        error: `Composer environment mismatch: composer install exited with code ${envCheckResult.exitCode}.\n${detail}`,
      };
    }
    logger.info('[composer env-check] Environment check passed.');

    const tx = await beginUpdaterTransaction({ files: COMPOSER_FILES, base, cwd });

    await checkCurrentState(runner, cwd);

    const updateResult = await applyComposerUpdate(runner, packageNamesToUpdate, cwd, automationArgs);
    if (updateResult.exitCode !== 0) {
      // composer update may fail AFTER writing composer.lock (post-autoload-dump
      // scripts, e.g. Laravel's `artisan package:discover`, run at the end and can
      // return non-zero even though the lockfile is already on disk). Revert so
      // the working tree is left byte-identical to the pre-update state.
      logger.error('composer update failed — reverting Composer changes...');
      return tx.abortWithError({
        error: `composer update failed: ${updateResult.stderr}`,
        validations: [{ name: 'validation', status: 'skipped', detail: 'composer update failed — changes reverted' }],
        revert: () => revertComposerChanges(runner, tx.backups, cwd, automationArgs),
      });
    }

    // Run configured validation commands
    const validationResult = await runValidations({
      runner,
      cwd,
      commands: validationCommands,
    });

    if (!validationResult.allPassed) {
      logger.error('Validations failed — reverting Composer updates...');
      return tx.abortWithError({
        error: 'Validations failed after composer update — changes reverted',
        validations: validationResult.entries,
        revert: () => revertComposerChanges(runner, tx.backups, cwd, automationArgs),
      });
    }

    return tx.success({
      packages_updated: composerEcosystem.auto_safe_packages,
      validations: validationResult.entries,
    });
  } catch (err) {
    throw new PhaseError(
      `Composer updater phase failed: ${err instanceof Error ? err.message : String(err)}`,
      'composer-updater',
      err,
    );
  }
}
