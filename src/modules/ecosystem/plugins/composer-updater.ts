import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandRunner, CommandResult } from '@core/types/common';
import type { ProjectConfig, ValidationCommandConfig } from '@core/types/config';
import type { UpdateResultJson, ValidationEntry } from '@core/types/update';
import type { ScanResultJson } from '@core/types/scan';
import { emptyEcosystem } from '@core/types/scan';
import { PhaseError } from '@core/errors';
import { logger } from '@infra/utils/logger';
import { runValidations } from '../utils/validation-runner';
import { beginUpdaterTransaction } from '../utils/updater-transaction';
import { runEcosystemEnvironmentProbe } from '../utils/environment-probe';

const COMPOSER_FILES = ['composer.json', 'composer.lock'];

/**
 * Parse a composer.lock JSON string and return a Map of package name → version.
 * Reads from both `packages` and `packages-dev` arrays.
 * Returns an empty Map on parse failure or missing fields (logs a warning).
 */
export function extractComposerLockVersions(lockJsonText: string): Map<string, string> {
  try {
    const parsed = JSON.parse(lockJsonText) as Record<string, unknown>;
    const result = new Map<string, string>();
    const sections = ['packages', 'packages-dev'] as const;
    for (const section of sections) {
      const pkgs = parsed[section];
      if (!Array.isArray(pkgs)) continue;
      for (const pkg of pkgs) {
        if (pkg && typeof pkg === 'object') {
          const p = pkg as Record<string, unknown>;
          if (typeof p['name'] === 'string' && typeof p['version'] === 'string') {
            result.set(p['name'], p['version']);
          }
        }
      }
    }
    return result;
  } catch {
    logger.warn('composer-updater: failed to parse composer.lock JSON — version extraction skipped');
    return new Map();
  }
}

/**
 * Build `packages_updated` array from pre/post lock version maps.
 *
 * For each target package name:
 * - Skip if the post-update version is absent (package not in new lockfile).
 * - Skip if pre-update version equals post-update version (no real change).
 * - Otherwise emit `name@<postVersion>`.
 */
export function buildComposerPackagesUpdated(
  targetNames: string[],
  beforeVersions: Map<string, string>,
  afterVersions: Map<string, string>,
): string[] {
  const updated: string[] = [];
  for (const name of targetNames) {
    const versionTo = afterVersions.get(name);
    if (versionTo === undefined) continue;
    const versionFrom = beforeVersions.get(name);
    if (versionFrom === versionTo) continue;
    updated.push(`${name}@${versionTo}`);
  }
  return updated;
}

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
  const composerConfig = config.runners?.composer;
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
    logger.tagged('composer', 'DRY-RUN', `Would execute: composer install ${automationArgs.join(' ')} (env-check)`);
    logger.tagged('composer', 'DRY-RUN', `Would execute: composer update ${packageNamesToUpdate.join(' ')} ${automationArgs.join(' ')}`);
    if (validationCommands.length > 0) {
      for (const vc of validationCommands) {
        logger.tagged('composer', 'DRY-RUN', `Would execute: ${vc.command}`);
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
      packages_updated: [],
      validations: dryRunEntries,
    };
  }

  try {
    // ── Environment check: verify PHP + composer are functional BEFORE any mutation ──
    // Uses the named Ecosystem Environment Probe primitive so the same args array is
    // shared with the BootstrapSpec (no duplicate literal).
    const probeArgs = ['install', ...automationArgs];
    const probe = await runEcosystemEnvironmentProbe(runner, {
      binary: 'composer',
      args: probeArgs,
      cwd,
      errorPrefix: 'Composer environment mismatch',
      label: 'composer',
    });
    if (!probe.ok) {
      return {
        ...base,
        status: 'error',
        validations: [{ name: 'validation', status: 'skipped', detail: 'Composer environment check failed — skipped' }],
        error: probe.error,
      };
    }

    const tx = await beginUpdaterTransaction({
      files: COMPOSER_FILES,
      base,
      cwd,
      runner,
      bootstrapSpec: {
        binary: 'composer',
        args: probeArgs,
        label: 'composer install (revert)',
      },
    });

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
      });
    }

    // Derive packages_updated from pre/post composer.lock versions
    const beforeLockText = tx.backups.get('composer.lock') ?? '';
    const beforeVersions = extractComposerLockVersions(beforeLockText);

    let packagesUpdated: string[];
    try {
      const afterLockText = await readFile(join(cwd, 'composer.lock'), 'utf-8');
      const afterVersions = extractComposerLockVersions(afterLockText);
      packagesUpdated = buildComposerPackagesUpdated(packageNamesToUpdate, beforeVersions, afterVersions);
    } catch (readErr) {
      logger.warn(
        `composer-updater: could not read post-update composer.lock (${readErr instanceof Error ? readErr.message : String(readErr)}) — falling back to scan package list`,
      );
      packagesUpdated = composerEcosystem.auto_safe_packages;
    }

    return tx.success({
      packages_updated: packagesUpdated,
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
