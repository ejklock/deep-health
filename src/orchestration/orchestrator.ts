import type { CommandRunner, PhaseStatus } from '@core/types/common';
import type { ProjectConfig, FixerStrategyId } from '@core/types/config';
import type { ScanResultJson } from '@core/types/scan';
import type { UpdateResultJson } from '@core/types/update';
import type { AdvisorResult } from '@core/types/report';
import type { EngineWarning, ScannerEngineContext } from '@modules/scanner/types';
import { validateGateA, validateEcosystemGate } from '@core/gates/validator';
import { GateValidationError } from '@core/errors';
import { logger } from '@infra/utils/logger';
import { detectGitBranch } from '@infra/utils/git-branch';
import { NpmDockerRunner, resolveNpmDockerImage } from '@infra/provisioner/npm-runner';
import { OsvDockerRunner } from '@infra/provisioner/osv-runner';
import { PipDockerRunner, resolvePipDockerImage } from '@infra/provisioner/pip-runner';
import { NpmContainerCommandRunner } from '@infra/executor/npm-container-runner';
import { OsvContainerCommandRunner } from '@infra/executor/osv-container-runner';
import { PipContainerCommandRunner } from '@infra/executor/pip-container-runner';
// Ecosystem registry — plugins are registered via modules/ecosystem/index.ts side-effects
import { EcosystemRegistry, defaultRegistry } from '@modules/ecosystem/index';
// Scanner registry — engines are bootstrapped lazily via bootstrapDefaultEngines()
import {
  defaultScannerRegistry,
  ScannerEngineRegistry,
  aggregateScanResults,
  OSV_ENGINE_ID,
  bootstrapDefaultEngines,
} from '@modules/scanner/index';
import type { AggregatedScanResult } from '@modules/scanner/index';
import { runAdvisors } from '@modules/advisor/index';
import { applyOsvFixViaStaging } from './osv-fix-applier';

export interface OrchestratorOptions {
  configPath: string;
  cwd: string;
  dryRun: boolean;
  verbose: boolean;
  /**
   * Subset of phases to execute.
   * Plugin IDs (e.g. 'npm', 'composer') are accepted alongside 'scan' and 'report'.
   */
  phases?: string[];
  /**
   * Per-ecosystem authorization for breaking changes.
   * Ex: { npm: true, composer: false }
   */
  authorizeBreaking?: Record<string, boolean>;
  /**
   * Override the ecosystem registry (useful for testing).
   * Defaults to defaultRegistry (which has npm + composer registered).
   */
  registry?: EcosystemRegistry;
  /**
   * Override the scanner engine registry (useful for testing).
   * Defaults to defaultScannerRegistry (OSV + SonarQube registered).
   */
  scannerRegistry?: ScannerEngineRegistry;
}

export interface OrchestratorResult {
  scan: ScanResultJson | null;
  /** Update results keyed by plugin id (e.g. 'npm', 'composer') */
  updates: Record<string, UpdateResultJson>;
  overallStatus: PhaseStatus;
  /**
   * True when there are pending vulnerabilities (breaking or manual) after the pipeline run.
   * Does NOT imply a crash or gate failure — consumers should check this separately from overallStatus.
   */
  hasPendingVulns: boolean;
  /**
   * Non-fatal engine warnings accumulated during the pipeline run.
   * Populated when a secondary scanner (e.g. SonarQube with on_failure=warn)
   * fails but the pipeline continues.
   */
  warnings: EngineWarning[];
  /**
   * Aggregated scan result from all engines.
   * Consumers needing per-engine raw results can use this field.
   * The `primary` subfield is always the OSV result (Gate A source of truth).
   */
  aggregated?: AggregatedScanResult;
  /**
   * Advisor results keyed by ecosystem id.
   * Advisors are informational only — they never block the pipeline.
   */
  advisorResults: Record<string, AdvisorResult[]>;
}

function shouldRunPhase(phase: string, options: OrchestratorOptions): boolean {
  if (!options.phases) return true;
  return options.phases.includes(phase);
}

