import type { CommandRunner, PhaseStatus } from "@core/types/common";
import type { ProjectConfig } from "@core/types/config";
import type { ScanResultJson } from "@core/types/scan";
import type { UpdateResultJson } from "@core/types/update";
import type { AdvisorResult, ResidualVerification } from "@core/types/report";
import type {
  EngineWarning,
  ScannerEngineContext,
} from "@modules/scanner/types";
import { validateGateA } from "@core/gates/validator";
import { GateValidationError } from "@core/errors";
import { logger } from "@infra/utils/logger";
import { detectGitBranch } from "@infra/utils/git-branch";
import type { RendererType } from "@app/progress-reporter";
// Ecosystem registry — plugins are registered via modules/ecosystem/index.ts side-effects
import { EcosystemRegistry, defaultRegistry } from "@modules/ecosystem/index";
// Scanner registry — engines are bootstrapped lazily via bootstrapDefaultEngines()
import {
  defaultScannerRegistry,
  ScannerEngineRegistry,
  aggregateScanResults,
  OSV_ENGINE_ID,
  bootstrapDefaultEngines,
  executeScannerSweep,
  PrimaryEngineFailure,
  listr2ScannerSweepRenderer,
} from "@modules/scanner/index";
import type { AggregatedScanResult } from "@modules/scanner/index";
import { runAdvisors } from "@modules/advisor/index";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runEcosystemFix } from "./run-ecosystem-fix";

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
  /**
   * Listr2 renderer type to use for the scan progress display.
   * Defaults to 'default'.
   */
  rendererType?: RendererType;
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
  /**
   * Residual OSV verification outcome (typed union).
   */
  residualVerification?: ResidualVerification;
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
function resolveOnFailure(
  engineId: string,
  config: ProjectConfig,
): "warn" | "fail" {
  const scanners = config.scanners;
  if (!scanners) {
    logger.debug(
      `Engine "${engineId}": no scanners config found — defaulting on_failure to "fail".`,
    );
    return "fail";
  }

  // Generic lookup: find the engine config block by id and read on_failure if present
  for (const [key, engineConfig] of Object.entries(scanners)) {
    if (
      key === engineId &&
      engineConfig &&
      typeof engineConfig === "object" &&
      "on_failure" in engineConfig
    ) {
      const onFailure = (engineConfig as { on_failure?: "warn" | "fail" })
        .on_failure;
      return onFailure ?? "fail";
    }
  }

  // Unknown secondary engine or engine config has no on_failure — fail by default (safe hardening)
  logger.warn(
    `Engine "${engineId}" is not a recognised secondary engine or has no on_failure config. ` +
      `Defaulting on_failure to "fail" for safety. ` +
      `Add explicit config for this engine to override.`,
  );
  return "fail";
}

