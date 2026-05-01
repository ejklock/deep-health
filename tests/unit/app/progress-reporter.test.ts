/**
 * Tests for src/app/progress-reporter.ts
 * Covers renderer selection and Listr task-list construction.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@infra/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), phase: vi.fn(), skip: vi.fn(), header: vi.fn(), tagged: vi.fn() },
  setProgressSink: vi.fn(),
  makeProgressSink: vi.fn(),
}));

import { Listr } from 'listr2';
import { selectRenderer, buildScanTaskList, buildFixTaskList } from '@app/progress-reporter';
import type { ScannerEngine, ScannerEngineContext } from '@modules/scanner/types';
import type { ProjectConfig } from '@core/types/config';

// ─── selectRenderer() ─────────────────────────────────────────────────────────

describe('selectRenderer()', () => {
  it('returns "verbose" when verbose is true', () => {
    expect(selectRenderer({ verbose: true })).toBe('verbose');
  });

  it('returns "silent" when quiet is true', () => {
    expect(selectRenderer({ quiet: true })).toBe('silent');
  });

  it('returns "silent" when json is true', () => {
    expect(selectRenderer({ json: true })).toBe('silent');
  });

  it('returns "default" when no flags are set', () => {
    expect(selectRenderer({})).toBe('default');
  });

  it('returns "default" when all flags are false', () => {
    expect(selectRenderer({ verbose: false, quiet: false, json: false })).toBe('default');
  });

  it('verbose takes precedence over quiet', () => {
    expect(selectRenderer({ verbose: true, quiet: true })).toBe('verbose');
  });

  it('verbose takes precedence over json', () => {
    expect(selectRenderer({ verbose: true, json: true })).toBe('verbose');
  });
});

// ─── buildScanTaskList() ──────────────────────────────────────────────────────

function makeMockEngine(id: string, name: string): ScannerEngine {
  return { id, name, scan: vi.fn().mockResolvedValue({ status: 'success', ecosystems: {} }) } as unknown as ScannerEngine;
}

describe('buildScanTaskList()', () => {
  const ctx = {} as ScannerEngineContext;
  const config = {} as ProjectConfig;

  it('returns a Listr instance', () => {
    const engines = [makeMockEngine('osv', 'OSV Scanner')];
    const list = buildScanTaskList(engines, ctx, config, 'silent');
    expect(list).toBeInstanceOf(Listr);
  });

  it('creates one task per engine', () => {
    const engines = [
      makeMockEngine('osv', 'OSV Scanner'),
      makeMockEngine('sonarqube', 'SonarQube'),
    ];
    const list = buildScanTaskList(engines, ctx, config, 'silent');
    // Listr exposes the task count via .tasks
    expect((list as unknown as { tasks: unknown[] }).tasks).toHaveLength(2);
  });

  it('includes the engine name in the task title', () => {
    const engines = [makeMockEngine('npm', 'NPM Audit')];
    const list = buildScanTaskList(engines, ctx, config, 'silent');
    const tasks = (list as unknown as { tasks: Array<{ title: string }> }).tasks;
    expect(tasks[0].title).toContain('NPM Audit');
  });

  it('accepts the "verbose" renderer without throwing', () => {
    const engines = [makeMockEngine('osv', 'OSV Scanner')];
    expect(() => buildScanTaskList(engines, ctx, config, 'verbose')).not.toThrow();
  });
});

// ─── buildFixTaskList() ───────────────────────────────────────────────────────

describe('buildFixTaskList()', () => {
  it('returns a Listr instance', () => {
    const steps = [{ title: 'Apply fixes', task: vi.fn().mockResolvedValue(undefined) }];
    const list = buildFixTaskList('npm-fix', steps, 'silent');
    expect(list).toBeInstanceOf(Listr);
  });

  it('creates one task per step', () => {
    const steps = [
      { title: 'Step A', task: vi.fn().mockResolvedValue(undefined) },
      { title: 'Step B', task: vi.fn().mockResolvedValue(undefined) },
      { title: 'Step C', task: vi.fn().mockResolvedValue(undefined) },
    ];
    const list = buildFixTaskList('label', steps, 'silent');
    expect((list as unknown as { tasks: unknown[] }).tasks).toHaveLength(3);
  });

  it('preserves each step title', () => {
    const steps = [{ title: 'Revert lock file', task: vi.fn().mockResolvedValue(undefined) }];
    const list = buildFixTaskList('label', steps, 'silent');
    const tasks = (list as unknown as { tasks: Array<{ title: string }> }).tasks;
    expect(tasks[0].title).toBe('Revert lock file');
  });
});
