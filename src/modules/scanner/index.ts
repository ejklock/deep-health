/**
 * Scanner engine registry bootstrap.
 *
 * Import this module via side-effect to register all scanner engines
 * into defaultScannerRegistry. The orchestrator imports this before running.
 *
 * Registered engines (in execution order):
 *   1. OsvScannerEngine — primary vulnerability scanner (always active)
 *   2. SonarQubeEngine  — code quality scanner (self-skips when not enabled in config)
 */
import { defaultScannerRegistry } from './registry';
import { OsvScannerEngine } from './osv-engine';
import { SonarQubeEngine } from './sonarqube-engine';
import type { CommandRunner } from '@core/types/common';
import type { ProjectConfig } from '@core/types/config';
import type { ScanResultJson } from '@core/types/scan';
import type { EcosystemRegistry } from '@modules/ecosystem/registry';
import { defaultRegistry } from '@modules/ecosystem/index';

// Register OSV scanner engine as the primary engine
defaultScannerRegistry.register(new OsvScannerEngine());

// Register SonarQube engine — it self-skips when not configured/enabled
defaultScannerRegistry.register(new SonarQubeEngine());

// Re-export for convenient single-import access
export { defaultScannerRegistry, ScannerEngineRegistry } from './registry';
export type { ScannerEngine, ScannerEngineContext, EngineWarning } from './types';
export type { AggregatedScanResult } from './aggregator';
export { aggregateScanResults } from './aggregator';
export { OsvScannerEngine } from './osv-engine';
export { emptyEcosystem } from '@core/types/scan';
export { SonarQubeEngine } from './sonarqube-engine';

// Convenience wrapper: run only the OSV engine (used by bin commands needing a quick scan)
const _osvEngine = new OsvScannerEngine();

/**
 * OSV-only vulnerability scan.
 *
 * This function is intentionally scoped to OSV (osv-scanner) only.
 * It is used by the fix workflow (fix.ts) for the before/after vulnerability snapshots
 * that drive Gate A and the executive diff report.
 *
 * SonarQube results are NOT produced here. They are produced by the full orchestrator
 * scan pipeline (runOrchestrator) and surfaced via the aggregated `engineResults` field
 * on the orchestrator result. fix.ts consumes those separately for report sections.
 *
 * Do NOT add multi-engine aggregation here — that path belongs to the orchestrator.
 */
export async function runScanner(
  runner: CommandRunner,
  config: ProjectConfig,
  cwd: string,
  registry: EcosystemRegistry = defaultRegistry,
): Promise<ScanResultJson> {
  return _osvEngine.scan({ runner, config, cwd, ecosystemRegistry: registry, branch: null });
}
