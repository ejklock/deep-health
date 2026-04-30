import { Listr, type ListrRendererValue } from 'listr2';

import { badge } from '@infra/utils/ui';
import { setProgressSink } from '@infra/utils/logger';
import type { ScannerEngine, ScannerEngineContext } from '@modules/scanner/types';
import type { ProjectConfig } from '@core/types/config';

// ─── Renderer selection ───────────────────────────────────────────────────────

export type RendererType = 'default' | 'verbose' | 'silent';

export function selectRenderer(opts: {
  verbose?: boolean;
  quiet?: boolean;
  json?: boolean;
}): RendererType {
  if (opts.verbose) return 'verbose';
  if (opts.quiet || opts.json) return 'silent';
  return 'default';
}

// ─── Scan task list ───────────────────────────────────────────────────────────

export function buildScanTaskList(
  engines: ScannerEngine[],
  ctx: ScannerEngineContext,
  config: ProjectConfig,
  rendererType: RendererType,
): Listr<unknown, ListrRendererValue> {
  const tasks = engines.map((engine) => ({
    title: `${badge(engine.id)} ${engine.name}`,
    task: async (_: unknown, task: { output: string }) => {
      setProgressSink((msg: string) => {
        task.output = msg;
      });
      try {
        await engine.scan(ctx);
      } finally {
        setProgressSink(null);
      }
    },
  }));

  return new Listr(tasks, {
    renderer: rendererType,
    rendererOptions: rendererType === 'default' ? { collapseSubtasks: false } : undefined,
    concurrent: false,
  });
}

// ─── Fix task list ────────────────────────────────────────────────────────────

export function buildFixTaskList(
  label: string,
  steps: Array<{ title: string; task: () => Promise<void> }>,
  rendererType: RendererType,
): Listr<unknown, ListrRendererValue> {
  const tasks = steps.map((step) => ({
    title: step.title,
    task: step.task,
  }));

  return new Listr(tasks, {
    renderer: rendererType,
    rendererOptions: rendererType === 'default' ? { collapseSubtasks: false } : undefined,
    concurrent: false,
  });
}
