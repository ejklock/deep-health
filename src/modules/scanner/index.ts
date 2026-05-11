/**
 * Scanner module public API + lazy engine bootstrap.
 *
 * Engine registration is lazy (on-demand), not at module import time.
 * Use bootstrapDefaultEngines(registry) to register OsvScannerEngine and
 * SonarQubeEngine into a registry before using getAll() / get() on it.
 *
 * runScanner() and the orchestrator call bootstrapDefaultEngines automatically.
 */
import { defaultScannerRegistry } from './registry';
import { OsvScannerEngine } from './osv-engine';
import { SonarQubeEngine } from './sonarqube-engine';
import { OSV_ENGINE_ID } from './aggregator';
import type { CommandRunner } from '@core/types/common';
import type { ProjectConfig } from '@core/types/config';
import type { ScanResultJson } from '@core/types/scan';
import type { EcosystemRegistry } from '@modules/ecosystem/registry';
import { defaultRegistry } from '@modules/ecosystem/index';
import { detectGitBranch } from '@infra/utils/git-branch';

/**
 * Bootstrap the default scanner engines into a registry (idempotent / lazy).
 *
 * Registers:
 *   1. OsvScannerEngine  — primary vulnerability scanner (always active)
 *   2. SonarQubeEngine   — code quality scanner (self-skips when not enabled)
 *
 * Safe to call multiple times — existing registrations are preserved
 * (ScannerEngineRegistry.register is a no-op when the id is already present).
 *
 * Call this before any code that calls `registry.get(OSV_ENGINE_ID)` or
 * `registry.getAll()` on the defaultScannerRegistry.  The orchestrator and
 * runScanner both call this automatically so callers generally don't need to
 * invoke it directly.
 */
export function bootstrapDefaultEngines(
  registry: typeof defaultScannerRegistry = defaultScannerRegistry,
): void {
  if (!registry.has(OSV_ENGINE_ID)) {
    registry.register(new OsvScannerEngine());
  }
  if (!registry.has('sonarqube')) {
    registry.register(new SonarQubeEngine());
  }
}

// Re-export for convenient single-import access
export { defaultScannerRegistry, ScannerEngineRegistry } from './registry';
export type { ScannerEngine, ScannerEngineContext, EngineWarning } from './types';
export type { AggregatedScanResult } from './aggregator';
export { aggregateScanResults, OSV_ENGINE_ID } from './aggregator';
export { OsvScannerEngine } from './osv-engine';
export { emptyEcosystem } from '@core/types/scan';
export { SonarQubeEngine } from './sonarqube-engine';
export { ExternalScannerAdapter } from './external-adapter';
export type { RawVulnerability } from './external-adapter';
export {
  executeScannerSweep,
  PrimaryEngineFailure,
} from './scanner-sweep';
export type {
  EngineRunRenderer,
  EngineRunPolicy,
  EngineRunResult,
  ScanSweepError,
} from './scanner-sweep';
export {
  listr2ScannerSweepRenderer,
  silentScannerSweepRenderer,
} from './scanner-sweep-renderers';

/**
 * Single-engine vulnerability scan using the configured primary scanner.
 *
 * The primary engine is resolved from `config.scanners?.primary` (defaults to
 * OSV_ENGINE_ID when omitted). This allows callers to substitute a different
 * primary engine via config without changing calling code.
 *
 * It is used by the fix workflow (fix.ts) for the before/after vulnerability snapshots
 * that drive Gate A and the executive diff report.
 *
 * SonarQube results are NOT produced here. They are produced by the full orchestrator
 * scan pipeline (runOrchestrator) and surfaced via the aggregated `engineResults` field
 * on the orchestrator result. fix.ts consumes those separately for report sections.
 *
 * Do NOT add multi-engine aggregation here — that path belongs to the orchestrator.
 *
 * Branch detection: detected non-throwingly from the working directory and stamped
 * into the scan result. Returns null when branch cannot be determined (detached HEAD,
 * not a git repo, etc.) — the scan always proceeds.
 */
export async function runScanner(
  runner: CommandRunner,
  config: ProjectConfig,
  cwd: string,
  registry: EcosystemRegistry = defaultRegistry,
  scannerRegistry: typeof defaultScannerRegistry = defaultScannerRegistry,
): Promise<ScanResultJson> {
  // Ensure default engines are registered when using the default registry.
  // When a caller injects a custom scannerRegistry (e.g. tests), they are
  // responsible for populating it — we must NOT auto-populate it here.
  if (scannerRegistry === defaultScannerRegistry) {
    bootstrapDefaultEngines(scannerRegistry);
  }
  const primaryId = config.scanners?.primary ?? OSV_ENGINE_ID;
  const primaryEngine = scannerRegistry.get(primaryId);
  if (!primaryEngine) {
    throw new Error(
      `Primary scanner engine ("${primaryId}") is not registered in the scanner registry. ` +
      `Register a scanner engine with id "${primaryId}" before calling runScanner.`,
    );
  }
  // Detect git branch — never throws; null means "unknown / not applicable"
  const branch = await detectGitBranch(cwd, runner);
  return primaryEngine.scan({ runner, config, cwd, ecosystemRegistry: registry, branch });
}
