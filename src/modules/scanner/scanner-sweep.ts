/**
 * Scanner Sweep — multi-engine scan execution with policy-driven result aggregation.
 *
 * Owns the full multi-engine scan stage:
 *   1. Delegates engine execution to an injected EngineRunRenderer (which controls
 *      visual presentation — Listr2, silent, etc.).
 *   2. Applies the on_failure policy (injected via EngineRunPolicy) for secondary
 *      engines: 'warn' → warning accumulated, engine excluded from entries; 'fail' → throw.
 *   3. Throws PrimaryEngineFailure when the primary engine throws or returns status='error'.
 *
 * This module is config-agnostic: policy resolution and visual ceremony are both
 * injected as dependencies so the module can be tested without mocking globals.
 *
 * NOTE: This module must NOT import listr2 or setProgressSink. Listr2 lives only
 * in scanner-sweep-renderers.ts.
 */

import type { ScannerEngine, ScannerEngineContext, EngineWarning } from './types';
import type { ScanResultJson } from '@core/types/scan';
import type { Result } from '@core/types/result';
import { ok, err } from '@core/types/result';

// ─── Public interfaces ────────────────────────────────────────────────────────

/**
 * Adapter at the Scanner Sweep seam controlling visual presentation.
 *
 * The Adapter is responsible for running all engines as a batch (e.g. inside a
 * single Listr2 task list) and returning a Map of engine id → result-or-error.
 * The sweep module then applies the policy loop over the Map.
 */
export interface EngineRunRenderer {
  runSweep<T>(
    engines: ScannerEngine[],
    runOne: (engine: ScannerEngine) => Promise<T>,
  ): Promise<Map<string, T | Error>>;
}

/**
 * Policy injected by the orchestrator telling the sweep:
 *   - which engine id is primary (its failures always throw PrimaryEngineFailure)
 *   - how to resolve on_failure for secondary engines
 */
export interface EngineRunPolicy {
  primaryEngineId: string;
  resolveOnFailure: (engineId: string) => 'warn' | 'fail';
}

/**
 * Aggregated output of a completed sweep.
 */
export interface EngineRunResult {
  /** Successful (non-skipped) engine results in registry order. */
  engineEntries: Array<{ engineId: string; result: ScanResultJson }>;
  /** Non-fatal warnings accumulated from secondary engines configured with on_failure='warn'. */
  warnings: EngineWarning[];
}

// ─── PrimaryEngineFailure ─────────────────────────────────────────────────────

/**
 * Typed exception thrown by executeScannerSweep when the primary engine
 * (id === policy.primaryEngineId) either throws or returns status='error'.
 *
 * Carries partialWarnings so the orchestrator can include warnings from
 * secondary engines that ran before the primary failed — otherwise that
 * already-paid work would be silently discarded.
 */
export class PrimaryEngineFailure extends Error {
  override readonly name = 'PrimaryEngineFailure';
  readonly engineId: string;
  override readonly cause: unknown;
  readonly partialWarnings: EngineWarning[];

  constructor(engineId: string, cause: unknown, partialWarnings: EngineWarning[]) {
    const message =
      cause instanceof Error
        ? `Primary scanner engine "${engineId}" failed: ${cause.message}`
        : `Primary scanner engine "${engineId}" failed`;
    super(message);
    this.engineId = engineId;
    this.cause = cause;
    this.partialWarnings = partialWarnings;
    // Maintain proper prototype chain for instanceof checks across compilation targets
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ─── ScanSweepError ───────────────────────────────────────────────────────────

/**
 * Discriminated union of the two failure modes of executeScannerSweep.
 *
 * - 'primary': the primary engine failed (PrimaryEngineFailure wraps the cause
 *   and carries partialWarnings accumulated before the failure).
 * - 'secondary': a secondary engine with on_failure='fail' threw or returned
 *   status='error'; the original Error is carried as-is.
 */
export type ScanSweepError =
  | { kind: 'primary'; failure: PrimaryEngineFailure }
  | { kind: 'secondary'; error: Error };

// ─── Core algorithm ───────────────────────────────────────────────────────────

/**
 * Execute all registered scanner engines and aggregate their results.
 *
 * Execution algorithm:
 *   1. Delegate the full engine batch to renderer.runSweep, which returns a
 *      Map<engineId, ScanResultJson | Error>.
 *   2. Walk engines in registry order and apply the policy:
 *      - Error from primary  → throw PrimaryEngineFailure
 *      - Error from secondary, on_failure='fail'  → throw original error
 *      - Error from secondary, on_failure='warn'  → push warning, skip entry
 *      - result.status='error' from primary       → throw PrimaryEngineFailure
 *      - result.status='error' from secondary     → same warn/fail split
 *      - result.status='skipped'                  → silently drop (no entry, no warning)
 *      - result otherwise                         → push to engineEntries
 *   3. Return { engineEntries, warnings }.
 */
export async function executeScannerSweep(
  engines: ScannerEngine[],
  ctx: ScannerEngineContext,
  policy: EngineRunPolicy,
  renderer: EngineRunRenderer,
): Promise<Result<EngineRunResult, ScanSweepError>> {
  const engineEntries: Array<{ engineId: string; result: ScanResultJson }> = [];
  const warnings: EngineWarning[] = [];

  // Step 1: Run all engines via the renderer (Listr2, silent, etc.)
  const engineResults = await renderer.runSweep(engines, (engine) => engine.scan(ctx));

  // Step 2: Apply policy loop in registry order
  for (const engine of engines) {
    const isPrimary = engine.id === policy.primaryEngineId;
    const resultOrError = engineResults.get(engine.id);

    // Defensive: should not happen if renderer covers all engines
    if (resultOrError === undefined) {
      continue;
    }

    if (resultOrError instanceof Error) {
      if (isPrimary) {
        return err({
          kind: 'primary',
          failure: new PrimaryEngineFailure(engine.id, resultOrError, [...warnings]),
        });
      }

      // Secondary engine threw
      const onFailure = policy.resolveOnFailure(engine.id);
      if (onFailure === 'fail') {
        return err({ kind: 'secondary', error: resultOrError });
      }

      // on_failure='warn' — record warning and continue
      warnings.push({ engineId: engine.id, message: resultOrError.message });
      continue;
    }

    const result = resultOrError;

    if (result.status === 'error') {
      if (isPrimary) {
        return err({
          kind: 'primary',
          failure: new PrimaryEngineFailure(
            engine.id,
            new Error(result.error ?? `primary engine "${engine.id}" returned status=error`),
            [...warnings],
          ),
        });
      }

      // Secondary engine returned status='error'
      const onFailure = policy.resolveOnFailure(engine.id);
      const message = result.error ?? `${engine.name} scan returned status 'error'`;
      if (onFailure === 'fail') {
        return err({ kind: 'secondary', error: new Error(message) });
      }

      // on_failure='warn'
      warnings.push({ engineId: engine.id, message });
      continue;
    }

    if (result.status === 'skipped') {
      // Silently accepted — no entry, no warning
      continue;
    }

    engineEntries.push({ engineId: engine.id, result });
  }

  return ok({ engineEntries, warnings });
}
