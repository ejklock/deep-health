import type { CommandRunner, CommandResult } from '@core/types/common.js';
import type { ProjectConfig } from '@core/types/config.js';
import type { UpdateResultJson, ValidationEntry } from '@core/types/update.js';
import type { ScanResultJson } from '@core/types/scan.js';
import { emptyEcosystem } from '@modules/scanner/osv-engine.js';
import { PhaseError } from '@core/errors.js';
import { backupFiles, restoreFiles } from '@infra/utils/git.js';
import { logger } from '@infra/utils/logger.js';

const NPM_FILES = ['package.json', 'package-lock.json'];

/** osv-scanner in-place fix command for npm lockfile */
const OSV_FIX_NPM = 'osv-scanner fix --strategy=in-place -L package-lock.json';

/** osv-scanner post-update verification scan for npm lockfile */
const OSV_SCAN_NPM = 'osv-scanner --lockfile package-lock.json --format json';

async function checkCurrentState(runner: CommandRunner, cwd: string): Promise<void> {
  logger.debug('Running npm outdated and npm audit (informational)...');
  await runner.run('npm outdated', { cwd });
  await runner.run('npm audit', { cwd });
}

async function applyOsvFix(runner: CommandRunner, cwd: string): Promise<void> {
  logger.info(`Applying OSV in-place fix: ${OSV_FIX_NPM}`);
  const result = await runner.run(OSV_FIX_NPM, { cwd, stream: true });
  if (result.exitCode !== 0) {
    logger.warn(`osv-scanner fix exited with ${result.exitCode}: ${result.stderr}`);
  }
}

/**
 * Installs auto-safe packages using targeted `npm install <pkg@safeVersion>` commands.
 * Derives install specs from OSV vulnerability entries where classification === 'auto_safe'
 * and a safeVersion is available. Deduplicates by package name (first safeVersion wins).
 * Returns an error string if any targeted install fails, null on success.
 */
async function installAutoSafePackages(
  runner: CommandRunner,
  scanResult: ScanResultJson,
  cwd: string,
): Promise<string | null> {
  const npmEcosystem = scanResult.ecosystems['npm'] ?? emptyEcosystem();
  const pkgs = npmEcosystem.vulnerabilities
    .filter((v) => v.classification === 'auto_safe' && v.safeVersion)
    .reduce<Map<string, string>>((map, v) => {
      if (!map.has(v.package)) map.set(v.package, v.safeVersion!);
      return map;
    }, new Map());

  if (pkgs.size === 0) {
    logger.info('No auto-safe packages with a known safeVersion — skipping targeted installs.');
    return null;
  }

  for (const [name, ver] of pkgs.entries()) {
    const spec = `${name}@${ver}`;
    logger.info(`Installing auto-safe package: npm install ${spec}`);
    const result = await runner.run(`npm install ${spec}`, { cwd, stream: true });
    if (result.exitCode !== 0) {
      return `npm install ${spec} failed: ${result.stderr}`;
    }
  }

  return null;
}

async function installBreakingPackages(
  runner: CommandRunner,
  scanResult: ScanResultJson,
  cwd: string,
): Promise<string | null> {
  const npmEcosystem = scanResult.ecosystems['npm'] ?? emptyEcosystem();
  const pkgs = npmEcosystem.vulnerabilities
    .filter((v) => v.classification === 'breaking' && v.safeVersion)
    .reduce<Map<string, string>>((map, v) => {
      if (!map.has(v.package)) map.set(v.package, v.safeVersion!);
      return map;
    }, new Map());

  if (pkgs.size === 0) return null;

  const specs = [...pkgs.entries()].map(([name, ver]) => `${name}@${ver}`).join(' ');
  logger.info(`Installing authorized breaking-change packages: ${specs}`);
  const result = await runner.run(`npm install ${specs}`, { cwd, stream: true });
  if (result.exitCode !== 0) {
    return `npm install ${specs} failed: ${result.stderr}`;
  }
  return null;
}

