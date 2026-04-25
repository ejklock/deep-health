import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NpmDockerRunner, resolveNpmDockerImage, NPM_DEFAULT_IMAGE } from '@infra/provisioner/npm-runner';

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

describe('NpmDockerRunner runStreaming', () => {
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
      child.stdout.emit('data', Buffer.from('installing dependencies\nstep 2\n'));
      child.stderr.emit('data', Buffer.from('npm WARN deprecated x\n'));
      child.emit('close', 3);
    });

    const runner = new NpmDockerRunner({ projectDir: '/tmp/project' });
    const result = await runner.runStreaming(['ci']);

    expect(result.exitCode).toBe(3);
    expect(result.stdout).toContain('installing dependencies');
    expect(result.stderr).toContain('npm WARN deprecated x');

    const writes = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(writes.some((line) => line.includes('[INFO]  [npm] installing dependencies'))).toBe(true);
    expect(writes.some((line) => line.includes('[INFO]  [npm] npm WARN deprecated x'))).toBe(true);
  });

  it('returns spawn error diagnostics when docker process fails to start', async () => {
    const child = makeMockChild();
    mockSpawn.mockReturnValue(child as never);

    queueMicrotask(() => {
      child.emit('error', new Error('spawn docker ENOENT'));
    });

    const runner = new NpmDockerRunner({ projectDir: '/tmp/project' });
    const result = await runner.runStreaming(['install']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('spawn docker ENOENT');
  });
});

describe('resolveNpmDockerImage', () => {
  it('NPM_DEFAULT_IMAGE is node:lts', () => {
    expect(NPM_DEFAULT_IMAGE).toBe('node:lts');
  });

  it('returns NPM_DEFAULT_IMAGE for undefined', () => {
    expect(resolveNpmDockerImage(undefined)).toBe('node:lts');
  });

  it('returns NPM_DEFAULT_IMAGE for empty string', () => {
    expect(resolveNpmDockerImage('')).toBe('node:lts');
  });

  it('returns NPM_DEFAULT_IMAGE for whitespace-only string', () => {
    expect(resolveNpmDockerImage('   ')).toBe('node:lts');
  });

  it('resolves major version string "20" to "node:20"', () => {
    expect(resolveNpmDockerImage('20')).toBe('node:20');
  });

  it('extracts major from "20.11.1" → "node:20"', () => {
    expect(resolveNpmDockerImage('20.11.1')).toBe('node:20');
  });

  it('returns NPM_DEFAULT_IMAGE for non-numeric major "abc"', () => {
    expect(resolveNpmDockerImage('abc')).toBe('node:lts');
  });

  it('returns NPM_DEFAULT_IMAGE for "v20" (has non-digit prefix)', () => {
    expect(resolveNpmDockerImage('v20')).toBe('node:lts');
  });
});

import { execFile } from 'node:child_process';
const mockExecFile = vi.mocked(execFile);

describe('NpmDockerRunner.run() (lines 150-166)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns exitCode 0 with stdout/stderr on success', async () => {
    // promisify(execFile) resolves with { stdout, stderr }
    (mockExecFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_file: string, _args: string[], cb: (err: null, result: { stdout: string; stderr: string }) => void) => {
        cb(null, { stdout: 'ok', stderr: '' });
      },
    );
    const runner = new NpmDockerRunner({ projectDir: '/project' });
    const result = await runner.run(['install']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ok');
  });

  it('returns non-zero exitCode and stderr when docker exits with error', async () => {
    const err = Object.assign(new Error('docker failed'), { code: 2, stdout: '', stderr: 'permission denied' });
    (mockExecFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_file: string, _args: string[], cb: (err: Error) => void) => {
        cb(err);
      },
    );
    const runner = new NpmDockerRunner({ projectDir: '/project' });
    const result = await runner.run(['install']);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe('permission denied');
  });
});
