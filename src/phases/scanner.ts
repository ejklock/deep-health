/**
 * Phase 1 scanner entry point — thin wrapper over OsvScannerEngine.
 *
 * Public API is preserved for backward compatibility:
 * - runScanner() signature unchanged
 * - emptyEcosystem() re-exported from osv-engine for consumers that import it here
 *
 * Internal logic has been extracted to src/scanner/osv-engine.ts as part of
 * the Phase 0 multi-scanner architecture refactor. This file now simply
 * instantiates the engine and delegates the scan call.
 */
import type { CommandRunner } from '../types/common.js';
import type { ProjectConfig } from '../types/config.js';
import type { ScanResultJson } from '../types/scan.js';
import type { EcosystemRegistry } from '../ecosystem/registry.js';
import { defaultRegistry } from '../ecosystem/index.js';
import { OsvScannerEngine } from '../scanner/osv-engine.js';

// Re-export emptyEcosystem for callers that import it from this module
export { emptyEcosystem } from '../scanner/osv-engine.js';

const osvEngine = new OsvScannerEngine();

/**
 * Run the OSV vulnerability scan.
 *
 * Delegates to OsvScannerEngine.scan(). The returned ScanResultJson shape
 * is identical to pre-refactor output.
 */
export async function runScanner(
  runner: CommandRunner,
  config: ProjectConfig,
  cwd: string,
  registry: EcosystemRegistry = defaultRegistry,
): Promise<ScanResultJson> {
  return osvEngine.scan({ runner, config, cwd, ecosystemRegistry: registry });
}
