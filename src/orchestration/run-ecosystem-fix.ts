/**
 * runEcosystemFix — per-plugin fix flow extracted from the orchestrator loop.
 *
 * Responsible for:
 *   has-updates gate → effective runner resolution → OSV staging-fix →
 *   updater → breaking-install → OSV residual verification → ecosystem gate.
 *
 * NOT responsible for:
 *   - phase filtering (`shouldRunPhase`) — caller decides which plugins to run
 *   - advisors (informational; caller schedules them)
 *   - aggregating results into the OrchestratorResult shape
 *
 * Throws `GateValidationError` if the ecosystem gate fails. Otherwise returns
 * a tagged outcome and lets the orchestrator decide whether to continue, break,
 * or record state on the rolling result object.
 */

import type { CommandRunner } from '@core/types/common';
import type { ProjectConfig, FixerStrategyId } from '@core/types/config';
import type { ScanResultJson } from '@core/types/scan';
import type { UpdateResultJson } from '@core/types/update';
import type { ResidualVerification } from '@core/types/report';
import type { EcosystemPlugin } from '@modules/ecosystem/types';
import { GateValidationError } from '@core/errors';
import { validateEcosystemGate } from '@core/gates/validator';
import { logger, setProgressSink, makeProgressSink } from '@infra/utils/logger';
import { resolveEcosystemRuntime, resolveOsvRuntime } from '@infra/ecosystem-runtime';
import { applyOsvFixViaStaging } from './osv-fix-applier';
import { logDryRunPreview } from '@modules/ecosystem/utils/dry-run-preview';

export interface RunEcosystemFixParams {
  plugin: EcosystemPlugin;
  /** Host command runner — passed through to `resolveEcosystemRuntime`. */
  hostRunner: CommandRunner;
  config: ProjectConfig;
  scanResult: ScanResultJson;
  cwd: string;
  dryRun: boolean;
  authorizeBreaking: boolean;
  /**
   * Optional pre-run snapshots from the orchestrator (taken before any mutations).
   * Forwarded to the updater for dirty-tree detection after revert.
   */
  preRunSnapshots: Map<string, string> | undefined;
}

export type RunEcosystemFixOutcome =
  | { status: 'skipped'; reason: 'no-updates' }
  | { status: 'success'; updateResult: UpdateResultJson; residualVerification?: ResidualVerification }
  | { status: 'error'; updateResult: UpdateResultJson };

