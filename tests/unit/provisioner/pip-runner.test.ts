import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PipDockerRunner, resolvePipDockerImage, PIP_DEFAULT_IMAGE } from '@infra/provisioner/pip-runner';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';

const mockSpawn = vi.mocked(spawn);

function makeMockChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

describe('PipDockerRunner runStreaming', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('streams stdout/stderr as info logs and returns captured output', async () => {
    const child = makeMockChild();
    mockSpawn.mockReturnValue(child as never);

    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('Collecting requests\nInstalling\n'));
      child.stderr.emit('data', Buffer.from('WARNING: pip is out of date\n'));
      child.emit('close', 0);
    });

    const runner = new PipDockerRunner({ projectDir: '/tmp/project' });
    const result = await runner.runStreaming(['pip', 'install', '-U', 'requests']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Collecting requests');
    expect(result.stderr).toContain('WARNING: pip is out of date');

    const writes = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(writes.some((line) => line.includes('[INFO]  [pip] Collecting requests'))).toBe(true);
  });

  it('returns spawn error diagnostics when docker process fails to start', async () => {
    const child = makeMockChild();
    mockSpawn.mockReturnValue(child as never);

    queueMicrotask(() => {
      child.emit('error', new Error('spawn docker ENOENT'));
    });

    const runner = new PipDockerRunner({ projectDir: '/tmp/project' });
    const result = await runner.runStreaming(['pip', 'install', 'requests']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('spawn docker ENOENT');
  });
});

describe('resolvePipDockerImage', () => {
  it('PIP_DEFAULT_IMAGE is python:3-slim', () => {
    expect(PIP_DEFAULT_IMAGE).toBe('python:3-slim');
  });

  it('returns PIP_DEFAULT_IMAGE for undefined', () => {
    expect(resolvePipDockerImage(undefined)).toBe('python:3-slim');
  });

  it('returns PIP_DEFAULT_IMAGE for empty string', () => {
    expect(resolvePipDockerImage('')).toBe('python:3-slim');
  });

  it('returns PIP_DEFAULT_IMAGE for whitespace-only string', () => {
    expect(resolvePipDockerImage('   ')).toBe('python:3-slim');
  });

  it('resolves "3.11" → "python:3.11-slim"', () => {
    expect(resolvePipDockerImage('3.11')).toBe('python:3.11-slim');
  });

  it('resolves "3.11.2" → "python:3.11-slim" (major.minor only)', () => {
    expect(resolvePipDockerImage('3.11.2')).toBe('python:3.11-slim');
  });

  it('resolves bare "3" → "python:3-slim"', () => {
    expect(resolvePipDockerImage('3')).toBe('python:3-slim');
  });

  it('returns PIP_DEFAULT_IMAGE for non-numeric input "abc"', () => {
    expect(resolvePipDockerImage('abc')).toBe('python:3-slim');
  });

  it('returns PIP_DEFAULT_IMAGE for "v3.11" (has non-digit prefix in first segment)', () => {
    // v3.11 → segments: ["v3", "11"] — "v3" is not numeric → default
    expect(resolvePipDockerImage('v3.11')).toBe('python:3-slim');
  });
});

describe('PipDockerRunner._buildDockerArgs', () => {
  it('includes volume mount and workdir', () => {
    const runner = new PipDockerRunner({ projectDir: '/my/project', image: 'python:3.11-slim' });
    const args = runner._buildDockerArgs(['pip', 'install', 'requests']);
    expect(args).toContain('--volume');
    expect(args).toContain('/my/project:/project');
    expect(args).toContain('--workdir');
    expect(args).toContain('/project');
  });

  it('uses sh -lc to wrap the command tokens', () => {
    const runner = new PipDockerRunner({ projectDir: '/my/project', image: 'python:3.11-slim' });
    const args = runner._buildDockerArgs(['pip', 'check']);
    const shIndex = args.indexOf('sh');
    expect(shIndex).toBeGreaterThan(0);
    expect(args[shIndex + 1]).toBe('-lc');
    expect(args[shIndex + 2]).toBe('pip check');
  });

  it('uses the specified image', () => {
    const runner = new PipDockerRunner({ projectDir: '/my/project', image: 'python:3.9-slim' });
    const args = runner._buildDockerArgs(['pip', 'list']);
    expect(args).toContain('python:3.9-slim');
  });

  it('falls back to PIP_DEFAULT_IMAGE when no image specified', () => {
    const runner = new PipDockerRunner({ projectDir: '/my/project' });
    const args = runner._buildDockerArgs(['pip', 'list']);
    expect(args).toContain(PIP_DEFAULT_IMAGE);
  });
});
