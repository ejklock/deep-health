import type { CommandRunner, PhaseStatus } from '../types/common.js';
import type { ProjectConfig } from '../types/config.js';
import type { ScanResultJson } from '../types/scan.js';
import type { UpdateResultJson } from '../types/update.js';
import type { EngineWarning } from '../scanner/types.js';
import { validateGateA, validateEcosystemGate } from '../gates/validator.js';
import { GateValidationError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { runScanner } from './scanner.js';
// Ecosystem registry — plugins are registered via ecosystem/index.ts side-effects
import { EcosystemRegistry, defaultRegistry } from '../ecosystem/index.js';
// Scanner registry — engines are registered via scanner/index.ts side-effects
import '../scanner/index.js';

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
  executiveReport?: {
    client: string;
    project: string;
  };
}

export interface OrchestratorResult {
  scan: ScanResultJson | null;
  /** Update results keyed by plugin id (e.g. 'npm', 'composer') */
  updates: Record<string, UpdateResultJson>;
  overallStatus: PhaseStatus;
  /**
   * Non-fatal engine warnings accumulated during the pipeline run.
   * Phase 0: always empty. Prepared for SonarQube warn-only policy in Phase 1+.
   */
  warnings: EngineWarning[];
}

function shouldRunPhase(phase: string, options: OrchestratorOptions): boolean {
  if (!options.phases) return true;
  return options.phases.includes(phase);
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
  };

  // Phase 1 — Scan (hard precondition)
  if (!shouldRunPhase('scan', options)) {
    logger.warn('Skipping scan phase — phases option does not include "scan"');
    result.overallStatus = 'skipped';
    return result;
  }

  logger.info('=== Phase 1: Vulnerability Scan ===');
  const registry = options.registry ?? defaultRegistry;
  const scanResult = await runScanner(runner, config, options.cwd, registry);
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

  const activePlugins = registry.getActive(config);

  // Iterate over active plugins in registration order (npm → composer)
  for (const plugin of activePlugins) {
    if (!shouldRunPhase(plugin.id, options)) {
      logger.info(`Phase: Skipping ${plugin.name} — not in phases list`);
      continue;
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
