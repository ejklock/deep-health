import type { CommandRunner } from '@core/types/common';
import type { ProjectConfig } from '@core/types/config';
import type { EcosystemRegistry } from '@modules/ecosystem/registry';
import type { ScanResultJson } from '@core/types/scan';

/**
 * Context passed to every ScannerEngine at execution time.
 * Contains everything an engine needs to perform its scan.
 */
export interface ScannerEngineContext {
  runner: CommandRunner;
  config: ProjectConfig;
  cwd: string;
  ecosystemRegistry: EcosystemRegistry;
  /**
   * Current git branch name, detected once by the orchestrator before engines run.
   * `null` when the branch cannot be determined (detached HEAD, not a git repo, etc.).
   * Engines should treat null as "branch unknown" and skip branch-specific behaviour.
   */
  branch: string | null;
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
   * Execution priority. Lower values run first.
   * When absent, the engine retains its registration order relative to other unordered engines.
   * OSV uses 0; secondary engines like SonarQube use 100.
   */
  readonly order?: number;

  /**
   * Execution phase for this engine.
   *
   * - `'scan'` (default): runs in the pre-fix scanner sweep, before ecosystem fixers.
   *   OSV and most engines belong here.
   * - `'post-fix'`: runs AFTER all ecosystem fixers complete, so it analyses the
   *   final state of the code. SonarQube uses this phase so its report reflects
   *   the post-remediation code rather than the pre-fix state.
   *
   * Engines that omit this field are treated as `'scan'` (backward compatible).
   */
  readonly phase?: 'scan' | 'post-fix';

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
