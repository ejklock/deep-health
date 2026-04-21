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
