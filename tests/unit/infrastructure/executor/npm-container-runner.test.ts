import { describe, it, expect, vi } from 'vitest';
import type { CommandRunner, CommandResult } from '@core/types/common';
import type { EphemeralContainerRunner, ContainerRunResult } from '@infra/provisioner/types';
import { NpmContainerCommandRunner } from '@infra/executor/npm-container-runner';

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

function makeContainerRunner() {
  const run = vi.fn<(_: string[]) => Promise<ContainerRunResult>>().mockResolvedValue({
    stdout: 'run-stdout',
    stderr: '',
    exitCode: 0,
  });
  const runStreaming = vi.fn<(_: string[]) => Promise<ContainerRunResult>>().mockResolvedValue({
    stdout: 'stream-stdout',
    stderr: 'stream-stderr',
    exitCode: 2,
  });

  const container = {
    run,
    runStreaming,
  } as unknown as EphemeralContainerRunner<string[]> & { runStreaming: typeof runStreaming };

  return { container, run, runStreaming };
}

describe('NpmContainerCommandRunner', () => {
  it('uses runStreaming for npm command when stream=true and runner supports streaming', async () => {
    const { container, run, runStreaming } = makeContainerRunner();
    const fallback = makeFallbackRunner();
    const runner = new NpmContainerCommandRunner({ container, fallback, dryRun: false });

    const result = await runner.run('npm ci', { cwd: '/tmp/project', stream: true });

    expect(runStreaming).toHaveBeenCalledWith(['ci']);
    expect(run).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('stream-stdout');
    expect(result.stderr).toBe('stream-stderr');
  });

  it('uses run() for npm command when stream=false', async () => {
    const { container, run, runStreaming } = makeContainerRunner();
    const fallback = makeFallbackRunner();
    const runner = new NpmContainerCommandRunner({ container, fallback, dryRun: false });

    const result = await runner.run('npm install', { cwd: '/tmp/project' });

    expect(run).toHaveBeenCalledWith(['install']);
    expect(runStreaming).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('run-stdout');
  });

  it('falls back to run() when stream=true but container has no runStreaming', async () => {
    const run = vi.fn<(_: string[]) => Promise<ContainerRunResult>>().mockResolvedValue({
      stdout: 'plain-stdout',
      stderr: '',
      exitCode: 0,
    });
    const container = { run } as unknown as EphemeralContainerRunner<string[]>;
    const fallback = makeFallbackRunner();
    const runner = new NpmContainerCommandRunner({ container, fallback, dryRun: false });

    await runner.run('npm ci', { stream: true });

    expect(run).toHaveBeenCalledWith(['ci']);
  });

  it('routes runArgs("npm", ...) with stream=true to runStreaming', async () => {
    const { container, run, runStreaming } = makeContainerRunner();
    const fallback = makeFallbackRunner();
    const runner = new NpmContainerCommandRunner({ container, fallback, dryRun: false });

    await runner.runArgs('npm', ['run', 'build'], { stream: true });

    expect(runStreaming).toHaveBeenCalledWith(['run', 'build']);
    expect(run).not.toHaveBeenCalled();
  });

  it('delegates non-npm command to fallback runner', async () => {
    const { container, run, runStreaming } = makeContainerRunner();
    const fallback = makeFallbackRunner();
    const runner = new NpmContainerCommandRunner({ container, fallback, dryRun: false });

    await runner.run('git status', { cwd: '/tmp/project' });

    expect(run).not.toHaveBeenCalled();
    expect(runStreaming).not.toHaveBeenCalled();
    expect(fallback.run).toHaveBeenCalledWith('git status', { cwd: '/tmp/project' });
  });
});