/**
 * Resolve the on_failure policy for a secondary engine.
 *
 * Uses a generic lookup into config.scanners by engine id.
 * Each engine config block that exposes an `on_failure` field is consulted.
 * - 'sonarqube': reads config.scanners.sonarqube.on_failure (defaults to 'warn').
 * - Any engine id whose config block has an `on_failure` field: uses that value.
 * - Any engine id with no config or no `on_failure` field: defaults to 'fail' (safe hardening).
 *
 * Rationale for the 'fail' default for unknowns: an unrecognised engine has no
 * config key, so silently swallowing its failure could mask integration bugs or
 * misconfiguration. Failing loudly is the safe choice.
 */
function resolveOnFailure(engineId: string, config: ProjectConfig): 'warn' | 'fail' {
  const scanners = config.scanners;
  if (!scanners) {
    logger.debug(
      `Engine "${engineId}": no scanners config found — defaulting on_failure to "fail".`,
    );
    return 'fail';
  }

  // Generic lookup: find the engine config block by id and read on_failure if present
  for (const [key, engineConfig] of Object.entries(scanners)) {
    if (key === engineId && engineConfig && typeof engineConfig === 'object' && 'on_failure' in engineConfig) {
      const onFailure = (engineConfig as { on_failure?: 'warn' | 'fail' }).on_failure;
      return onFailure ?? 'fail';
    }
  }

  // Unknown secondary engine or engine config has no on_failure — fail by default (safe hardening)
  logger.warn(
    `Engine "${engineId}" is not a recognised secondary engine or has no on_failure config. ` +
    `Defaulting on_failure to "fail" for safety. ` +
    `Add explicit config for this engine to override.`,
  );
  return 'fail';
}

/**
 * Run all registered scanner engines sequentially.
 *
 * - The OSV engine (id === OSV_ENGINE_ID) is the primary — its result drives Gate A.
 *   Primary classification is by engine id, not by registration order.
 * - Subsequent engines (e.g. SonarQube) are secondary:
 *   - If they fail (throw OR return status='error') and on_failure='warn':
 *     emit a warning, continue.
 *   - If they fail (throw OR return status='error') and on_failure='fail':
 *     throw an error.
 * - A 'skipped' status result from a secondary engine is silently accepted.
 */
async function runAllEngines(
  engineRegistry: ScannerEngineRegistry,
  ctx: ScannerEngineContext,
  config: ProjectConfig,
): Promise<{ engineEntries: Array<{ engineId: string; result: ScanResultJson }>; warnings: EngineWarning[] }> {
  const engines = engineRegistry.getAll();
  const engineEntries: Array<{ engineId: string; result: ScanResultJson }> = [];
  const warnings: EngineWarning[] = [];

  for (const engine of engines) {
    // Primary classification is by engine id — not by registration order.
    const isPrimary = engine.id === OSV_ENGINE_ID;

    let result: ScanResultJson;
    try {
      result = await engine.scan(ctx);
    } catch (err) {
      if (isPrimary) {
        // Primary engine (OSV) failure is always fatal — re-throw immediately
        throw err;
      }

      // Secondary engine threw — check on_failure config
      const onFailure = resolveOnFailure(engine.id, config);
      const message = err instanceof Error ? err.message : String(err);

      if (onFailure === 'fail') {
        logger.error(`${engine.name}: scan failed (on_failure=fail) — ${message}`);
        throw err;
      }

      // on_failure='warn' — record warning and continue
      logger.warn(`${engine.name}: scan failed (on_failure=warn) — ${message}`);
      warnings.push({ engineId: engine.id, message });
      continue;
    }

    // Engine returned a result — check if it encoded a failure via status='error'
    if (result.status === 'error' && !isPrimary) {
      const onFailure = resolveOnFailure(engine.id, config);
      const message = result.error ?? `${engine.name} scan returned status 'error'`;

      if (onFailure === 'fail') {
        logger.error(`${engine.name}: scan result is error (on_failure=fail) — ${message}`);
        throw new Error(message);
      }

      // on_failure='warn' — record warning and continue (do not include errored result)
      logger.warn(`${engine.name}: scan result is error (on_failure=warn) — ${message}`);
      warnings.push({ engineId: engine.id, message });
      continue;
    }

    engineEntries.push({ engineId: engine.id, result });
  }

  return { engineEntries, warnings };
}