export async function runOrchestrator(
  runner: CommandRunner,
  config: ProjectConfig,
  options: OrchestratorOptions,
): Promise<OrchestratorResult> {
  const result: OrchestratorResult = {
    scan: null,
    updates: {},
    overallStatus: "success",
    hasPendingVulns: false,
    warnings: [],
    advisorResults: {},
  };

  // Pre-run snapshots: capture package.json and package-lock.json before any mutations.
  // Used for dirty-tree detection after revert — if on-disk state differs after revert,
  // external changes during the run may have been lost (warn only, never fail).
  const preRunSnapshots = new Map<string, string>();
  for (const filename of ['package.json', 'package-lock.json']) {
    try {
      const content = await readFile(join(options.cwd, filename), 'utf-8');
      preRunSnapshots.set(filename, content as string);
    } catch {
      logger.tagged('pre-run', 'pre-run', `Could not read ${filename} — skipping pre-run snapshot`, 'debug');
    }
  }

  // Scan — hard precondition for all update steps
  if (!shouldRunPhase("scan", options)) {
    logger.warn('Skipping scan phase — phases option does not include "scan"');
    result.overallStatus = "skipped";
    return result;
  }

  logger.phase('Vulnerability Scan');

  const ecosystemRegistry = options.registry ?? defaultRegistry;
  const engineRegistry = options.scannerRegistry ?? defaultScannerRegistry;

  // Ensure default engines are registered when using the default registry.
  // When a caller injects a custom scannerRegistry (e.g. tests), they are
  // responsible for populating it — we must NOT auto-populate it here.
  if (!options.scannerRegistry) {
    bootstrapDefaultEngines(engineRegistry);
  }

  const primaryEngineId = config.scanners?.primary ?? OSV_ENGINE_ID;
  if (!engineRegistry.has(primaryEngineId)) {
    throw new Error(
      `Primary scanner engine "${primaryEngineId}" is not registered. ` +
      `Register an engine with id "${primaryEngineId}" before running the orchestrator. ` +
      `Available engines: [${engineRegistry.getAll().map((e) => e.id).join(', ')}]`,
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

  // Run all scanner engines via the Scanner Sweep module; collect results + warnings.
  // The orchestrator is config-aware (it builds the policy callback), but the sweep
  // module itself is config-agnostic.
  //
  // On PrimaryEngineFailure: preserve partialWarnings from secondary engines that
  // ran before the primary failed (otherwise already-paid work is silently discarded),
  // then re-throw the original cause to preserve today's observable behaviour.
  let engineEntries: Array<{ engineId: string; result: ScanResultJson }>;
  let warnings: EngineWarning[];
  try {
    const sweep = await executeScannerSweep(
      engineRegistry.getAll(),
      ctx,
      {
        primaryEngineId,
        resolveOnFailure: (id) => resolveOnFailure(id, config),
      },
      listr2ScannerSweepRenderer(options.rendererType ?? 'default'),
    );
    engineEntries = sweep.engineEntries;
    warnings = sweep.warnings;
  } catch (err) {
    if (err instanceof PrimaryEngineFailure) {
      // Preserve partial warnings from secondary engines that ran before primary failed
      result.warnings = err.partialWarnings;
      // Re-throw the original cause — preserves the error the orchestrator's callers expect
      throw err.cause instanceof Error ? err.cause : new Error(String(err.cause));
    }
    throw err;
  }
  result.warnings = warnings;

  // Aggregate: primary engine result drives Gate A; secondary results go into engineResults
  const aggregated = aggregateScanResults(engineEntries, warnings, primaryEngineId);
  result.aggregated = aggregated;

  // Gate A always uses the primary engine result
  const scanResult = aggregated.primary;
  result.scan = scanResult;

  // Gate A validation
  const gateA = validateGateA(scanResult);
  if (!gateA.valid) {
    throw new GateValidationError(
      `Gate A validation failed: ${gateA.errors.join(", ")}`,
      "A",
      gateA.errors,
    );
  }

  // Build a summary log using registered ecosystem results
  const ecosystemSummaryParts = Object.entries(scanResult.ecosystems).map(
    ([id, e]) =>
      `${e.vulnerabilities_total} ${id} vulns (${e.auto_safe} auto-safe, ${e.breaking} breaking)`,
  );
  logger.info(
    `Scan complete: ${ecosystemSummaryParts.join(", ") || "no vulnerabilities found"}`,
  );

  // Resolve active plugins from declarative config.ecosystems[]
  const activePlugins = ecosystemRegistry
    .getAll()
    .filter((p) => config.ecosystems.some((e) => e.id === p.id));

  // Kill-switch: skip all automated fixes when DEEP_HEALTH_NO_AUTO_FIX is set
  if (process.env['DEEP_HEALTH_NO_AUTO_FIX']) {
    logger.warn(
      '[deep-health] DEEP_HEALTH_NO_AUTO_FIX is set — skipping all automated fixes. ' +
      'Scan results are available but no files have been modified. ' +
      'Unset DEEP_HEALTH_NO_AUTO_FIX to re-enable automated remediation.',
    );
    result.hasPendingVulns = Object.values(scanResult.ecosystems).some(
      (e) => e.breaking > 0 || e.manual > 0,
    );
    return result;
  }

  // Iterate over active plugins in registration order (npm → composer)
  for (const plugin of activePlugins) {
    if (!shouldRunPhase(plugin.id, options)) {
      logger.info(`Phase: Skipping ${plugin.name} — not in phases list`);
      continue;
    }

    // Run advisors (informational only — never throws, never blocks pipeline).
    // Kept outside runEcosystemFix so they fire even when the plugin would skip
    // due to no auto-safe vulnerabilities.
    const ecoConfigEntry = config.ecosystems.find((e) => e.id === plugin.id);
    const advisors = ecoConfigEntry?.advisors ?? plugin.defaultAdvisors;
    if (advisors.length > 0) {
      logger.tagged(plugin.id, 'Advisor Step', `Running advisors for ${plugin.name}...`);
      result.advisorResults[plugin.id] = await runAdvisors(
        runner,
        options.cwd,
        plugin.id,
        advisors,
      );
    }

    const authorizeBreaking = options.authorizeBreaking?.[plugin.id] ?? false;

    const outcome = await runEcosystemFix({
      plugin,
      hostRunner: runner,
      config,
      scanResult,
      cwd: options.cwd,
      dryRun: options.dryRun,
      authorizeBreaking,
      preRunSnapshots,
    });

    if (outcome.status === "skipped") continue;

    result.updates[plugin.id] = outcome.updateResult;
    if (outcome.status === "success" && outcome.residualVerification) {
      result.residualVerification = outcome.residualVerification;
    }

    if (outcome.status === "error") {
      result.overallStatus = "error";
      break;
    }
  }

  // Check if there are pending items (breaking or manual vulns still unresolved)
  const hasPendingItems = Object.values(scanResult.ecosystems).some(
    (e) => e.breaking > 0 || e.manual > 0,
  );

  result.hasPendingVulns = hasPendingItems;

  return result;
}
