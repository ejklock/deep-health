import type { CommandRunner, PhaseStatus } from '@core/types/common';
import type { ProjectConfig, AdvisorConfig, FixerStrategyId } from '@core/types/config';
import type { ScanResultJson } from '@core/types/scan';
import { emptyEcosystem } from '@core/types/scan';
import type { UpdateResultJson } from '@core/types/update';
import type { AdvisorResult, AdvisorFinding } from '@core/types/report';
import type { EngineWarning, ScannerEngineContext } from '@modules/scanner/types';
import type { EphemeralContainerRunner } from '@infra/provisioner/types';
import { validateGateA, validateEcosystemGate } from '@core/gates/validator';
import { GateValidationError } from '@core/errors';
import { logger } from '@infra/utils/logger';
import { backupFiles } from '@infra/utils/git';
import { detectGitBranch } from '@infra/utils/git-branch';
import { NpmDockerRunner, resolveNpmDockerImage } from '@infra/provisioner/npm-runner';
import { OsvDockerRunner } from '@infra/provisioner/osv-runner';
import { NpmContainerCommandRunner } from '@infra/executor/npm-container-runner';
import { OsvContainerCommandRunner } from '@infra/executor/osv-container-runner';
// Ecosystem registry — plugins are registered via modules/ecosystem/index.ts side-effects
import { EcosystemRegistry, defaultRegistry } from '@modules/ecosystem/index';
// Scanner registry — engines are registered via modules/scanner/index.ts side-effects
import {
  defaultScannerRegistry,
  ScannerEngineRegistry,
  aggregateScanResults,
  OSV_ENGINE_ID,
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
 * Parse npm audit --json output into structured AdvisorFindings.
 *
 * npm audit JSON schema (v7+):
 * {
 *   vulnerabilities: {
 *     [packageName]: {
 *       name: string, severity: string, range: string,
 *       nodes: string[], fixAvailable: boolean | { name, version, ... },
 *       via: Array<string | { title, url, severity, range }>
 *     }
 *   }
 * }
 *
 * Returns an empty array when the structure is unrecognized (valid JSON, no vulnerabilities key).
 * Throws a SyntaxError when the raw string is not valid JSON so the caller can emit 'error' status.
 * @internal exported for unit testing only
 */
export function parseNpmAuditJson(raw: string): AdvisorFinding[] {
  // Let JSON.parse throw naturally — caller is responsible for catching and emitting 'error'.
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object') return [];

  const obj = parsed as Record<string, unknown>;
  const vulnerabilities = obj['vulnerabilities'];
  if (!vulnerabilities || typeof vulnerabilities !== 'object') return [];

  const findings: AdvisorFinding[] = [];
  for (const [pkgName, vuln] of Object.entries(vulnerabilities as Record<string, unknown>)) {
    if (!vuln || typeof vuln !== 'object') continue;
    const v = vuln as Record<string, unknown>;

    const severity = typeof v['severity'] === 'string' ? v['severity'] : 'unknown';
    const range = typeof v['range'] === 'string' ? v['range'] : undefined;

    // Extract a title from the first non-string via entry
    let title = 'Vulnerability';
    const via = v['via'];
    if (Array.isArray(via)) {
      for (const entry of via) {
        if (entry && typeof entry === 'object' && 'title' in entry && typeof (entry as Record<string, unknown>)['title'] === 'string') {
          title = (entry as Record<string, unknown>)['title'] as string;
          break;
        }
      }
    }

    // fixAvailable: false | true | { name, version, isSemVerMajor? }
    let fixAvailable: string | undefined;
    const fa = v['fixAvailable'];
    if (fa && typeof fa === 'object' && 'version' in fa && typeof (fa as Record<string, unknown>)['version'] === 'string') {
      fixAvailable = (fa as Record<string, unknown>)['version'] as string;
    }

    findings.push({ package: pkgName, severity, title, range, fixAvailable });
  }

  return findings;
}

/**
 * Run advisor commands for a single ecosystem (informational only — never throws).
 *
 * Advisors produce observability output but never affect the pipeline outcome.
 * Even if an advisor command fails (non-zero exit), the pipeline continues.
 *
 * Status semantics:
 * - 'clean':    command exited 0 and (for json format) produced no findings.
 * - 'findings': command completed (any exit code) and findings were detected.
 * - 'error':    command threw an exception or produced unparseable output for json format.
 * - 'skipped':  not currently used at runtime (reserved for config-level suppression).
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
    const isJsonFormat = advisor.format === 'json';

    try {
      const cmdResult = await runner.run(advisor.command, { cwd });
      const rawOutput = cmdResult.stdout.trim();

      if (isJsonFormat) {
        // Structured JSON advisor (e.g. npm audit --json)
        let findings: AdvisorFinding[];
        try {
          findings = parseNpmAuditJson(rawOutput);
        } catch (parseErr) {
          // Malformed / unparseable JSON → classify as error, not clean
          const parseMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
          logger.warn(`[Advisor] ${ecosystemId}/${advisor.name} JSON parse failed (non-fatal): ${parseMsg}`);
          results.push({
            name: advisor.name,
            command: advisor.command,
            exitCode: cmdResult.exitCode,
            output: rawOutput.slice(0, 200),
            status: 'error',
          });
          continue;
        }
        const hasFindings = findings.length > 0;

        results.push({
          name: advisor.name,
          command: advisor.command,
          exitCode: cmdResult.exitCode,
          output: '',
          status: hasFindings ? 'findings' : 'clean',
          findings,
        });
      } else {
        // Plain text advisor
        const outputLines = rawOutput.split('\n');
        const output = outputLines.slice(-20).join('\n');
        results.push({
          name: advisor.name,
          command: advisor.command,
          exitCode: cmdResult.exitCode,
          output,
          status: cmdResult.exitCode === 0 ? 'clean' : 'findings',
        });
      }
    } catch (err) {
      // Advisor failure is always non-fatal
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[Advisor] ${ecosystemId}/${advisor.name} failed (non-fatal): ${message}`);
      results.push({
        name: advisor.name,
        command: advisor.command,
        exitCode: -1,
        output: message,
        status: 'error',
      });
    }
  }

  return results;
}

/**
 * Resolve the npm container runner based on config.
 *
 * - 'docker' (default): create NpmDockerRunner using inferred/configured node version.
 * - 'local': use local npm (return undefined — no container); emit a warning.
 * - 'auto': try docker if available; emit a warning about deprecation.
 */
async function resolveNpmContainerRunner(
  config: ProjectConfig,
  cwd: string,
  ecosystemRegistry: EcosystemRegistry,
): Promise<EphemeralContainerRunner<string[]> | undefined> {
  const npmRunnerConfig = config.scanners?.npm;
  const mode = npmRunnerConfig?.mode ?? 'docker';

  if (mode === 'local') {
    logger.warn(
      '[npm runner] mode=local: using local npm binary. ' +
      'Docker (mode: docker) is the recommended default for reproducible, ' +
      'platform-independent npm updates. Set scanners.npm.mode to "docker" in your config.',
    );
    return undefined;
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
    // 3) resolveNpmDockerImage fallback → 'node:lts-slim'
    let nodeVersion: string | undefined = npmRunnerConfig?.runtime_version;

    if (!nodeVersion) {
      // Attempt to infer node version from the npm plugin
      const npmPlugin = ecosystemRegistry.getAll().find((p) => p.id === 'npm');
      if (npmPlugin?.inferVersion) {
        try {
          nodeVersion = await npmPlugin.inferVersion(cwd);
          if (nodeVersion) {
            logger.info(`[npm runner] Inferred Node version: ${nodeVersion} → resolving Docker image`);
          }
        } catch {
          // inferVersion must never throw — defensive guard
        }
      }
    } else {
      logger.info(`[npm runner] Using configured runtime_version: ${nodeVersion} → resolving Docker image`);
    }

    image = resolveNpmDockerImage(nodeVersion);
  }

  logger.info(`[npm runner] Using Docker image: ${image}`);
  return new NpmDockerRunner({ projectDir: cwd, image });
}

/**
 * Resolve a dedicated CommandRunner for OSV commands based on config.
 *
 * When the effective OSV runner mode is 'docker', returns an OsvContainerCommandRunner
 * that routes osv-scanner commands to an ephemeral OsvDockerRunner container.
 * Returns undefined for 'local' mode or when Docker is not configured.
 */
function resolveOsvCommandRunner(
  config: ProjectConfig,
  cwd: string,
  fallback: CommandRunner,
  dryRun: boolean,
  readonly = true,
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
  const mountMode = readonly ? 'read-only' : 'read-write';
  const osvDockerRunner = new OsvDockerRunner({ projectDir: cwd, image, readonly });

  logger.info(
    `[OSV runner] Dedicated OSV container runner (mode: ${mode}, mount: ${mountMode}${image ? `, image: ${image}` : ''})`,
  );

  return new OsvContainerCommandRunner({
    container: osvDockerRunner,
    fallback,
    dryRun,
  });
}

/** npm files that must be backed up before any fixer mutates them */
const NPM_FILES = ['package.json', 'package-lock.json'];

/** osv-scanner in-place fix command for npm lockfile */
const OSV_FIX_NPM = 'osv-scanner fix --strategy=in-place -L package-lock.json';

/** osv-scanner post-update residual verification scan for npm lockfile */
const OSV_SCAN_NPM = 'osv-scanner --lockfile package-lock.json --format json';

/**
 * Run `osv-scanner fix` for npm lockfile using the dedicated OSV runner.
 * Best-effort: logs a warning on non-zero exit but does not abort the pipeline.
 */
async function runOsvFix(osvRunner: CommandRunner, cwd: string, dryRun: boolean): Promise<void> {
  if (dryRun) {
    logger.info(`[DRY-RUN] Would execute: ${OSV_FIX_NPM}`);
    return;
  }
  logger.info(`[OSV fix] Applying OSV in-place fix: ${OSV_FIX_NPM}`);
  const result = await osvRunner.run(OSV_FIX_NPM, { cwd, stream: true });
  if (result.exitCode !== 0) {
    logger.warn(`[OSV fix] osv-scanner fix exited with ${result.exitCode}: ${result.stderr}`);
  }
}

/**
 * Run residual OSV scan verification after npm updates are applied.
 * Best-effort: logs a warning on failure but does not abort the pipeline.
 */
async function runOsvResidualVerification(osvRunner: CommandRunner, cwd: string, dryRun: boolean): Promise<void> {
  if (dryRun) {
    logger.info(`[DRY-RUN] Would execute: ${OSV_SCAN_NPM}`);
    return;
  }
  logger.info(`[OSV verify] Running post-update OSV verification: ${OSV_SCAN_NPM}`);
  try {
    await osvRunner.run(OSV_SCAN_NPM, { cwd });
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

    // Resolve npm container runner for npm ecosystem (once per plugin invocation)
    // The npm runner is passed exclusively to the npm plugin/updater.
    // OSV commands (fix + verify) are run separately with a dedicated OSV runner
    // at the orchestration layer — never inside the npm updater.
    let effectiveRunner: CommandRunner = runner;
    let preFixBackups: Map<string, string> | undefined;
    if (plugin.id === 'npm') {
      const npmContainerRunner = await resolveNpmContainerRunner(config, options.cwd, ecosystemRegistry);
      effectiveRunner = npmContainerRunner
        ? new NpmContainerCommandRunner({
            container: npmContainerRunner,
            fallback: runner,
            dryRun: runner.dryRun,
          })
        : runner;

      if (fixerStrategy === 'osv') {
        // === Strategy: osv ===
        // Step 0: Backup npm files BEFORE osv-scanner fix mutates them.
        // This backup is passed to the updater so rollback on validation failure
        // restores the true pre-fix state (not a post-fix snapshot).
        if (!options.dryRun) {
          preFixBackups = await backupFiles(NPM_FILES, options.cwd);
        }

        // Step 1: Run OSV in-place fix with the dedicated OSV runner (before updater).
        // The updater's 'osv' fixer is a no-op — it only reports packages_updated from scan result.
        // read-write mount required: osv-scanner fix writes package-lock.json in-place.
        const osvRunner = resolveOsvCommandRunner(config, options.cwd, runner, runner.dryRun, false);
        const _osvFixMode = config.scanners?.osv?.runner ?? 'docker';
        if (_osvFixMode === 'local') {
          logger.info('[OSV fix] Using local osv-scanner binary for in-place fix');
        } else {
          logger.info('[OSV fix] Using OSV container runner with read-write mount for in-place fix');
        }
        await runOsvFix(osvRunner, options.cwd, options.dryRun);

        // Step 2 (deferred): OSV residual verification runs after updater — see below.
        // Step 3: Authorized breaking changes are handled below after updater returns,
        //         using the npm runner (effectiveRunner), NOT inside the fixer/updater.
      }
      // When fixerStrategy === 'npm-audit':
      // - OSV fix is NOT run here (exclusive strategy).
      // - The updater will call `npm audit fix` via the npm runner.
      // - No OSV residual verification is run for this path.
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
    });

    // === Post-updater steps for npm (strategy-conditional) ===
    if (plugin.id === 'npm' && updateResult.status !== 'error') {
      if (fixerStrategy === 'osv') {
        // Step 3 (osv strategy): Apply authorized breaking changes with npm runner.
        // The OSV fixer no-op inside the updater deliberately skips breaking install;
        // the orchestrator handles it here using the npm runner (effectiveRunner).
        if (authorizeBreaking) {
          const ecosystemResult2 = scanResult.ecosystems['npm'] ?? emptyEcosystem();
          const breakingPkgs = ecosystemResult2.vulnerabilities
            .filter((v) => v.classification === 'breaking' && v.safeVersion)
            .reduce<Map<string, string>>((map, v) => {
              if (!map.has(v.package)) map.set(v.package, v.safeVersion!);
              return map;
            }, new Map());

          if (breakingPkgs.size > 0) {
            const specs = [...breakingPkgs.entries()].map(([name, ver]) => `${name}@${ver}`).join(' ');
            logger.info(`[OSV strategy] Installing authorized breaking-change packages via npm: ${specs}`);
            if (!options.dryRun) {
              const installResult = await effectiveRunner.run(`npm install ${specs}`, { cwd: options.cwd, stream: true });
              if (installResult.exitCode !== 0) {
                logger.error(
                  `[OSV strategy] npm install for breaking packages failed (exit ${installResult.exitCode}): ${installResult.stderr}`,
                );
                result.updates[plugin.id] = {
                  ...updateResult,
                  status: 'error',
                  error: `npm install ${specs} failed: ${installResult.stderr}`,
                };
                result.overallStatus = 'error';
                break;
              }
            } else {
              logger.info(`[DRY-RUN] Would execute: npm install ${specs}`);
            }
          }
        }

        // Step 4 (osv strategy): OSV residual verification after all npm updates.
        // read-only mount is safe for verification (scan only).
        const osvRunner = resolveOsvCommandRunner(config, options.cwd, runner, runner.dryRun, true);
        const _osvVerifyMode = config.scanners?.osv?.runner ?? 'docker';
        if (_osvVerifyMode === 'local') {
          logger.info('[OSV verify] Using local osv-scanner binary for residual verification');
        } else {
          logger.info('[OSV verify] Using OSV container runner with read-only mount for residual verification');
        }
        await runOsvResidualVerification(osvRunner, options.cwd, options.dryRun);
      }
      // npm-audit strategy: no OSV residual verification (exclusive paths).
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

  if (hasPendingItems && result.overallStatus !== 'error') {
    result.overallStatus = 'error'; // exit code 1: vulns remain
  }

  return result;
}
