import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NpmDockerRunner } from '@infra/provisioner/npm-runner';

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
