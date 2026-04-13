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
import { defaultScannerRegistry } from './registry.js';
import { OsvScannerEngine } from './osv-engine.js';
import { SonarQubeEngine } from './sonarqube-engine.js';
import type { CommandRunner } from '@core/types/common.js';
import type { ProjectConfig } from '@core/types/config.js';
import type { ScanResultJson } from '@core/types/scan.js';
import type { EcosystemRegistry } from '@modules/ecosystem/registry.js';
import { defaultRegistry } from '@modules/ecosystem/index.js';

// Register OSV scanner engine as the primary engine
defaultScannerRegistry.register(new OsvScannerEngine());

// Register SonarQube engine — it self-skips when not configured/enabled
defaultScannerRegistry.register(new SonarQubeEngine());

// Re-export for convenient single-import access
export { defaultScannerRegistry, ScannerEngineRegistry } from './registry.js';
export type { ScannerEngine, ScannerEngineContext, EngineWarning } from './types.js';
export type { AggregatedScanResult } from './aggregator.js';
export { aggregateScanResults } from './aggregator.js';
export { OsvScannerEngine } from './osv-engine.js';
export { emptyEcosystem } from '@core/types/scan.js';
export { SonarQubeEngine } from './sonarqube-engine.js';

// Convenience wrapper: run only the OSV engine (used by bin commands needing a quick scan)
const _osvEngine = new OsvScannerEngine();

export async function runScanner(
  runner: CommandRunner,
  config: ProjectConfig,
  cwd: string,
  registry: EcosystemRegistry = defaultRegistry,
): Promise<ScanResultJson> {
  return _osvEngine.scan({ runner, config, cwd, ecosystemRegistry: registry });
}