export async function runEcosystemFix(
  params: RunEcosystemFixParams,
): Promise<RunEcosystemFixOutcome> {
  const {
    plugin,
    hostRunner,
    config,
    scanResult,
    cwd,
    dryRun,
    authorizeBreaking,
    preRunSnapshots,
  } = params;

  // Resolve per-ecosystem config entry
  const ecoConfigEntry = config.ecosystems.find((e) => e.id === plugin.id);

  const validationCommands =
    ecoConfigEntry?.validationCommands ?? plugin.defaultValidationCommands;

  const fixerStrategy: FixerStrategyId = plugin.resolveEffectiveFixer
    ? await plugin.resolveEffectiveFixer(config, cwd)
    : (ecoConfigEntry?.fixer ?? (plugin.supportedFixers[0] ?? 'osv') as FixerStrategyId);

  const ecosystemResult = scanResult.ecosystems[plugin.id];
  const hasUpdates =
    ecosystemResult &&
    (ecosystemResult.auto_safe > 0 ||
      (authorizeBreaking && ecosystemResult.breaking > 0));

  if (!hasUpdates) {
    logger.skip(`Skipping ${plugin.name} — no auto-safe vulnerabilities`);
    return { status: 'skipped', reason: 'no-updates' };
  }

  logger.phase(plugin.id);

  // Resolve effective runner via the ecosystem runtime module
  const effectiveRunner: CommandRunner = plugin.runtimeSpec
    ? await resolveEcosystemRuntime(plugin, hostRunner, config, cwd)
    : hostRunner;

  // OSV staging-apply (generic, driven by plugin.osvFixSpec)
  let preFixBackups: Map<string, string> | undefined;
  let osvFixOutcome:
    | {
        applied: boolean;
        packagesUpdated: Array<{
          name: string;
          versionFrom: string;
          versionTo: string;
        }>;
      }
    | undefined;

  if (
    (fixerStrategy === 'osv' || fixerStrategy === 'osv-then-audit') &&
    plugin.osvFixSpec
  ) {
    // When scan.paths is configured, derive the fix lockfile path from the
    // first explicit file path whose basename matches the plugin's fixLockfile.
    // For directory paths (ending with /), construct: '<dir><fixLockfile>'.
    // Falls back to plugin default (osvFixSpec.fixLockfile) when no match is found.
    let fixLockfileOverride: string | undefined;
    const scanPaths = config.scan?.paths;
    if (scanPaths && scanPaths.length > 0) {
      const pluginLockfile = plugin.osvFixSpec.fixLockfile;
      for (const p of scanPaths) {
        if (p.endsWith('/')) {
          // directory entry — construct the full path
          fixLockfileOverride = `${p}${pluginLockfile}`;
          break;
        } else if (p.endsWith(`/${pluginLockfile}`) || p === pluginLockfile) {
          // explicit file path matching the plugin's lockfile
          fixLockfileOverride = p;
          break;
        }
      }
      if (!fixLockfileOverride) {
        logger.tagged('osv', 'OSV fix', `scan.paths is configured but no entry matches "${pluginLockfile}". ` +
          `Falling back to default fix lockfile path.`, 'warn');
      }
    }

    setProgressSink(makeProgressSink());
    let fixResult: Awaited<ReturnType<typeof applyOsvFixViaStaging>>;
    try {
      fixResult = await applyOsvFixViaStaging({
        cwd,
        osvConfig: config.scanners?.osv,
        osvFixSpec: plugin.osvFixSpec,
        fixLockfileOverride,
        dryRun,
      });
    } finally {
      setProgressSink(null);
    }
    preFixBackups = fixResult.backups;
    osvFixOutcome = {
      applied: fixResult.applied,
      packagesUpdated: fixResult.packagesUpdated,
    };
  }

  // Dry-run planned-changes preview
  if (dryRun) {
    logger.header(plugin.id, 'Dry-run preview');
    logDryRunPreview(plugin.id, ecosystemResult, authorizeBreaking);
  }

  setProgressSink(makeProgressSink());
  let updateResult: Awaited<ReturnType<typeof plugin.runUpdater>>;
  try {
    updateResult = await plugin.runUpdater({
      runner: effectiveRunner,
      config,
      scanResult,
      cwd,
      authorizeBreaking,
      validationCommands,
      fixerStrategy,
      preFixBackups,
      osvFixOutcome,
      preRunSnapshots:
        preRunSnapshots && preRunSnapshots.size > 0 ? preRunSnapshots : undefined,
    });
  } finally {
    setProgressSink(null);
  }

  // === Post-updater: Breaking packages install (generic, via plugin hook) ===
  if (
    plugin.installBreakingPackages &&
    authorizeBreaking &&
    updateResult.status !== 'error'
  ) {
    const breakRes = await plugin.installBreakingPackages({
      runner: effectiveRunner,
      cwd,
      scanResult,
      dryRun,
      fixerStrategy,
    });
    if (breakRes?.status === 'error') {
      // Mirror legacy short-circuit: skip residual verify and gate validation.
      return {
        status: 'error',
        updateResult: {
          ...updateResult,
          status: 'error',
          error: breakRes.error ?? 'breaking install failed',
        },
      };
    }
  }

  // === Post-updater: OSV residual verification (driven by plugin.postUpdateOsvVerify) ===
  let residualVerification: ResidualVerification | undefined;
  const shouldOsvVerify =
    updateResult.status !== 'error' &&
    (plugin.postUpdateOsvVerify === 'always' ||
      (plugin.postUpdateOsvVerify === 'osv-strategy-only' &&
        fixerStrategy === 'osv'));

  if (shouldOsvVerify) {
    const osvVerifyRunner = resolveOsvRuntime(config, cwd, hostRunner);
    const verifyScanArgs = plugin.buildScanArgs();
    const verifyCmd = `osv-scanner ${verifyScanArgs.join(' ')} --format json`;
    residualVerification = await runOsvResidualVerification(
      osvVerifyRunner,
      cwd,
      dryRun,
      verifyCmd,
    );
  }

  // Generic gate validation for this ecosystem
  const gate = validateEcosystemGate(plugin.id, updateResult);
  if (!gate.valid) {
    throw new GateValidationError(
      `Gate ${plugin.id} validation failed: ${gate.errors.join(', ')}`,
      plugin.id,
      gate.errors,
    );
  }

  if (updateResult.status === 'error') {
    logger.error(`${plugin.name} update failed — stopping pipeline`);
    return { status: 'error', updateResult };
  }

  logger.info(
    `${plugin.name} update complete: ${updateResult.packages_updated.length} packages updated`,
  );

  return { status: 'success', updateResult, residualVerification };
}

/**
 * Run residual OSV scan verification after updates are applied.
 * Best-effort: logs a warning on failure but never throws.
 */
async function runOsvResidualVerification(
  osvRunner: CommandRunner,
  cwd: string,
  dryRun: boolean,
  command: string,
): Promise<ResidualVerification> {
  if (dryRun) {
    logger.tagged('osv', 'DRY-RUN', `Would execute: ${command}`);
    return { status: 'skipped' };
  }
  logger.tagged('osv', 'OSV verify', `Running post-update OSV verification: ${command}`);
  try {
    const cmdResult = await osvRunner.run(command, { cwd });
    let parsed: ScanResultJson;
    try {
      parsed = JSON.parse(cmdResult.stdout) as ScanResultJson;
    } catch {
      logger.tagged('osv', 'OSV verify', 'Could not parse osv-scanner JSON output — treating as non-fatal', 'warn');
      return { status: 'skipped' };
    }
    const summary: Record<string, number> = {};
    for (const [ecoId, ecoResult] of Object.entries(parsed.ecosystems ?? {})) {
      summary[ecoId] = ecoResult.vulnerabilities_total;
    }
    const hasResidual = Object.values(summary).some((n) => n > 0);
    if (hasResidual) {
      logger.tagged('osv', 'OSV verify', 'Residual CVEs detected after update — see summary for details', 'warn');
    }
    return hasResidual
      ? { status: 'unverified', summary }
      : { status: 'verified', summary };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.tagged('osv', 'OSV verify', `Post-update OSV verification failed (non-fatal): ${message}`, 'warn');
    return { status: 'skipped' };
  }
}
