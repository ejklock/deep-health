import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ComposerDockerRunner } from '@infra/provisioner/composer-runner';
import { COMPOSER_DEFAULT_IMAGE } from '@infra/provisioner/php-profiles';

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

describe('ComposerDockerRunner runStreaming', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('streams stdout/stderr and returns captured output', async () => {
    const child = makeMockChild();
    mockSpawn.mockReturnValue(child as never);

    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('Installing dependencies\nDone\n'));
      child.stderr.emit('data', Buffer.from('Composer warning\n'));
      child.emit('close', 0);
    });

    const runner = new ComposerDockerRunner({ projectDir: '/tmp/project' });
    const result = await runner.runStreaming(['composer', 'install']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Installing dependencies');
    expect(result.stderr).toContain('Composer warning');

    const writes = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(writes.some((line) => line.includes('[INFO]  [composer] Installing dependencies'))).toBe(true);
  });
});

describe('ComposerDockerRunner._buildDockerArgs', () => {
  it('includes volume mount and workdir', () => {
    const runner = new ComposerDockerRunner({ projectDir: '/my/project', image: 'php:8.2-cli' });
    const args = runner._buildDockerArgs(['composer', 'update']);
    expect(args).toContain('--volume');
    expect(args).toContain('/my/project:/project');
    expect(args).toContain('--workdir');
    expect(args).toContain('/project');
  });

  it('uses sh -lc to wrap command tokens', () => {
    const runner = new ComposerDockerRunner({ projectDir: '/my/project', image: 'php:8.2-cli' });
    const args = runner._buildDockerArgs(['php', '-v']);
    const shIndex = args.indexOf('sh');
    expect(shIndex).toBeGreaterThan(0);
    expect(args[shIndex + 1]).toBe('-lc');
    expect(args[shIndex + 2]).toBe('php -v');
  });

  it('falls back to COMPOSER_DEFAULT_IMAGE when no image is specified', () => {
    const runner = new ComposerDockerRunner({ projectDir: '/my/project' });
    const args = runner._buildDockerArgs(['composer', '--version']);
    expect(args).toContain(COMPOSER_DEFAULT_IMAGE);
  });
});

import { execFile } from 'node:child_process';
const mockExecFileComposer = vi.mocked(execFile);

describe('ComposerDockerRunner.run() (lines 139-155)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns exitCode 0 with stdout/stderr on success', async () => {
    (mockExecFileComposer as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_file: string, _args: string[], cb: (err: null, result: { stdout: string; stderr: string }) => void) => {
        cb(null, { stdout: 'Nothing to install', stderr: '' });
      },
    );
    const runner = new ComposerDockerRunner({ projectDir: '/project' });
    const result = await runner.run(['composer', 'install']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('Nothing to install');
  });

  it('returns non-zero exitCode when docker exits with error', async () => {
    const err = Object.assign(new Error('docker crashed'), { code: 125, stdout: '', stderr: 'container failed' });
    (mockExecFileComposer as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_file: string, _args: string[], cb: (err: Error) => void) => {
        cb(err);
      },
    );
    const runner = new ComposerDockerRunner({ projectDir: '/project' });
    const result = await runner.run(['composer', 'install']);
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe('container failed');
  });
});

describe('ComposerDockerRunner.runStreaming() — spawn error path (lines 122-129)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves with exitCode 1 and error message when spawn emits error', async () => {
    const child = new EventEmitter() as ReturnType<typeof makeMockChild>;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    mockSpawn.mockReturnValue(child as never);

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    queueMicrotask(() => {
      child.emit('error', new Error('spawn ENOENT'));
    });

    const runner = new ComposerDockerRunner({ projectDir: '/project' });
    const result = await runner.runStreaming(['composer', 'install']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('spawn ENOENT');

    stderrSpy.mockRestore();
  });
});
