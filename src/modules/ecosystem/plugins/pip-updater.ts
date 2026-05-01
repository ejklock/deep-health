import type { CommandRunner } from '@core/types/common';
import type { ValidationCommandConfig } from '@core/types/config';
import type { UpdateResultJson, ValidationEntry } from '@core/types/update';
import type { ScanResultJson } from '@core/types/scan';
import { emptyEcosystem } from '@core/types/scan';
import { PhaseError } from '@core/errors';
import { logger } from '@infra/utils/logger';
import { runValidations } from '../utils/validation-runner';
import { beginUpdaterTransaction } from '../utils/updater-transaction';

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

/**
 * Parse the `Successfully installed` line emitted by pip after a successful install.
 *
 * Format: `Successfully installed pkg1-1.0.0 pkg2-2.3.4 django-debug-toolbar-6.3.0`
 *
 * Splitting on the last hyphen that precedes a digit sequence handles packages
 * with hyphens in their names (e.g. `django-debug-toolbar-6.3.0`).
 *
 * Returns a Map of lowercase-normalized package name → installed version.
 * Returns an empty Map when the line is absent or unparseable.
 */
export function parsePipInstalledVersions(stdout: string): Map<string, string> {
  const result = new Map<string, string>();
  const lines = stdout.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('Successfully installed ')) continue;

    const tokens = trimmed.slice('Successfully installed '.length).split(/\s+/);
    for (const token of tokens) {
      // Find the last hyphen that is immediately followed by a digit
      const match = token.match(/^(.*)-(\d[\d.]*)$/);
      if (!match) continue;
      const name = match[1]!.toLowerCase();
      const version = match[2]!;
      if (name) {
        result.set(name, version);
      }
    }
    break; // Only one "Successfully installed" line expected
  }
  return result;
}

/**
 * Build the `packages_updated` array for pip using installed versions from pip stdout.
 *
 * For each auto_safe package (e.g. "pillow==8.0.1"), look up the name in the
 * installed-versions map and use the real installed version. Falls back to the
 * scan's safeVersion when the package is not found in the map.
 *
 * Returns an empty array when `installedVersions` is empty (nothing was installed).
 */
export function buildPipPackagesUpdated(
  autoSafePackages: string[],
  installedVersions: Map<string, string>,
): string[] {
  if (installedVersions.size === 0) return [];

  const updated: string[] = [];
  for (const pkg of autoSafePackages) {
    const name = stripPipVersion(pkg).toLowerCase();
    const installedVersion = installedVersions.get(name);
    if (installedVersion !== undefined) {
      // Use the real installed version
      updated.push(`${name}@${installedVersion}`);
    } else {
      // Fallback: extract safeVersion from scan string (e.g. "pillow==8.0.1" → "pillow@8.0.1")
      const versionMatch = pkg.match(/==([^\s,;]+)/);
      const safeVersion = versionMatch ? versionMatch[1] : undefined;
      if (safeVersion) {
        updated.push(`${name}@${safeVersion}`);
      } else {
        updated.push(name);
      }
    }
  }
  return updated;
}

async function checkCurrentState(runner: CommandRunner, cwd: string): Promise<void> {
  logger.debug('Running pip list --outdated (informational)...');
  // Ignore exit code — informational only
  await runner.runArgs('pip', ['list', '--outdated'], { cwd });
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
    logger.tagged('pip', 'DRY-RUN', `Would execute: pip install -U ${packageNamesToUpdate.join(' ')}`);
    if (validationCommands.length > 0) {
      for (const vc of validationCommands) {
        logger.tagged('pip', 'DRY-RUN', `Would execute: ${vc.command}`);
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
    const tx = await beginUpdaterTransaction({
      files: PIP_FILES,
      base,
      cwd,
      runner,
      bootstrapSpec: {
        binary: 'pip',
        args: ['install', '-r', 'requirements.txt'],
        label: 'pip install -r requirements.txt (revert)',
      },
    });

    await checkCurrentState(runner, cwd);

    const pkgList = packageNamesToUpdate.join(' ');
    logger.info(`Updating packages: ${pkgList}`);
    // SEC: use runArgs (shell: false) — package names from scanner are variable data
    const updateResult = await runner.runArgs('pip', ['install', '-U', ...packageNamesToUpdate], { cwd, stream: true });
    if (updateResult.exitCode !== 0) {
      // pip install -U can mutate requirements.txt in projects where a post-hook
      // or pip-tools compile is wired in, and always mutates the Python env.
      // Revert to guarantee the working tree and env match the pre-update state.
      logger.error('pip install -U failed — reverting pip changes...');
      return tx.abortWithError({
        error: `pip install -U failed: ${updateResult.stderr}`,
        validations: [{ name: 'validation', status: 'skipped', detail: 'pip install -U failed — changes reverted' }],
      });
    }

    // Parse actually-installed versions from pip stdout to report real installed versions.
    // Falls back to scan safeVersion per-package when a package is absent from the output.
    const installedVersions = parsePipInstalledVersions(updateResult.stdout ?? '');
    const packagesUpdated = buildPipPackagesUpdated(pipEcosystem.auto_safe_packages, installedVersions);

    // Run configured validation commands
    const validationResult = await runValidations({
      runner,
      cwd,
      commands: validationCommands,
    });

    if (!validationResult.allPassed) {
      logger.error('Validations failed — reverting pip updates...');
      return tx.abortWithError({
        error: 'Validations failed after pip update — changes reverted',
        validations: validationResult.entries,
      });
    }

    return tx.success({
      packages_updated: packagesUpdated,
      validations: validationResult.entries,
    });
  } catch (err) {
    throw new PhaseError(
      `pip updater phase failed: ${err instanceof Error ? err.message : String(err)}`,
      'pip-updater',
      err,
    );
  }
}
