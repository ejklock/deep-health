import { describe, it, expect, vi } from 'vitest';
import type { CommandRunner, CommandResult } from '@core/types/common';
import type { EphemeralContainerRunner, ContainerRunResult } from '@infra/provisioner/types';
import { ComposerContainerCommandRunner } from '@infra/executor/composer-container-runner';

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

describe('ComposerContainerCommandRunner', () => {
  it('routes composer command with stream=true to runStreaming', async () => {
    const { container, run, runStreaming } = makeContainerRunner();
    const fallback = makeFallbackRunner();
    const runner = new ComposerContainerCommandRunner({ container, fallback, dryRun: false });

    const result = await runner.run('composer install', { cwd: '/tmp/project', stream: true });

    expect(runStreaming).toHaveBeenCalledWith(['composer', 'install']);
    expect(run).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(2);
  });

  it('routes php command to container', async () => {
    const { container, run } = makeContainerRunner();
    const fallback = makeFallbackRunner();
    const runner = new ComposerContainerCommandRunner({ container, fallback, dryRun: false });

    await runner.run('php artisan test --compact', { cwd: '/tmp/project' });

    expect(run).toHaveBeenCalledWith(['php', 'artisan', 'test', '--compact']);
    expect(fallback.run).not.toHaveBeenCalled();
  });

  it('delegates non-composer/php command to fallback runner', async () => {
    const { container, run, runStreaming } = makeContainerRunner();
    const fallback = makeFallbackRunner();
    const runner = new ComposerContainerCommandRunner({ container, fallback, dryRun: false });

    await runner.run('npm run build', { cwd: '/tmp/project' });

    expect(run).not.toHaveBeenCalled();
    expect(runStreaming).not.toHaveBeenCalled();
    expect(fallback.run).toHaveBeenCalledWith('npm run build', { cwd: '/tmp/project' });
  });

  it('routes runArgs("composer", ...) to container', async () => {
    const { container, run } = makeContainerRunner();
    const fallback = makeFallbackRunner();
    const runner = new ComposerContainerCommandRunner({ container, fallback, dryRun: false });

    await runner.runArgs('composer', ['diagnose', '--no-interaction'], {});

    expect(run).toHaveBeenCalledWith(['composer', 'diagnose', '--no-interaction']);
    expect(fallback.runArgs).not.toHaveBeenCalled();
  });
});

describe('ComposerContainerCommandRunner — dryRun=true branches', () => {
  it('run() returns early with dryRun result when dryRun=true', async () => {
    const { container } = makeContainerRunner();
    const fallback = makeFallbackRunner();
    const runner = new ComposerContainerCommandRunner({ container, fallback, dryRun: true });

    const result = await runner.run('composer install');
    expect(result.dryRun).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('runArgs() returns early with dryRun result when dryRun=true', async () => {
    const { container } = makeContainerRunner();
    const fallback = makeFallbackRunner();
    const runner = new ComposerContainerCommandRunner({ container, fallback, dryRun: true });

    const result = await runner.runArgs('composer', ['install']);
    expect(result.dryRun).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('delegates non-composer runArgs() to fallback runner (line 107)', async () => {
    const { container } = makeContainerRunner();
    const fallback = makeFallbackRunner();
    const runner = new ComposerContainerCommandRunner({ container, fallback, dryRun: false });

    await runner.runArgs('git', ['status']);

    expect(container.run).not.toHaveBeenCalled();
    expect(fallback.runArgs).toHaveBeenCalledWith('git', ['status'], undefined);
  });

  it('dryRun defaults to false when not provided (line 59 ?? false branch)', async () => {
    const { container } = makeContainerRunner();
    const fallback = makeFallbackRunner();
    const runner = new ComposerContainerCommandRunner({ container, fallback });
    expect((runner as any).dryRun).toBe(false);
  });

  it('run() with empty command falls back to fallback (extractComposerArgs ?? [] + parts.length===0 branches)', async () => {
    const { container } = makeContainerRunner();
    const fallback = makeFallbackRunner();
    const runner = new ComposerContainerCommandRunner({ container, fallback });
    await runner.run('');
    expect(fallback.run).toHaveBeenCalled();
    expect(container.run).not.toHaveBeenCalled();
  });
});