/**
 * Resolve the npm container runner based on config.
 * Dispatched by plugin.runtimeContainer === 'npm-docker'.
 *
 * - 'docker' (default): create NpmDockerRunner using inferred/configured node version.
 * - 'local': use local npm (return base runner); emit a warning.
 * - 'auto': try docker if available; emit a warning about deprecation.
 *
 * @param inferVersion Optional function to infer node version from project files.
 *                     Provided by the orchestrator from the npm plugin's inferVersion hook.
 */
async function resolveNpmContainerRunner(
  config: ProjectConfig,
  cwd: string,
  runner: CommandRunner,
  inferVersion?: (cwd: string) => Promise<string | undefined>,
): Promise<CommandRunner> {
  const npmRunnerConfig = config.scanners?.npm;
  const mode = npmRunnerConfig?.mode ?? 'docker';

  if (mode === 'local') {
    logger.warn(
      '[npm runner] mode=local: using local npm binary. ' +
      'Docker (mode: docker) is the recommended default for reproducible, ' +
      'platform-independent npm updates. Set scanners.npm.mode to "docker" in your config.',
    );
    return runner;
  }

  if (mode === 'auto') {
    logger.warn(
      '[npm runner] mode=auto is a deprecated escape hatch. ' +
      'Docker (mode: docker) is now the default for npm. ' +
      'Set scanners.npm.mode explicitly to "docker" or "local" in your config.',
    );
    // auto: fall through to docker (docker is the preferred path)
  }

  // Resolve explicit image or infer from node version
  let image = npmRunnerConfig?.image;
  if (!image) {
    // Precedence for node version:
    // 1) scanners.npm.runtime_version (explicit config)
    // 2) inferVersion() from the npm plugin (project file inference)
    // 3) resolveNpmDockerImage fallback → 'node:lts'
    let nodeVersion: string | undefined = npmRunnerConfig?.runtime_version;

    if (!nodeVersion && inferVersion) {
      try {
        nodeVersion = await inferVersion(cwd);
        if (nodeVersion) {
          logger.info(`[npm runner] Inferred Node version: ${nodeVersion} → resolving Docker image`);
        }
      } catch {
        // inferVersion must never throw — defensive guard
      }
    } else if (nodeVersion) {
      logger.info(`[npm runner] Using configured runtime_version: ${nodeVersion} → resolving Docker image`);
    }

    image = resolveNpmDockerImage(nodeVersion);
  }

  logger.info(`[npm runner] Using Docker image: ${image}`);
  const npmDockerRunner = new NpmDockerRunner({ projectDir: cwd, image });
  return new NpmContainerCommandRunner({
    container: npmDockerRunner,
    fallback: runner,
    dryRun: runner.dryRun,
  });
}

/**
 * Resolve the pip container runner based on config.
 * Dispatched by plugin.runtimeContainer === 'pip-docker'.
 *
 * - 'docker' (default): create PipDockerRunner using inferred/configured python version.
 * - 'local': use local pip (return base runner); emit a warning.
 * - 'auto': try docker if available; emit a warning about deprecation.
 *
 * @param inferVersion Optional function to infer python version from project files.
 *                     Provided by the orchestrator from the pip plugin's inferVersion hook.
 */
