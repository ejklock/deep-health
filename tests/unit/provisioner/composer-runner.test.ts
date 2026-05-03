import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { COMPOSER_BOOTSTRAP, isPhpCliImage } from '@infra/provisioner/composer-runner';
import { COMPOSER_DEFAULT_IMAGE } from '@infra/provisioner/php-profiles';
import { EphemeralEcosystemContainer } from '@infra/ecosystem-runtime/ephemeral-container';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('@infra/utils/docker-platform', () => ({
  needsHostGateway: vi.fn().mockReturnValue(false),
  resolvePlatform: vi.fn().mockReturnValue(undefined),
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

function makeComposerContainer(projectDir = '/tmp/project', image = COMPOSER_DEFAULT_IMAGE) {
  return new EphemeralEcosystemContainer({
    runMode: {
      kind: 'shell-wrap',
      preamble: (img: string) => isPhpCliImage(img) ? COMPOSER_BOOTSTRAP : undefined,
    },
    projectDir,
    image,
    logPrefix: 'composer',
  });
}

describe('EphemeralEcosystemContainer runStreaming (composer mode)', () => {
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

    const runner = makeComposerContainer();
    const result = await runner.runStreaming(['composer', 'install']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Installing dependencies');
    expect(result.stderr).toContain('Composer warning');

    const writes = stderrSpy.mock.calls.map((c) => String(c[0]).replace(/\x1B\[[0-9;]*m/g, ''));
    expect(writes.some((line) => line.includes('[composer] Installing dependencies'))).toBe(true);
  });
});

describe('EphemeralEcosystemContainer._buildDockerArgs (composer mode)', () => {
  it('includes volume mount and workdir', () => {
    const runner = makeComposerContainer('/my/project', 'php:8.2-cli');
    const args = runner._buildDockerArgs(['composer', 'update']);
    expect(args).toContain('--volume');
    expect(args).toContain('/my/project:/project');
    expect(args).toContain('--workdir');
    expect(args).toContain('/project');
  });

  it('uses sh -lc to wrap command tokens (non-php-cli image)', () => {
    const runner = makeComposerContainer('/my/project', 'composer:2');
    const args = runner._buildDockerArgs(['php', '-v']);
    const shIndex = args.indexOf('sh');
    expect(shIndex).toBeGreaterThan(0);
    expect(args[shIndex + 1]).toBe('-lc');
    expect(args[shIndex + 2]).toBe('php -v');
  });

  it('prepends composer bootstrap when image is php:*-cli', () => {
    const runner = makeComposerContainer('/my/project', 'php:8.2-cli');
    const args = runner._buildDockerArgs(['composer', 'install']);
    const shIndex = args.indexOf('sh');
    expect(shIndex).toBeGreaterThan(0);
    expect(args[shIndex + 1]).toBe('-lc');
    const shellCmd = args[shIndex + 2];
    expect(shellCmd).toContain('getcomposer.org/installer');
    expect(shellCmd).toContain('/usr/local/bin');
    expect(shellCmd).toMatch(/&&\s*composer install$/);
  });

  it('bootstrap ensures git/unzip are present on php:*-cli images', () => {
    const runner = makeComposerContainer('/my/project', 'php:8.2-cli');
    const args = runner._buildDockerArgs(['composer', 'install']);
    const shellCmd = args[args.indexOf('sh') + 2] as string;
    expect(shellCmd).toContain('command -v git');
    expect(shellCmd).toContain('command -v unzip');
    expect(shellCmd).toContain('apt-get install -y --no-install-recommends git unzip');
  });

  it('falls back to COMPOSER_DEFAULT_IMAGE when no image is specified', () => {
    const runner = makeComposerContainer('/my/project');
    const args = runner._buildDockerArgs(['composer', '--version']);
    expect(args).toContain(COMPOSER_DEFAULT_IMAGE);
  });
});

import { execFile } from 'node:child_process';
const mockExecFileComposer = vi.mocked(execFile);

describe('EphemeralEcosystemContainer.run() (composer mode)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns exitCode 0 with stdout/stderr on success', async () => {
    (mockExecFileComposer as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_file: string, _args: string[], cb: (err: null, stdout: string, stderr: string) => void) => {
        cb(null, 'Nothing to install', '');
      },
    );
    const runner = makeComposerContainer('/project');
    const result = await runner.run(['composer', 'install']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('Nothing to install');
  });

  it('returns non-zero exitCode when docker exits with error', async () => {
    const err = Object.assign(new Error('docker crashed'), { code: 125, stdout: '', stderr: 'container failed' });
    let callCount = 0;
    (mockExecFileComposer as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_file: string, _args: string[], cb: Function) => {
        callCount++;
        if (callCount === 1) {
          // First call: _ensureImagePresent docker image inspect → succeed (image cached)
          cb(null, '[]', '');
        } else {
          cb(err);
        }
      },
    );
    const runner = makeComposerContainer('/project');
    const result = await runner.run(['composer', 'install']);
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe('container failed');
  });
});

describe('EphemeralEcosystemContainer.runStreaming() — spawn error path (composer mode)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves with exitCode 1 and error message when spawn emits error', async () => {
    const child = makeMockChild();
    mockSpawn.mockReturnValue(child as never);

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    queueMicrotask(() => {
      child.emit('error', new Error('spawn ENOENT'));
    });

    const runner = makeComposerContainer('/project');
    const result = await runner.runStreaming(['composer', 'install']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('spawn ENOENT');

    stderrSpy.mockRestore();
  });
});