async function validateBuilds(
  runner: CommandRunner,
  config: ProjectConfig,
  cwd: string,
): Promise<{ frontend: CommandResult; backend: CommandResult }> {
  logger.info('Validating frontend build...');
  const frontend = await runner.run(config.runtime.build_commands!.frontend, { cwd, stream: true });
  logger.info('Validating backend build...');
  const backend = await runner.run(config.runtime.build_commands!.backend, { cwd, stream: true });
  return { frontend, backend };
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
  config: ProjectConfig,
  scanResult: ScanResultJson,
  cwd: string,
  authorizeBreaking = false,
): Promise<UpdateResultJson> {
  logger.info('Phase 2: Running npm safe updates...');

  const npmEcosystem = scanResult.ecosystems['npm'] ?? emptyEcosystem();

  const base: UpdateResultJson = {
    $schema: 'osv-update-result/v1',
    agent: 'npm-safe-update',
    status: 'success',
    packages_updated: [],
    packages_skipped: [],
    packages_pending_breaking: npmEcosystem.breaking_packages,
    validations: [{ name: 'build', status: 'skipped', detail: 'No build_commands configured — skipped' }],
    error: null,
  };

  if (runner.dryRun) {
    logger.info(`[DRY-RUN] Would execute: ${OSV_FIX_NPM}`);
    logger.info('[DRY-RUN] Would execute: npm install <pkg@safeVersion> (per OSV auto-safe package)');
    if (authorizeBreaking) logger.info('[DRY-RUN] Would install authorized breaking-change packages');
    if (config.runtime.build_commands) {
      logger.info(`[DRY-RUN] Would execute: ${config.runtime.build_commands.frontend}`);
      logger.info(`[DRY-RUN] Would execute: ${config.runtime.build_commands.backend}`);
    }
    logger.info(`[DRY-RUN] Would execute: ${OSV_SCAN_NPM}`);
    const dryRunValidation: ValidationEntry = config.runtime.build_commands
      ? { name: 'build', status: 'skipped', detail: 'Dry-run — not executed' }
      : { name: 'build', status: 'skipped', detail: 'No build_commands configured — skipped' };
    return { ...base, validations: [dryRunValidation] };
  }

  try {
    const backups = await backupFiles(NPM_FILES, cwd);

    await checkCurrentState(runner, cwd);
    await applyOsvFix(runner, cwd);

    const autoSafeError = await installAutoSafePackages(runner, scanResult, cwd);
    if (autoSafeError) {
      return {
        ...base,
        status: 'error',
        validations: [{ name: 'build', status: 'fail', detail: autoSafeError }],
        error: autoSafeError,
      };
    }

    if (authorizeBreaking) {
      const breakingError = await installBreakingPackages(runner, scanResult, cwd);
      if (breakingError) {
        return {
          ...base,
          status: 'error',
          validations: [{ name: 'build', status: 'fail', detail: breakingError }],
          error: breakingError,
        };
      }
    }

    let buildValidation: ValidationEntry = { name: 'build', status: 'skipped', detail: 'No build_commands configured — skipped' };

    if (config.runtime.build_commands) {
      const { frontend, backend } = await validateBuilds(runner, config, cwd);

      if (frontend.exitCode !== 0) {
        logger.error('Frontend build failed — reverting...');
        await revertNpmChanges(runner, backups, cwd);
        return {
          ...base,
          status: 'error',
          validations: [{ name: 'build', status: 'fail', detail: `Frontend build failed: ${frontend.stderr}` }],
          error: 'Frontend build failed after npm update — changes reverted',
        };
      }

      if (backend.exitCode !== 0) {
        logger.error('Backend build failed — reverting...');
        await revertNpmChanges(runner, backups, cwd);
        return {
          ...base,
          status: 'error',
          validations: [{ name: 'build', status: 'fail', detail: `Backend build failed: ${backend.stderr}` }],
          error: 'Backend build failed after npm update — changes reverted',
        };
      }

      buildValidation = { name: 'build', status: 'pass', detail: 'Frontend and backend builds passed after update' };
    }

    await verifyResidualVulnerabilities(runner, cwd);

    return {
      ...base,
      packages_updated: npmEcosystem.auto_safe_packages,
      validations: [buildValidation],
    };
  } catch (err) {
    throw new PhaseError(
      `npm updater phase failed: ${err instanceof Error ? err.message : String(err)}`,
      'npm-updater',
      err,
    );
  }
}
