import type { CommandRunner } from '@core/types/common.js';
import type { ProjectConfig } from '@core/types/config.js';
import type { EcosystemRegistry } from '@modules/ecosystem/registry.js';
import type { ScanResultJson } from '@core/types/scan.js';

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
 * Used by engines configured with on_failure='warn' to continue the pipeline.
 */
export interface EngineWarning {
  engineId: string;
  message: string;
}
