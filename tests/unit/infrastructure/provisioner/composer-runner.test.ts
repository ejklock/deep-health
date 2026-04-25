/**
 * Coverage for src/infrastructure/provisioner/composer-runner.ts
 */
import { describe, it, expect, vi, type Mock } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('@infra/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@infra/utils/docker-platform', () => ({
  needsHostGateway: vi.fn().mockReturnValue(false),
  resolvePlatform: vi.fn().mockReturnValue(undefined),
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

import { ComposerDockerRunner } from '@infra/provisioner/composer-runner';
import { execFile, spawn } from 'node:child_process';
import { needsHostGateway, resolvePlatform } from '@infra/utils/docker-platform';

describe('ComposerDockerRunner._buildDockerArgs()', () => {
  it('builds basic docker run args', () => {
    const runner = new ComposerDockerRunner({ projectDir: '/project' });
    const args = runner._buildDockerArgs(['composer', 'install']);
    expect(args).toContain('run');
    expect(args).toContain('--rm');
    expect(args.join(' ')).toContain('/project');
    expect(args).toContain('sh');
    expect(args).toContain('-lc');
  });

  it('includes --platform when resolvePlatform returns a value', async () => {
    vi.mocked(resolvePlatform).mockReturnValueOnce('linux/amd64');
    const runner = new ComposerDockerRunner({ projectDir: '/project', platform: 'linux/amd64' });
    const args = runner._buildDockerArgs(['composer', 'install']);
    expect(args).toContain('--platform');
    expect(args).toContain('linux/amd64');
  });

  it('does not include --platform when not set', () => {
    const runner = new ComposerDockerRunner({ projectDir: '/project' });
    const args = runner._buildDockerArgs(['composer', 'install']);
    expect(args).not.toContain('--platform');
  });

  it('includes --add-host when needsHostGateway returns true (lines 177-178)', async () => {
    vi.mocked(needsHostGateway).mockReturnValueOnce(true);
    const runner = new ComposerDockerRunner({ projectDir: '/project' });
    const args = runner._buildDockerArgs(['composer', 'install']);
    const idx = args.indexOf('--add-host');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('host.docker.internal:host-gateway');
  });
});

describe('ComposerDockerRunner.run() — catch branch edge cases', () => {
  it('uses exitCode=1 and String(err) when spawnErr has no fields (lines 149-151)', async () => {
    const mockExecFile = vi.mocked(execFile) as unknown as Mock;
    mockExecFile.mockImplementation((_cmd: string, _args: string[], cb: Function) => {
      cb('string-err');
    });
    const runner = new ComposerDockerRunner({ projectDir: '/p' });
    const result = await runner.run(['install']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('string-err');
  });

  it('uses spawnErr.code when numeric (line 149 true branch)', async () => {
    const mockExecFile = vi.mocked(execFile) as unknown as Mock;
    mockExecFile.mockImplementation((_cmd: string, _args: string[], cb: Function) => {
      cb(Object.assign(new Error('exit'), { code: 5, stdout: 'out', stderr: 'err' }));
    });
    const runner = new ComposerDockerRunner({ projectDir: '/p' });
    const result = await runner.run(['install']);
    expect(result.exitCode).toBe(5);
    expect(result.stdout).toBe('out');
  });
});

describe('ComposerDockerRunner._buildShellDockerArgs()', () => {
  it('routes to sh -c with command as single argv element', () => {
    const runner = new ComposerDockerRunner({ projectDir: '/myproject' });
    const args = runner._buildShellDockerArgs('php artisan test', '/myproject');
    const last3 = args.slice(-3);
    expect(last3).toEqual(['sh', '-c', 'php artisan test']);
  });

  it('mounts the provided cwd as /project', () => {
    const runner = new ComposerDockerRunner({ projectDir: '/defaultdir' });
    const args = runner._buildShellDockerArgs('php artisan test', '/myproject');
    expect(args.join(' ')).toContain('/myproject:/project');
  });

  it('passes compound shell command as a single argv element (not split)', () => {
    const runner = new ComposerDockerRunner({ projectDir: '/p' });
    const args = runner._buildShellDockerArgs('echo hello world && ls');
    const last3 = args.slice(-3);
    expect(last3).toEqual(['sh', '-c', 'echo hello world && ls']);
  });

  it('falls back to projectDir when no cwd provided', () => {
    const runner = new ComposerDockerRunner({ projectDir: '/defaultdir' });
    const args = runner._buildShellDockerArgs('php artisan test');
    expect(args.join(' ')).toContain('/defaultdir:/project');
  });
});

describe('ComposerDockerRunner.runStreaming() — null close code (line 112)', () => {
  it('uses exitCode=1 when close event fires with null code', async () => {
    const mockSpawn = vi.mocked(spawn) as unknown as Mock;
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    mockSpawn.mockReturnValue(child);

    const runner = new ComposerDockerRunner({ projectDir: '/p' });
    const resultPromise = runner.runStreaming(['install']);
    child.emit('close', null);
    const result = await resultPromise;
    expect(result.exitCode).toBe(1);
  });
});
