/**
 * Coverage for src/infrastructure/provisioner/pip-runner.ts
 * and EphemeralEcosystemContainer with shell-wrap RunMode (pip).
 */
import { describe, it, expect, vi, type Mock } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('@infra/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), phase: vi.fn(), skip: vi.fn(), header: vi.fn(), tagged: vi.fn() },
}));

vi.mock('@infra/utils/docker-platform', () => ({
  needsHostGateway: vi.fn().mockReturnValue(false),
  resolvePlatform: vi.fn().mockReturnValue(undefined),
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

import { resolvePipDockerImage } from '@infra/provisioner/pip-runner';
import { EphemeralEcosystemContainer } from '@infra/ecosystem-runtime/ephemeral-container';
import { execFile, spawn } from 'node:child_process';
import { needsHostGateway, resolvePlatform } from '@infra/utils/docker-platform';

const shellWrapRunMode = { kind: 'shell-wrap' as const };

function makePipContainer(opts: { projectDir?: string; image?: string; platform?: string } = {}) {
  return new EphemeralEcosystemContainer({
    runMode: shellWrapRunMode,
    projectDir: opts.projectDir ?? '/project',
    image: opts.image ?? 'python:3-slim',
    logPrefix: 'pip',
    platform: opts.platform,
  });
}

describe('resolvePipDockerImage()', () => {
  it('returns python:3-slim when no version given', () => {
    expect(resolvePipDockerImage()).toBe('python:3-slim');
  });

  it('returns python:3-slim for empty string', () => {
    expect(resolvePipDockerImage('')).toBe('python:3-slim');
  });

  it('returns python:3.11-slim for "3.11.2"', () => {
    expect(resolvePipDockerImage('3.11.2')).toBe('python:3.11-slim');
  });

  it('returns python:3-slim for "3"', () => {
    expect(resolvePipDockerImage('3')).toBe('python:3-slim');
  });

  it('returns python:3-slim when version starts with non-numeric', () => {
    expect(resolvePipDockerImage('abc')).toBe('python:3-slim');
  });
});

describe('EphemeralEcosystemContainer._buildDockerArgs() — shell-wrap mode (pip)', () => {
  it('builds basic docker args', () => {
    const runner = makePipContainer({ projectDir: '/project' });
    const args = runner._buildDockerArgs(['pip', 'install', 'requests']);
    expect(args).toContain('run');
    expect(args).toContain('--rm');
    expect(args.join(' ')).toContain('/project');
  });

  it('includes --platform when resolvePlatform returns a value', async () => {
    vi.mocked(resolvePlatform).mockReturnValueOnce('linux/amd64');
    const runner = makePipContainer({ projectDir: '/project', platform: 'linux/amd64' });
    const args = runner._buildDockerArgs(['pip', 'install', 'x']);
    expect(args).toContain('--platform');
  });

  it('includes --add-host when needsHostGateway returns true', async () => {
    vi.mocked(needsHostGateway).mockReturnValueOnce(true);
    const runner = makePipContainer({ projectDir: '/project' });
    const args = runner._buildDockerArgs(['pip', 'install', 'x']);
    const idx = args.indexOf('--add-host');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('host.docker.internal:host-gateway');
  });

  it('passes tokens via sh -lc (shell-wrap mode)', () => {
    const runner = makePipContainer({ projectDir: '/project', image: 'python:3.11-slim' });
    const args = runner._buildDockerArgs(['pip', 'check']);
    const shIndex = args.indexOf('sh');
    expect(shIndex).toBeGreaterThan(0);
    expect(args[shIndex + 1]).toBe('-lc');
    expect(args[shIndex + 2]).toBe('pip check');
  });
});

describe('EphemeralEcosystemContainer.run() — catch branch edge cases (pip mode)', () => {
  it('uses exitCode=1 and String(err) when spawnErr has no fields', async () => {
    const mockExecFile = vi.mocked(execFile) as unknown as Mock;
    mockExecFile.mockImplementation((_cmd: string, _args: string[], cb: Function) => {
      cb('string-err');
    });
    const runner = makePipContainer({ projectDir: '/p' });
    const result = await runner.run(['install', 'requests']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('string-err');
  });

  it('uses spawnErr.code when it is a number', async () => {
    const mockExecFile = vi.mocked(execFile) as unknown as Mock;
    mockExecFile.mockImplementation((_cmd: string, _args: string[], cb: Function) => {
      cb(Object.assign(new Error('exit'), { code: 3, stdout: 'out', stderr: 'err' }));
    });
    const runner = makePipContainer({ projectDir: '/p' });
    const result = await runner.run(['install', 'requests']);
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe('out');
  });
});

describe('EphemeralEcosystemContainer._buildShellDockerArgs() — pip mode', () => {
  it('routes to sh -c with command as single argv element', () => {
    const runner = makePipContainer({ projectDir: '/myproject' });
    const args = runner._buildShellDockerArgs('pytest --tb=short', '/myproject');
    const last3 = args.slice(-3);
    expect(last3).toEqual(['sh', '-c', 'pytest --tb=short']);
  });

  it('mounts the provided cwd as /project', () => {
    const runner = makePipContainer({ projectDir: '/defaultdir' });
    const args = runner._buildShellDockerArgs('pytest', '/myproject');
    expect(args.join(' ')).toContain('/myproject:/project');
  });

  it('passes compound shell command as a single argv element (not split)', () => {
    const runner = makePipContainer({ projectDir: '/p' });
    const args = runner._buildShellDockerArgs('echo hello world && ls');
    const last3 = args.slice(-3);
    expect(last3).toEqual(['sh', '-c', 'echo hello world && ls']);
  });

  it('falls back to projectDir when no cwd provided', () => {
    const runner = makePipContainer({ projectDir: '/defaultdir' });
    const args = runner._buildShellDockerArgs('pytest');
    expect(args.join(' ')).toContain('/defaultdir:/project');
  });
});

describe('EphemeralEcosystemContainer.runStreaming() — null close code (pip mode)', () => {
  it('uses exitCode=1 when close event fires with null code', async () => {
    const mockSpawn = vi.mocked(spawn) as unknown as Mock;
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    mockSpawn.mockReturnValue(child);

    const runner = makePipContainer({ projectDir: '/p' });
    const resultPromise = runner.runStreaming(['install', 'requests']);
    child.emit('close', null);
    const result = await resultPromise;
    expect(result.exitCode).toBe(1);
  });
});