async function resolvePipContainerRunner(
  config: ProjectConfig,
  cwd: string,
  runner: CommandRunner,
  inferVersion?: (cwd: string) => Promise<string | undefined>,
): Promise<CommandRunner> {
  const pipRunnerConfig = config.scanners?.pip;
  const mode = pipRunnerConfig?.mode ?? 'docker';

  if (mode === 'local') {
    logger.warn(
      '[pip runner] mode=local: using local pip binary. ' +
      'Docker (mode: docker) is the recommended default for reproducible, ' +
      'platform-independent pip updates. Set scanners.pip.mode to "docker" in your config.',
    );
    return runner;
  }

  if (mode === 'auto') {
    logger.warn(
      '[pip runner] mode=auto is a deprecated escape hatch. ' +
      'Docker (mode: docker) is now the default for pip. ' +
      'Set scanners.pip.mode explicitly to "docker" or "local" in your config.',
    );
    // auto: fall through to docker (docker is the preferred path)
  }

  // Resolve explicit image or infer from python version
  let image = pipRunnerConfig?.image;
  if (!image) {
    // Precedence for python version:
    // 1) scanners.pip.runtime_version (explicit config)
    // 2) inferVersion() from the pip plugin (project file inference)
    // 3) resolvePipDockerImage fallback → 'python:3-slim'
    let pythonVersion: string | undefined = pipRunnerConfig?.runtime_version;

    if (!pythonVersion && inferVersion) {
      try {
        pythonVersion = await inferVersion(cwd);
        if (pythonVersion) {
          logger.info(`[pip runner] Inferred Python version: ${pythonVersion} → resolving Docker image`);
        }
      } catch {
        // inferVersion must never throw — defensive guard
      }
    } else if (pythonVersion) {
      logger.info(`[pip runner] Using configured runtime_version: ${pythonVersion} → resolving Docker image`);
    }

    image = resolvePipDockerImage(pythonVersion);
  }

  logger.info(`[pip runner] Using Docker image: ${image}`);
  const pipDockerRunner = new PipDockerRunner({ projectDir: cwd, image });
  return new PipContainerCommandRunner({
    container: pipDockerRunner,
    fallback: runner,
    dryRun: runner.dryRun,
  });
}

/**
 * Resolve a dedicated CommandRunner for OSV commands based on config.
 *
 * When the effective OSV runner mode is 'docker', returns an OsvContainerCommandRunner
 * that routes osv-scanner commands to an ephemeral OsvDockerRunner container.
 * Returns undefined for 'local' mode or when Docker is not configured.
 * Always creates a read-only runner (for scan/verify operations).
 */
function resolveOsvCommandRunner(
  config: ProjectConfig,
  cwd: string,
  fallback: CommandRunner,
  dryRun: boolean,
): CommandRunner {
  const osvConfig = config.scanners?.osv;
  const mode = osvConfig?.runner ?? 'docker';

  if (mode === 'local') {
    // Local mode: use fallback (local runner) directly for OSV commands
    logger.debug('[OSV runner] mode=local: using local runner for OSV commands');
    return fallback;
  }

  // docker or auto: use OsvDockerRunner-backed OsvContainerCommandRunner
  const image = osvConfig?.image;
  const osvDockerRunner = new OsvDockerRunner({ projectDir: cwd, image, readonly: true });

  logger.info(
    `[OSV runner] Dedicated OSV container runner (mode: ${mode}, mount: read-only${image ? `, image: ${image}` : ''})`,
  );

  return new OsvContainerCommandRunner({
    container: osvDockerRunner,
    fallback,
    dryRun,
  });
}

/**
 * Run residual OSV scan verification after updates are applied.
 * Best-effort: logs a warning on failure but does not abort the pipeline.
 */
