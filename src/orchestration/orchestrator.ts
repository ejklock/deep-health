import type { CommandRunner, PhaseStatus } from '@core/types/common';
import type { ProjectConfig, AdvisorConfig } from '@core/types/config';
import type { ScanResultJson } from '@core/types/scan';
import type { UpdateResultJson } from '@core/types/update';
import type { AdvisorResult } from '@core/types/report';
import type { EngineWarning, ScannerEngineContext } from '@modules/scanner/types';
import { validateGateA, validateEcosystemGate } from '@core/gates/validator';
import { GateValidationError } from '@core/errors';
import { logger } from '@infra/utils/logger';
// Ecosystem registry — plugins are registered via modules/ecosystem/index.ts side-effects
import { EcosystemRegistry, defaultRegistry } from '@modules/ecosystem/index';
// Scanner registry — engines are registered via modules/scanner/index.ts side-effects
import {
  defaultScannerRegistry,
  ScannerEngineRegistry,
  aggregateScanResults,
} from '@modules/scanner/index';
import type { AggregatedScanResult } from '@modules/scanner/index';

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
 * - 'sonarqube': reads from config.scanners.sonarqube (defaults to 'warn' when not set).
 * - 'osv': primary engine — should never be called as secondary; returns 'fail' as safe fallback.
 * - Any other engine id not in config.scanners: defaults to 'fail' (safe hardening).
 *
 * Rationale for the 'fail' default for unknowns: an unrecognised engine has no
 * config key, so silently swallowing its failure could mask integration bugs or
 * misconfiguration. Failing loudly is the safe choice.
 */
function resolveOnFailure(engineId: string, config: ProjectConfig): 'warn' | 'fail' {
  if (engineId === 'sonarqube') {
    return config.scanners?.sonarqube?.on_failure ?? 'warn';
  }
  // Unknown secondary engine — fail by default (safe hardening)
  logger.warn(
    `Engine "${engineId}" is not a recognised secondary engine. ` +
    `Defaulting on_failure to "fail" for safety. ` +
    `Add explicit config for this engine to override.`,
  );
  return 'fail';
}

/**
 * Run all registered scanner engines sequentially.
 *
 * - The first engine (OSV) is the primary — its result drives Gate A.
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
    const isPrimary = engineEntries.length === 0;

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
 * Run advisor commands for a single ecosystem (informational only — never throws).
 *
 * Advisors produce observability output but never affect the pipeline outcome.
 * Even if an advisor command fails (non-zero exit), the pipeline continues.
 */
async function runAdvisors(
  runner: CommandRunner,
  cwd: string,
  ecosystemId: string,
  advisors: AdvisorConfig[],
): Promise<AdvisorResult[]> {
  if (advisors.length === 0) return [];

  const results: AdvisorResult[] = [];

  for (const advisor of advisors) {
    logger.info(`[Advisor] ${ecosystemId}/${advisor.name}: ${advisor.command}`);
    try {
      const cmdResult = await runner.run(advisor.command, { cwd });
      const outputLines = cmdResult.stdout.trim().split('\n');
      const output = outputLines.slice(-20).join('\n'); // last 20 lines

      results.push({
        name: advisor.name,
        command: advisor.command,
        exitCode: cmdResult.exitCode,
        output,
        status: cmdResult.exitCode === 0 ? 'pass' : 'fail',
      });
    } catch (err) {
      // Advisor failure is always non-fatal
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[Advisor] ${ecosystemId}/${advisor.name} failed (non-fatal): ${message}`);
      results.push({
        name: advisor.name,
        command: advisor.command,
        exitCode: -1,
        output: message,
        status: 'fail',
      });
    }
  }

  return results;
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

  // OSV disable guard: if OSV engine is not in registry, block update/fix flow
  if (!engineRegistry.has('osv')) {
    throw new Error(
      'OSV scanner engine is not registered. ' +
      'The OSV engine is required for automatic update/fix flow. ' +
      'Register an OsvScannerEngine with id "osv" before running the orchestrator.',
    );
  }

  const ctx: ScannerEngineContext = {
    runner,
    config,
    cwd: options.cwd,
    ecosystemRegistry,
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

    // Resolve fixer strategy: config override → first supported fixer → 'osv'
    const fixerStrategy =
      ecoConfigEntry?.fixer ??
      (plugin.supportedFixers.length > 0 ? plugin.supportedFixers[0] : undefined);

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
    const updateResult = await plugin.runUpdater({
      runner,
      config,
      scanResult,
      cwd: options.cwd,
      authorizeBreaking,
      validationCommands,
      fixerStrategy,
    });

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

  if (hasPendingItems && result.overallStatus !== 'error') {
    result.overallStatus = 'error'; // exit code 1: vulns remain
  }

  return result;
}
