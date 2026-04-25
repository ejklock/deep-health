import { describe, it, expect, vi } from 'vitest';
import type { CommandRunner, CommandResult } from '@core/types/common';
import type { EphemeralContainerRunner } from '@infra/provisioner/types';
import { OsvContainerCommandRunner, extractOsvArgs } from '@infra/executor/osv-container-runner';

function makeCommandResult(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    command: '',
    dryRun: false,
    ...overrides,
  };
}

function makeFallbackRunner(): CommandRunner {
  return {
    run: vi.fn().mockResolvedValue(makeCommandResult({ command: 'fallback run' })),
    runArgs: vi.fn().mockResolvedValue(makeCommandResult({ command: 'fallback runArgs' })),
    dryRun: false,
    environment: 'local',
  } as unknown as CommandRunner;
}

function makeContainerRunner(): EphemeralContainerRunner<string[]> {
  return {
    run: vi.fn().mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 }),
  };
}

describe('extractOsvArgs', () => {
  it('extracts args for osv-scanner command', () => {
    expect(extractOsvArgs('osv-scanner fix --strategy=in-place -L package-lock.json')).toEqual([
      'fix',
      '--strategy=in-place',
      '-L',
      'package-lock.json',
    ]);
  });

  it('returns null for non-osv commands', () => {
    expect(extractOsvArgs('npm audit fix')).toBeNull();
  });
});

describe('OsvContainerCommandRunner', () => {
  it('routes osv-scanner commands to OSV container', async () => {
    const container = makeContainerRunner();
    const fallback = makeFallbackRunner();
    const runner = new OsvContainerCommandRunner({ container, fallback, dryRun: false });

    await runner.run('osv-scanner --lockfile package-lock.json --format json', { cwd: '/tmp/project' });

    expect(container.run).toHaveBeenCalledWith(['--lockfile', 'package-lock.json', '--format', 'json']);
    expect(fallback.run).not.toHaveBeenCalled();
  });

  it('delegates non-osv commands to fallback runner', async () => {
    const container = makeContainerRunner();
    const fallback = makeFallbackRunner();
    const runner = new OsvContainerCommandRunner({ container, fallback, dryRun: false });

    await runner.run('npm audit fix', { cwd: '/tmp/project' });

    expect(container.run).not.toHaveBeenCalled();
    expect(fallback.run).toHaveBeenCalledWith('npm audit fix', { cwd: '/tmp/project' });
  });

  it('routes runArgs("osv-scanner", ...) to OSV container', async () => {
    const container = makeContainerRunner();
    const fallback = makeFallbackRunner();
    const runner = new OsvContainerCommandRunner({ container, fallback, dryRun: false });

    await runner.runArgs('osv-scanner', ['fix', '--strategy=in-place', '-L', 'package-lock.json']);

    expect(container.run).toHaveBeenCalledWith(['fix', '--strategy=in-place', '-L', 'package-lock.json']);
    expect(fallback.runArgs).not.toHaveBeenCalled();
  });

  it('returns dryRun result from run() when dryRun=true (line 41)', async () => {
    const container = makeContainerRunner();
    const fallback = makeFallbackRunner();
    const runner = new OsvContainerCommandRunner({ container, fallback, dryRun: true });

    const result = await runner.run('osv-scanner --lockfile package-lock.json', { cwd: '/tmp' });

    expect(result.dryRun).toBe(true);
    expect(result.stdout).toBe('');
    expect(container.run).not.toHaveBeenCalled();
    expect(fallback.run).not.toHaveBeenCalled();
  });

  it('returns dryRun result from runArgs() when dryRun=true (lines 63-64)', async () => {
    const container = makeContainerRunner();
    const fallback = makeFallbackRunner();
    const runner = new OsvContainerCommandRunner({ container, fallback, dryRun: true });

    const result = await runner.runArgs('osv-scanner', ['--lockfile', 'package-lock.json']);

    expect(result.dryRun).toBe(true);
    expect(result.command).toBe('osv-scanner --lockfile package-lock.json');
    expect(container.run).not.toHaveBeenCalled();
    expect(fallback.runArgs).not.toHaveBeenCalled();
  });

  it('delegates non-osv-scanner runArgs to fallback (line 81)', async () => {
    const container = makeContainerRunner();
    const fallback = makeFallbackRunner();
    const runner = new OsvContainerCommandRunner({ container, fallback, dryRun: false });

    await runner.runArgs('git', ['status']);

    expect(container.run).not.toHaveBeenCalled();
    expect(fallback.runArgs).toHaveBeenCalledWith('git', ['status'], undefined);
  });

  it('dryRun defaults to false when not provided (line 34 ?? false branch)', async () => {
    const { container } = makeContainerRunner();
    const fallback = makeFallbackRunner();
    const runner = new OsvContainerCommandRunner({ container, fallback });
    expect((runner as any).dryRun).toBe(false);
  });

  it('extractOsvArgs returns null for empty command (?? [] + parts.length===0 branches)', () => {
    expect(extractOsvArgs('')).toBeNull();
  });
});
