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

async function runNpmUpdate(runner: CommandRunner, cwd: string): Promise<CommandResult> {
  logger.info('Running npm update...');
  return runner.run('npm update', { cwd, stream: true });
}

async function installBreakingPackages(
  runner: CommandRunner,
  scanResult: ScanResultJson,
  cwd: string,
): Promise<void> {
  const npmEcosystem = scanResult.ecosystems['npm'] ?? emptyEcosystem();
  const pkgs = npmEcosystem.vulnerabilities
    .filter((v) => v.classification === 'breaking' && v.safeVersion)
    .reduce<Map<string, string>>((map, v) => {
      if (!map.has(v.package)) map.set(v.package, v.safeVersion!);
      return map;
    }, new Map());

  if (pkgs.size === 0) return;

  const specs = [...pkgs.entries()].map(([name, ver]) => `${name}@${ver}`).join(' ');
  logger.info(`Installing authorized breaking-change packages: ${specs}`);
  await runner.run(`npm install ${specs}`, { cwd, stream: true });
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
    logger.info('[DRY-RUN] Would execute: npm update');
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

    const updateResult = await runNpmUpdate(runner, cwd);
    if (updateResult.exitCode !== 0) {
      return {
        ...base,
        status: 'error',
        validations: [{ name: 'build', status: 'fail', detail: `npm update failed: ${updateResult.stderr}` }],
        error: `npm update failed: ${updateResult.stderr}`,
      };
    }

    if (authorizeBreaking) {
      await installBreakingPackages(runner, scanResult, cwd);
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
