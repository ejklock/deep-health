/**
 * Branch coverage top-up for src/modules/advisor/runner.ts
 * Covers JSON format, parse errors, plain-text, exception paths.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@infra/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), tagged: vi.fn() },
}));

vi.mock('@modules/ecosystem/plugins/npm-audit-parser', () => ({
  parseNpmAuditJson: vi.fn(),
}));

import { runAdvisors } from '@modules/advisor/runner';
import { parseNpmAuditJson } from '@modules/ecosystem/plugins/npm-audit-parser';
import type { CommandRunner } from '@core/types/common';

function makeRunner(stdout = '', exitCode = 0, throws = false): CommandRunner {
  return {
    run: throws
      ? vi.fn().mockRejectedValue(new Error('command failed'))
      : vi.fn().mockResolvedValue({ stdout, stderr: '', exitCode, command: 'cmd', dryRun: false }),
    runArgs: vi.fn(),
    dryRun: false,
    environment: 'local' as const,
  };
}

describe('runAdvisors()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns [] when advisors array is empty', async () => {
    const results = await runAdvisors(makeRunner(), '/cwd', 'npm', []);
    expect(results).toEqual([]);
  });

  it('runs plain-text advisor with exitCode=0 → clean status', async () => {
    const runner = makeRunner('some output', 0);
    const results = await runAdvisors(runner, '/cwd', 'npm', [
      { name: 'check', command: 'npm check', format: 'text' },
    ]);
    expect(results[0]!.status).toBe('clean');
    expect(results[0]!.exitCode).toBe(0);
  });

  it('runs plain-text advisor with exitCode≠0 → findings status', async () => {
    const runner = makeRunner('vulnerability found', 1);
    const results = await runAdvisors(runner, '/cwd', 'npm', [
      { name: 'audit', command: 'npm audit', format: 'text' },
    ]);
    expect(results[0]!.status).toBe('findings');
  });

  it('truncates output to last 20 lines', async () => {
    const longOutput = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
    const runner = makeRunner(longOutput, 0);
    const results = await runAdvisors(runner, '/cwd', 'npm', [
      { name: 'check', command: 'npm check', format: 'text' },
    ]);
    const outputLines = results[0]!.output.split('\n');
    expect(outputLines.length).toBeLessThanOrEqual(20);
  });

  it('runs JSON advisor with no findings → clean status', async () => {
    vi.mocked(parseNpmAuditJson).mockReturnValue([]);
    const runner = makeRunner('{}', 0);
    const results = await runAdvisors(runner, '/cwd', 'npm', [
      { name: 'audit', command: 'npm audit --json', format: 'json' },
    ]);
    expect(results[0]!.status).toBe('clean');
    expect(results[0]!.findings).toEqual([]);
  });

  it('runs JSON advisor with findings → findings status', async () => {
    vi.mocked(parseNpmAuditJson).mockReturnValue([
      { package: 'lodash', severity: 'high', title: 'Prototype Pollution' },
    ]);
    const runner = makeRunner('{"vulnerabilities":{}}', 1);
    const results = await runAdvisors(runner, '/cwd', 'npm', [
      { name: 'audit', command: 'npm audit --json', format: 'json' },
    ]);
    expect(results[0]!.status).toBe('findings');
    expect(results[0]!.findings).toHaveLength(1);
  });

  it('JSON parse failure → error status', async () => {
    vi.mocked(parseNpmAuditJson).mockImplementation(() => {
      throw new Error('Invalid JSON');
    });
    const runner = makeRunner('not-json', 0);
    const results = await runAdvisors(runner, '/cwd', 'npm', [
      { name: 'audit', command: 'npm audit --json', format: 'json' },
    ]);
    expect(results[0]!.status).toBe('error');
  });

  it('JSON parse failure with non-Error object → error status', async () => {
    vi.mocked(parseNpmAuditJson).mockImplementation(() => {
      throw 'parse error string';
    });
    const runner = makeRunner('not-json', 0);
    const results = await runAdvisors(runner, '/cwd', 'npm', [
      { name: 'audit', command: 'npm audit --json', format: 'json' },
    ]);
    expect(results[0]!.status).toBe('error');
  });

  it('runner exception → error status (non-fatal)', async () => {
    const results = await runAdvisors(makeRunner('', 0, true), '/cwd', 'npm', [
      { name: 'check', command: 'npm check' },
    ]);
    expect(results[0]!.status).toBe('error');
    expect(results[0]!.exitCode).toBe(-1);
  });

  it('runner exception with non-Error value → error status', async () => {
    const runner: CommandRunner = {
      run: vi.fn().mockRejectedValue('string error'),
      runArgs: vi.fn(),
      dryRun: false,
      environment: 'local' as const,
    };
    const results = await runAdvisors(runner, '/cwd', 'npm', [
      { name: 'check', command: 'npm check' },
    ]);
    expect(results[0]!.status).toBe('error');
    expect(results[0]!.output).toBe('string error');
  });

  it('runs multiple advisors in sequence', async () => {
    vi.mocked(parseNpmAuditJson).mockReturnValue([]);
    const runner = makeRunner('output', 0);
    const results = await runAdvisors(runner, '/cwd', 'npm', [
      { name: 'check1', command: 'cmd1', format: 'text' },
      { name: 'check2', command: 'cmd2', format: 'json' },
    ]);
    expect(results).toHaveLength(2);
  });
});
