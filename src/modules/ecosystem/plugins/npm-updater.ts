import type { CommandRunner } from '@core/types/common';
import type { FixerStrategyId, ValidationCommandConfig } from '@core/types/config';
import type { UpdateResultJson } from '@core/types/update';
import type { ScanResultJson } from '@core/types/scan';
import { PhaseError } from '@core/errors';
import { backupFiles } from '@infra/utils/fs-backup';
import { logger } from '@infra/utils/logger';
import { FIXER_MAP } from '../fixers/index';
import type { OsvFixOutcome } from '../fixers/index';
import { runUpdaterLifecycle } from '../utils/updater-lifecycle';

const NPM_FILES = ['package.json', 'package-lock.json'];
const NPM_ADVISOR_FILES = ['yarn.lock'];

async function checkCurrentState(runner: CommandRunner, cwd: string): Promise<void> {
  logger.debug('Running npm outdated and npm audit (informational)...');
  await runner.runArgs('npm', ['outdated'], { cwd });
  await runner.runArgs('npm', ['audit'], { cwd });
}

export async function runNpmUpdater(
  runner: CommandRunner,
  _config: unknown,
  scanResult: ScanResultJson,
  cwd: string,
  authorizeBreaking = false,
  validationCommands: ValidationCommandConfig[] = [],
  fixerStrategy: FixerStrategyId = 'osv',
  preFixBackups?: Map<string, string>,
  osvFixOutcome?: OsvFixOutcome,
  preRunSnapshots?: Map<string, string>,
): Promise<UpdateResultJson> {
  logger.info('Running npm safe updates...');
  const fixerFn = FIXER_MAP[fixerStrategy];

  try {
    // Advisor files backed up after the OSV pre-phase; primary backups from orchestrator when available.
    const advisorBackups = await backupFiles(NPM_ADVISOR_FILES, cwd);
    const primaryBackups = preFixBackups ?? (await backupFiles(NPM_FILES, cwd));
    const mergedBackups = new Map([...primaryBackups, ...advisorBackups]);

    if (runner.dryRun) {
      logger.tagged('npm', 'DRY-RUN', `Would execute fixer strategy: ${fixerStrategy}`);
      if (authorizeBreaking) logger.tagged('npm', 'DRY-RUN', 'Would install authorized breaking-change packages');
    } else if (validationCommands.length === 0) {
      logger.warn('No validation commands configured for npm ecosystem — changes will land without test signal');
    }

    return await runUpdaterLifecycle(
      {
        agentName: 'npm-safe-update',
        ecosystemKey: 'npm',
        backupPaths: NPM_FILES,
        bootstrapSpec: { binary: 'npm', args: ['ci'], label: 'npm ci (revert)' },

        async applyFix(ctx) {
          await checkCurrentState(ctx.runner, ctx.cwd);
          const fixerResult = await fixerFn({ runner: ctx.runner, cwd: ctx.cwd, scanResult: ctx.scanResult, authorizeBreaking: ctx.authorizeBreaking, osvFixOutcome });
          if (fixerResult.breakingInstallError) {
            return { ok: false, error: fixerResult.breakingInstallError, validationStatus: 'fail' };
          }
          return { ok: true, value: fixerResult };
        },

        async preValidation(ctx, fixerResult) {
          if (ctx.validationCommands.length === 0) { void fixerResult; return; }
          logger.info('Running npm ci to ensure clean dependency state before validation...');
          const ciResult = await ctx.runner.runArgs('npm', ['ci'], { cwd: ctx.cwd, stream: true });
          if (ciResult.exitCode !== 0) {
            const detail = [
              `npm ci failed (exit ${ciResult.exitCode})`,
              `  command : ${ciResult.command}`,
              ciResult.stdout ? `  stdout  :\n${ciResult.stdout}` : null,
              ciResult.stderr ? `  stderr  :\n${ciResult.stderr}` : null,
            ].filter(Boolean).join('\n');
            logger.error(`npm ci failed before validation:\n${detail}`);
            logger.error('Reverting npm changes...');
            throw new Error(`npm ci failed before validation — changes reverted\n${detail}`);
          }
        },

        async partialRevert(ctx, fixerResult) {
          if (!fixerResult.partialRevert) return null;
          await fixerResult.partialRevert(ctx.runner, ctx.cwd);
          const osvOnly = osvFixOutcome?.packagesUpdated.map((p) => `${p.name}@${p.versionTo}`) ?? [];
          return { packagesUpdated: osvOnly };
        },

        async derivePackagesUpdated(_ctx, fixerResult) {
          return fixerResult.packagesUpdated;
        },
      },
      { runner, cwd, scanResult, ecosystemId: 'npm', validationCommands, authorizeBreaking },
      { preFixBackups: mergedBackups, preRunSnapshots, failIfAllSkipped: true },
    );
  } catch (err) {
    if (err instanceof PhaseError) throw err;
    throw new PhaseError(
      `npm updater phase failed: ${err instanceof Error ? err.message : String(err)}`,
      'npm-updater',
      err,
    );
  }
}