describe('NpmContainerCommandRunner — runShell routing', () => {
  it('run() — non-npm command with runShell support → routed to container.runShell, NOT fallback', async () => {
    const run = vi.fn<(_: string[]) => Promise<ContainerRunResult>>().mockResolvedValue({
      stdout: '', stderr: '', exitCode: 0,
    });
    const runShell = vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'ok', stderr: '' });
    const container = { run, runShell } as unknown as EphemeralContainerRunner<string[]>;
    const fallback = makeFallbackRunner();
    const runner = new NpmContainerCommandRunner({ container, fallback, dryRun: false });

    const result = await runner.run('jest --coverage', { cwd: '/project' });

    expect(runShell).toHaveBeenCalledWith('jest --coverage', { cwd: '/project' });
    expect(fallback.run).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ok');
  });

  it('run() — git command → stays on fallback even with runShell support', async () => {
    const run = vi.fn<(_: string[]) => Promise<ContainerRunResult>>().mockResolvedValue({
      stdout: '', stderr: '', exitCode: 0,
    });
    const runShell = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    const container = { run, runShell } as unknown as EphemeralContainerRunner<string[]>;
    const fallback = makeFallbackRunner();
    const runner = new NpmContainerCommandRunner({ container, fallback, dryRun: false });

    await runner.run('git status');

    expect(fallback.run).toHaveBeenCalled();
    expect(runShell).not.toHaveBeenCalled();
  });

  it('run() — non-npm command WITHOUT runShell support → falls back to LocalExecutor', async () => {
    const run = vi.fn<(_: string[]) => Promise<ContainerRunResult>>().mockResolvedValue({
      stdout: '', stderr: '', exitCode: 0,
    });
    const container = { run } as unknown as EphemeralContainerRunner<string[]>;
    const fallback = makeFallbackRunner();
    const runner = new NpmContainerCommandRunner({ container, fallback, dryRun: false });

    await runner.run('jest --coverage');

    expect(fallback.run).toHaveBeenCalled();
  });

  it('runArgs() — non-npm file with runShell → routed to container.runShell', async () => {
    const run = vi.fn<(_: string[]) => Promise<ContainerRunResult>>().mockResolvedValue({
      stdout: '', stderr: '', exitCode: 0,
    });
    const runShell = vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'vitest-out', stderr: '' });
    const container = { run, runShell } as unknown as EphemeralContainerRunner<string[]>;
    const fallback = makeFallbackRunner();
    const runner = new NpmContainerCommandRunner({ container, fallback, dryRun: false });

    await runner.runArgs('vitest', ['run', '--reporter=verbose']);

    expect(runShell).toHaveBeenCalledWith('vitest run --reporter=verbose', { cwd: undefined });
    expect(fallback.runArgs).not.toHaveBeenCalled();
  });

  it('runArgs() — gh command → stays on fallback', async () => {
    const run = vi.fn<(_: string[]) => Promise<ContainerRunResult>>().mockResolvedValue({
      stdout: '', stderr: '', exitCode: 0,
    });
    const runShell = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    const container = { run, runShell } as unknown as EphemeralContainerRunner<string[]>;
    const fallback = makeFallbackRunner();
    const runner = new NpmContainerCommandRunner({ container, fallback, dryRun: false });

    await runner.runArgs('gh', ['pr', 'create']);

    expect(fallback.runArgs).toHaveBeenCalled();
    expect(runShell).not.toHaveBeenCalled();
  });
});

describe('NpmContainerCommandRunner — dryRun=true branches (lines 66-67)', () => {
  it('run() returns early with dryRun result when dryRun=true', async () => {
    const { container } = makeContainerRunner();
    const fallback = makeFallbackRunner();
    const runner = new NpmContainerCommandRunner({ container, fallback, dryRun: true });

    const result = await runner.run('npm install');
    expect(result.dryRun).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('runArgs() returns early with dryRun result when dryRun=true', async () => {
    const { container } = makeContainerRunner();
    const fallback = makeFallbackRunner();
    const runner = new NpmContainerCommandRunner({ container, fallback, dryRun: true });

    const result = await runner.runArgs('npm', ['install']);
    expect(result.dryRun).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('delegates non-npm runArgs() to fallback runner (line 106)', async () => {
    const { container } = makeContainerRunner();
    const fallback = makeFallbackRunner();
    const runner = new NpmContainerCommandRunner({ container, fallback, dryRun: false });

    await runner.runArgs('git', ['status']);

    expect(container.run).not.toHaveBeenCalled();
    expect(fallback.runArgs).toHaveBeenCalledWith('git', ['status'], undefined);
  });

  it('dryRun defaults to false when not provided (line 59 ?? false branch)', async () => {
    const { container } = makeContainerRunner();
    const fallback = makeFallbackRunner();
    // omit dryRun — triggers ?? false branch
    const runner = new NpmContainerCommandRunner({ container, fallback });
    expect((runner as any).dryRun).toBe(false);
  });

  it('run() with empty command falls back to fallback (extractNpmArgs ?? [] + parts.length===0 branches)', async () => {
    const { container } = makeContainerRunner();
    const fallback = makeFallbackRunner();
    const runner = new NpmContainerCommandRunner({ container, fallback });
    await runner.run('');
    expect(fallback.run).toHaveBeenCalled();
    expect(container.run).not.toHaveBeenCalled();
  });
});
