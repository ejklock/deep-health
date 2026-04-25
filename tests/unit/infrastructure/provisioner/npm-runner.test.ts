/**
 * Coverage for src/infrastructure/provisioner/npm-runner.ts
 * Covers:
 *   - resolveNpmDockerImage() branches
 *   - NpmDockerRunner._buildDockerArgs() — all flag branches
 *   - NpmDockerRunner.run() — catch branch edge cases
 *   - NpmDockerRunner.runStreaming() — close with null code
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

import { resolveNpmDockerImage, NpmDockerRunner } from '@infra/provisioner/npm-runner';
import { needsHostGateway, resolvePlatform } from '@infra/utils/docker-platform';
import { execFile, spawn } from 'node:child_process';

describe('resolveNpmDockerImage()', () => {
  it('returns node:lts when no version given', () => {
    expect(resolveNpmDockerImage()).toBe('node:lts');
  });

  it('returns node:lts for empty string', () => {
    expect(resolveNpmDockerImage('')).toBe('node:lts');
  });

  it('returns node:lts for whitespace-only string', () => {
    expect(resolveNpmDockerImage('  ')).toBe('node:lts');
  });

  it('returns major-only image for "20.11.1"', () => {
    expect(resolveNpmDockerImage('20.11.1')).toBe('node:20');
  });

  it('returns node:lts when major part is non-numeric (e.g. "lts")', () => {
    expect(resolveNpmDockerImage('lts')).toBe('node:lts');
  });

  it('returns node:22 for "22" (single number)', () => {
    expect(resolveNpmDockerImage('22')).toBe('node:22');
  });
});

describe('NpmDockerRunner._buildDockerArgs()', () => {
  it('includes standard docker run args', () => {
    const runner = new NpmDockerRunner({ projectDir: '/project' });
    const args = runner._buildDockerArgs(['install']);
    expect(args).toContain('run');
    expect(args).toContain('--rm');
    expect(args).toContain('npm');
    expect(args).toContain('install');
    expect(args.join(' ')).toContain('/project');
  });

  it('includes --platform when resolvePlatform returns a value', async () => {
    // Re-import the mock after resetting
    vi.mocked(resolvePlatform).mockReturnValueOnce('linux/amd64');
    const runner = new NpmDockerRunner({ projectDir: '/project', platform: 'linux/amd64' as any });
    const args = runner._buildDockerArgs(['ci']);
    expect(args).toContain('--platform');
    expect(args).toContain('linux/amd64');
  });

  it('does not include --platform when not configured', () => {
    const runner = new NpmDockerRunner({ projectDir: '/project' });
    const args = runner._buildDockerArgs(['install']);
    expect(args).not.toContain('--platform');
  });

  it('includes --add-host when needsHostGateway returns true (line 186-187)', async () => {
    vi.mocked(needsHostGateway).mockReturnValue(true);
    const runner = new NpmDockerRunner({ projectDir: '/project' });
    const args = runner._buildDockerArgs(['install']);
    vi.mocked(needsHostGateway).mockReturnValue(false);
    const idx = args.indexOf('--add-host');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('host.docker.internal:host-gateway');
  });
});

describe('NpmDockerRunner.run() — catch branch edge cases', () => {
  it('uses exitCode=1 and String(err) when spawnErr has no code/stdout/stderr/message (lines 160-162)', async () => {
    const mockExecFile = vi.mocked(execFile) as unknown as Mock;
    mockExecFile.mockImplementation((_cmd: string, _args: string[], cb: Function) => {
      cb(Object.assign('string-err', {}));
    });
    const runner = new NpmDockerRunner({ projectDir: '/p' });
    const result = await runner.run(['install']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('string-err');
  });

  it('uses spawnErr.code when it is a number (line 160 true branch)', async () => {
    const mockExecFile = vi.mocked(execFile) as unknown as Mock;
    mockExecFile.mockImplementation((_cmd: string, _args: string[], cb: Function) => {
      cb(Object.assign(new Error('exit'), { code: 2, stdout: 'out', stderr: 'err' }));
    });
    const runner = new NpmDockerRunner({ projectDir: '/p' });
    const result = await runner.run(['install']);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('out');
    expect(result.stderr).toBe('err');
  });
});

describe('NpmDockerRunner._buildShellDockerArgs()', () => {
  it('routes to sh -c with command as single argv element', () => {
    const runner = new NpmDockerRunner({ projectDir: '/myproject' });
    const args = runner._buildShellDockerArgs('jest --coverage', '/myproject');
    const last3 = args.slice(-3);
    expect(last3).toEqual(['sh', '-c', 'jest --coverage']);
  });

  it('mounts the provided cwd as /project', () => {
    const runner = new NpmDockerRunner({ projectDir: '/defaultdir' });
    const args = runner._buildShellDockerArgs('jest --coverage', '/myproject');
    expect(args.join(' ')).toContain('/myproject:/project');
  });

  it('passes compound shell command as a single argv element (not split)', () => {
    const runner = new NpmDockerRunner({ projectDir: '/p' });
    const args = runner._buildShellDockerArgs('echo hello world && ls');
    const last3 = args.slice(-3);
    expect(last3).toEqual(['sh', '-c', 'echo hello world && ls']);
  });

  it('falls back to projectDir when no cwd provided', () => {
    const runner = new NpmDockerRunner({ projectDir: '/defaultdir' });
    const args = runner._buildShellDockerArgs('jest');
    expect(args.join(' ')).toContain('/defaultdir:/project');
  });
});

describe('NpmDockerRunner.runStreaming() — null close code (line 122)', () => {
  it('uses exitCode=1 when close event fires with null code', async () => {
    const mockSpawn = vi.mocked(spawn) as unknown as Mock;
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    mockSpawn.mockReturnValue(child);

    const runner = new NpmDockerRunner({ projectDir: '/p' });
    const resultPromise = runner.runStreaming(['install']);
    // emit close with null (null code → ?? 1)
    child.emit('close', null);
    const result = await resultPromise;
    expect(result.exitCode).toBe(1);
  });
});