async function runOsvResidualVerification(osvRunner: CommandRunner, cwd: string, dryRun: boolean, command: string): Promise<void> {
  if (dryRun) {
    logger.info(`[DRY-RUN] Would execute: ${command}`);
    return;
  }
  logger.info(`[OSV verify] Running post-update OSV verification: ${command}`);
  try {
    await osvRunner.run(command, { cwd });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[OSV verify] Post-update OSV verification failed (non-fatal): ${message}`);
  }
}

export async function runOrchestrator(
  runner: CommandRunner,
  config: ProjectConfig,
  options: OrchestratorOptions,
): Promise<OrchestratorResult> {
  const result: OrchestratorResult = {
    scan: null,
    updates: {},
    overallStatus: 'success',
    hasPendingVulns: false,
    warnings: [],
    advisorResults: {},
  };

  // Scan — hard precondition for all update steps
  if (!shouldRunPhase('scan', options)) {
    logger.warn('Skipping scan phase — phases option does not include "scan"');
    result.overallStatus = 'skipped';
    return result;
  }

  logger.info('=== Vulnerability Scan ===');

  const ecosystemRegistry = options.registry ?? defaultRegistry;
  const engineRegistry = options.scannerRegistry ?? defaultScannerRegistry;

  // Ensure default engines are registered when using the default registry.
  // When a caller injects a custom scannerRegistry (e.g. tests), they are
  // responsible for populating it — we must NOT auto-populate it here.
  if (!options.scannerRegistry) {
    bootstrapDefaultEngines(engineRegistry);
  }

  // OSV disable guard: if OSV engine is not in registry, block update/fix flow
  if (!engineRegistry.has('osv')) {
    throw new Error(
      'OSV scanner engine is not registered. ' +
      'The OSV engine is required for automatic update/fix flow. ' +
      'Register an OsvScannerEngine with id "osv" before running the orchestrator.',
    );
  }

  // Detect git branch once before building the scan context.
  // Never throws — returns null when branch cannot be determined.
  const branch = await detectGitBranch(options.cwd, runner);
  if (branch) {
    logger.info(`Detected git branch: ${branch}`);
  }

  const ctx: ScannerEngineContext = {
    runner,
    config,
    cwd: options.cwd,
    ecosystemRegistry,
    branch,
  };

  // Run all scanner engines; collect results + warnings
  const { engineEntries, warnings } = await runAllEngines(engineRegistry, ctx, config);
  result.warnings = warnings;

  // Aggregate: primary is always first engine (OSV); secondary results go into engineResults
  const aggregated = aggregateScanResults(engineEntries, warnings);
  result.aggregated = aggregated;

  // Gate A always uses the OSV (primary) result
  const scanResult = aggregated.primary;
  result.scan = scanResult;

  // Gate A validation
  const gateA = validateGateA(scanResult);
  if (!gateA.valid) {
    throw new GateValidationError(
      `Gate A validation failed: ${gateA.errors.join(', ')}`,
      'A',
      gateA.errors,
    );
  }

  // Build a summary log using registered ecosystem results
  const ecosystemSummaryParts = Object.entries(scanResult.ecosystems).map(([id, e]) =>
    `${e.vulnerabilities_total} ${id} vulns (${e.auto_safe} auto-safe, ${e.breaking} breaking)`,
  );
  logger.info(`Scan complete: ${ecosystemSummaryParts.join(', ') || 'no vulnerabilities found'}`);

  // Resolve active plugins from declarative config.ecosystems[]
  const activePlugins = ecosystemRegistry.getAll().filter((p) =>
    config.ecosystems.some((e) => e.id === p.id),
  );

  // Iterate over active plugins in registration order (npm → composer)
  for (const plugin of activePlugins) {
    if (!shouldRunPhase(plugin.id, options)) {
      logger.info(`Phase: Skipping ${plugin.name} — not in phases list`);
      continue;
    }

    // Resolve per-ecosystem config entry
    const ecoConfigEntry = config.ecosystems.find((e) => e.id === plugin.id);

    // Resolve validation commands: config override → plugin defaults
    const validationCommands =
      ecoConfigEntry?.validationCommands ?? plugin.defaultValidationCommands;

    // Resolve fixer strategy: config override → first supported fixer → 'osv' (npm) or plugin-specific
    const fixerStrategy: FixerStrategyId =
      ecoConfigEntry?.fixer ??
      (plugin.supportedFixers.length > 0 ? plugin.supportedFixers[0] : 'osv') as FixerStrategyId;

    // Resolve advisors: config override → plugin defaults
    const advisors = ecoConfigEntry?.advisors ?? plugin.defaultAdvisors;

    // Run advisors (informational only — never throws, never blocks pipeline)
    if (advisors.length > 0) {
      logger.info(`[Advisor Step] Running advisors for ${plugin.name}...`);
      result.advisorResults[plugin.id] = await runAdvisors(
        runner,
        options.cwd,
        plugin.id,
        advisors,
      );
    }

    const ecosystemResult = scanResult.ecosystems[plugin.id];
    const authorizeBreaking = options.authorizeBreaking?.[plugin.id] ?? false;
    const hasUpdates =
      ecosystemResult &&
      (ecosystemResult.auto_safe > 0 || (authorizeBreaking && ecosystemResult.breaking > 0));

    if (!hasUpdates) {
      logger.info(`Phase: Skipping ${plugin.name} — no auto-safe vulnerabilities`);
      continue;
    }

    logger.info(`=== Phase: ${plugin.name} Updates ===`);

    // Resolve effective runner by runtimeContainer tag (not by plugin.id)
    let effectiveRunner: CommandRunner = runner;
    if (plugin.runtimeContainer === 'npm-docker') {
      effectiveRunner = await resolveNpmContainerRunner(config, options.cwd, runner, plugin.inferVersion?.bind(plugin));
    } else if (plugin.runtimeContainer === 'pip-docker') {
      effectiveRunner = await resolvePipContainerRunner(config, options.cwd, runner, plugin.inferVersion?.bind(plugin));
    }

    // OSV staging-apply (generic, driven by plugin.osvFixSpec)
    let preFixBackups: Map<string, string> | undefined;
    let osvFixOutcome: { applied: boolean; packagesUpdated: Array<{ name: string; versionFrom: string; versionTo: string }> } | undefined;

    if (fixerStrategy === 'osv' && plugin.osvFixSpec) {
      const fixResult = await applyOsvFixViaStaging({
        cwd: options.cwd,
        osvConfig: config.scanners?.osv,
        osvFixSpec: plugin.osvFixSpec,
        dryRun: options.dryRun ?? false,
      });
      preFixBackups = fixResult.backups;
      osvFixOutcome = { applied: fixResult.applied, packagesUpdated: fixResult.packagesUpdated };
    }

    const updateResult = await plugin.runUpdater({
      runner: effectiveRunner,
      config,
      scanResult,
      cwd: options.cwd,
      authorizeBreaking,
      validationCommands,
      fixerStrategy,
      preFixBackups,
      osvFixOutcome,
    });

    // === Post-updater: Breaking packages install (generic, via plugin hook) ===
    if (plugin.installBreakingPackages && authorizeBreaking && updateResult.status !== 'error') {
      const breakRes = await plugin.installBreakingPackages({
        runner: effectiveRunner,
        cwd: options.cwd,
        scanResult,
        dryRun: options.dryRun,
        fixerStrategy,
      });
      if (breakRes?.status === 'error') {
        result.updates[plugin.id] = { ...updateResult, status: 'error', error: breakRes.error ?? 'breaking install failed' };
        result.overallStatus = 'error';
        break;
      }
    }

    // === Post-updater: OSV residual verification (generic, driven by plugin.postUpdateOsvVerify) ===
    const shouldOsvVerify =
      updateResult.status !== 'error' &&
      (plugin.postUpdateOsvVerify === 'always' ||
        (plugin.postUpdateOsvVerify === 'osv-strategy-only' && fixerStrategy === 'osv'));

    if (shouldOsvVerify) {
      const osvVerifyRunner = resolveOsvCommandRunner(config, options.cwd, runner, false);
      const osvVerifyMode = config.scanners?.osv?.runner ?? 'docker';
      if (osvVerifyMode === 'local') {
        logger.info('[OSV verify] Using local osv-scanner binary for residual verification');
      } else {
        logger.info('[OSV verify] Using OSV container runner with read-only mount for residual verification');
      }
      const verifyScanArgs = plugin.buildScanArgs();
      const verifyCmd = `osv-scanner ${verifyScanArgs.join(' ')} --format json`;
      await runOsvResidualVerification(osvVerifyRunner, options.cwd, options.dryRun, verifyCmd);
    }

    result.updates[plugin.id] = updateResult;

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
      result.overallStatus = 'error';
      break;
    }

    logger.info(
      `${plugin.name} update complete: ${updateResult.packages_updated.length} packages updated`,
    );
  }

  // Check if there are pending items (breaking or manual vulns still unresolved)
  const hasPendingItems = Object.values(scanResult.ecosystems).some(
    (e) => e.breaking > 0 || e.manual > 0,
  );

  result.hasPendingVulns = hasPendingItems;

  return result;
}
