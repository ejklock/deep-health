import type { CommandRunner } from '../types/common.js';
import type { ProjectConfig } from '../types/config.js';
import type { EcosystemRegistry } from '../ecosystem/registry.js';
import type { ScanResultJson } from '../types/scan.js';

/**
 * Context passed to every ScannerEngine at execution time.
 * Contains everything an engine needs to perform its scan.
 */
export interface ScannerEngineContext {
  runner: CommandRunner;
  config: ProjectConfig;
  cwd: string;
  ecosystemRegistry: EcosystemRegistry;
}

/**
 * Base contract for all scanner engines.
 *
 * A ScannerEngine is responsible for:
 * - asserting its own availability (tool installed, credentials present, etc.)
 * - executing the scan
 * - returning results in the canonical ScanResultJson shape
 *
 * Implementations must be stateless between calls.
 */
export interface ScannerEngine {
  /**
   * Unique identifier for this engine (e.g. 'osv-scanner', 'sonarqube').
   * Used as a key in registries, logs, and result metadata.
   */
  readonly id: string;

  /**
   * Human-readable display name (e.g. 'OSV Scanner', 'SonarQube').
   */
  readonly name: string;

  /**
   * Check whether this engine is available in the current environment.
   * Should throw EnvironmentError with install instructions if not available.
   *
   * In Phase 0, only OsvScannerEngine implements this.
   */
  assertAvailable(ctx: ScannerEngineContext): Promise<void>;

  /**
   * Execute the scan and return the canonical result.
   * Must not throw for non-fatal failures — encode them in the returned status/error.
   */
  scan(ctx: ScannerEngineContext): Promise<ScanResultJson>;
}

/**
 * Warning emitted by an engine when it fails non-fatally.
 * Phase 0: always empty. Prepared for SonarQube's warn-only policy in Phase 1+.
 */
export interface EngineWarning {
  engineId: string;
  message: string;
}
