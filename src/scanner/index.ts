/**
 * Scanner engine registry bootstrap.
 *
 * Import this module via side-effect to register all scanner engines
 * into defaultScannerRegistry. The orchestrator imports this before running.
 *
 * Phase 0: only OsvScannerEngine is registered.
 * Phase 1: SonarQubeEngine is registered after OSV (always — it skips itself
 *   when not enabled in config, so registration is unconditional).
 */
import { defaultScannerRegistry } from './registry.js';
import { OsvScannerEngine } from './osv-engine.js';
import { SonarQubeEngine } from './sonarqube-engine.js';

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
export { emptyEcosystem } from './osv-engine.js';
export { SonarQubeEngine } from './sonarqube-engine.js';
