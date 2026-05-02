/**
 * Engine Run Renderer adapters for Scanner Sweep.
 *
 * This is the only file in the scanner module that imports listr2.
 * scanner-sweep.ts (the module) must NOT import listr2 — Listr2 ceremony
 * lives exclusively here.
 *
 * Two adapters are exported:
 *   - listr2ScannerSweepRenderer(rendererType): builds a single Listr2 task
 *     list per sweep, one task per engine. Preserves the exact visual behaviour
 *     that previously lived in runAllEngines inside orchestrator.ts.
 *   - silentScannerSweepRenderer: sequential execution with no UI. Used by
 *     tests and JSON-output mode.
 */

import { Listr } from 'listr2';
import type { RendererType } from '@app/progress-reporter';
import { badge } from '@infra/utils/ui';
import { setProgressSink } from '@infra/utils/logger';
import type { ScannerEngine } from './types';
import type { EngineRunRenderer } from './scanner-sweep';

// ─── Listr2 adapter ───────────────────────────────────────────────────────────

/**
 * Returns an EngineRunRenderer that batches all engine.scan calls into a
 * single Listr2 task list (one task per engine), replicating the exact visual
 * behaviour from the previous runAllEngines implementation in orchestrator.ts.
 *
 * Visual details preserved:
 *   - Task title: `${badge(engine.id)} ${engine.name}`
 *   - setProgressSink wired to task.output for streaming log lines
 *   - task.skip called when engine returns status='skipped'
 *   - exitOnError: false so all tasks run even if one fails
 *   - ListrError is swallowed — errors are reported via the returned Map
 */
export function listr2ScannerSweepRenderer(rendererType: RendererType): EngineRunRenderer {
  return {
    async runSweep<T>(
      engines: ScannerEngine[],
      runOne: (engine: ScannerEngine) => Promise<T>,
    ): Promise<Map<string, T | Error>> {
      const resultMap = new Map<string, T | Error>();

      const taskList = new Listr(
        engines.map((engine) => ({
          title: `${badge(engine.id)} ${engine.name}`,
          task: async (
            _: unknown,
            task: { output: string; skip: (reason?: string) => void },
          ) => {
            setProgressSink((msg) => {
              task.output = msg;
            });
            try {
              const result = await runOne(engine);
              resultMap.set(engine.id, result);
              // If the result has a status property equal to 'skipped', mark the task
              if (
                result !== null &&
                typeof result === 'object' &&
                'status' in result &&
                (result as Record<string, unknown>)['status'] === 'skipped'
              ) {
                task.skip('not enabled in config');
              }
            } catch (err) {
              resultMap.set(engine.id, err instanceof Error ? err : new Error(String(err)));
              throw err; // let Listr2 mark the task as failed visually
            } finally {
              setProgressSink(null);
            }
          },
        })),
        {
          renderer: rendererType,
          exitOnError: false, // let all tasks run even if one fails
          concurrent: false,
        },
      );

      try {
        await taskList.run();
      } catch {
        // Listr2 may throw a ListrError when exitOnError:false — errors are
        // already captured per-engine in resultMap; the bundled error is redundant.
      }

      return resultMap;
    },
  };
}

// ─── Silent adapter ───────────────────────────────────────────────────────────

/**
 * Silent EngineRunRenderer — sequential execution with no visual presentation.
 * Used by tests (no Listr2 mocking needed) and JSON-output mode.
 */
export const silentScannerSweepRenderer: EngineRunRenderer = {
  async runSweep<T>(
    engines: ScannerEngine[],
    runOne: (engine: ScannerEngine) => Promise<T>,
  ): Promise<Map<string, T | Error>> {
    const resultMap = new Map<string, T | Error>();

    for (const engine of engines) {
      try {
        const result = await runOne(engine);
        resultMap.set(engine.id, result);
      } catch (err) {
        resultMap.set(engine.id, err instanceof Error ? err : new Error(String(err)));
      }
    }

    return resultMap;
  },
};
