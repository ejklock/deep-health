import { describe, it, expect, vi } from 'vitest';
import type { CommandRunner, CommandResult } from '@core/types/common';
import type { EphemeralContainerRunner, ContainerRunResult } from '@infra/provisioner/types';
import { PipContainerCommandRunner } from '@infra/executor/pip-container-runner';

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

describe('PipContainerCommandRunner', () => {
  it('routes "pip install requests" with stream=true to runStreaming', async () => {
    const { container, run, runStreaming } = makeContainerRunner();
    const fallback = makeFallbackRunner();
    const runner = new PipContainerCommandRunner({ container, fallback, dryRun: false });

    const result = await runner.run('pip install requests', { cwd: '/tmp', stream: true });

    expect(runStreaming).toHaveBeenCalledWith(['pip', 'install', 'requests']);
    expect(run).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('stream-stdout');
  });

  it('routes "pip check" with stream=false to run()', async () => {
    const { container, run, runStreaming } = makeContainerRunner();
    const fallback = makeFallbackRunner();
    const runner = new PipContainerCommandRunner({ container, fallback, dryRun: false });

    const result = await runner.run('pip check', { cwd: '/tmp' });

    expect(run).toHaveBeenCalledWith(['pip', 'check']);
    expect(runStreaming).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('run-stdout');
  });

  it('routes "pip3 list --outdated" to container', async () => {
    const { container, run } = makeContainerRunner();
    const fallback = makeFallbackRunner();
    const runner = new PipContainerCommandRunner({ container, fallback, dryRun: false });

    await runner.run('pip3 list --outdated', { cwd: '/tmp' });

    expect(run).toHaveBeenCalledWith(['pip3', 'list', '--outdated']);
    expect(fallback.run).not.toHaveBeenCalled();
  });

  it('falls back to run() when stream=true but container has no runStreaming', async () => {
    const run = vi.fn<(_: string[]) => Promise<ContainerRunResult>>().mockResolvedValue({
      stdout: 'plain-stdout',
      stderr: '',
      exitCode: 0,
    });
    const container = { run } as unknown as EphemeralContainerRunner<string[]>;
    const fallback = makeFallbackRunner();
    const runner = new PipContainerCommandRunner({ container, fallback, dryRun: false });

    await runner.run('pip check', { stream: true });

    expect(run).toHaveBeenCalledWith(['pip', 'check']);
  });

  it('delegates non-pip command to fallback runner', async () => {
    const { container, run, runStreaming } = makeContainerRunner();
    const fallback = makeFallbackRunner();
    const runner = new PipContainerCommandRunner({ container, fallback, dryRun: false });

    await runner.run('git status', { cwd: '/tmp' });

    expect(run).not.toHaveBeenCalled();
    expect(runStreaming).not.toHaveBeenCalled();
    expect(fallback.run).toHaveBeenCalledWith('git status', { cwd: '/tmp' });
  });

  it('dry-run short-circuits before routing', async () => {
    const { container, run, runStreaming } = makeContainerRunner();
    const fallback = makeFallbackRunner();
    const runner = new PipContainerCommandRunner({ container, fallback, dryRun: true });

    const result = await runner.run('pip install requests', { cwd: '/tmp', stream: true });

    expect(run).not.toHaveBeenCalled();
    expect(runStreaming).not.toHaveBeenCalled();
    expect(fallback.run).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('routes runArgs("pip", ...) with stream=true to runStreaming', async () => {
    const { container, run, runStreaming } = makeContainerRunner();
    const fallback = makeFallbackRunner();
    const runner = new PipContainerCommandRunner({ container, fallback, dryRun: false });

    await runner.runArgs('pip', ['install', '-U', 'requests'], { stream: true });

    expect(runStreaming).toHaveBeenCalledWith(['pip', 'install', '-U', 'requests']);
    expect(run).not.toHaveBeenCalled();
  });

  it('delegates non-pip runArgs to fallback', async () => {
    const { container, run } = makeContainerRunner();
    const fallback = makeFallbackRunner();
    const runner = new PipContainerCommandRunner({ container, fallback, dryRun: false });

    await runner.runArgs('python', ['-m', 'pytest'], {});

    expect(run).not.toHaveBeenCalled();
    expect(fallback.runArgs).toHaveBeenCalledWith('python', ['-m', 'pytest'], {});
  });
});

describe('PipContainerCommandRunner — dryRun=true branches', () => {
  it('run() returns early with dryRun result when dryRun=true', async () => {
    const { container } = makeContainerRunner();
    const fallback = makeFallbackRunner();
    const runner = new PipContainerCommandRunner({ container, fallback, dryRun: true });

    const result = await runner.run('pip install requests');
    expect(result.dryRun).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('runArgs() returns early with dryRun result when dryRun=true', async () => {
    const { container } = makeContainerRunner();
    const fallback = makeFallbackRunner();
    const runner = new PipContainerCommandRunner({ container, fallback, dryRun: true });

    const result = await runner.runArgs('pip', ['install', 'requests']);
    expect(result.dryRun).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('dryRun defaults to false when not provided (line 58 ?? false branch)', async () => {
    const { container } = makeContainerRunner();
    const fallback = makeFallbackRunner();
    const runner = new PipContainerCommandRunner({ container, fallback });
    expect((runner as any).dryRun).toBe(false);
  });

  it('run() with empty command falls back to fallback (extractPipArgs ?? [] + parts.length===0 branches)', async () => {
    const { container } = makeContainerRunner();
    const fallback = makeFallbackRunner();
    const runner = new PipContainerCommandRunner({ container, fallback });
    await runner.run('');
    expect(fallback.run).toHaveBeenCalled();
    expect(container.run).not.toHaveBeenCalled();
  });
});
