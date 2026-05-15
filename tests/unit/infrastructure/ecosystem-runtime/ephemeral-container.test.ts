/**
 * Tests for EphemeralEcosystemContainer — specifically entrypointOverride injection
 * into `docker run` args, and general _buildDockerArgs correctness for both RunModes.
 *
 * Covers the regression case: --entrypoint "" must be injected when entrypointOverride=""
 * (for project-built images) so the image ENTRYPOINT cannot shadow the ecosystem CLI.
 *
 * Also covers the pull timeout path in _ensureImagePresent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@infra/utils/docker-platform', () => ({
  needsHostGateway: () => false,
  resolvePlatform: (p: string | undefined) => p,
}));

vi.mock('@infra/utils/retry', () => ({
  withRetry: async (fn: () => Promise<unknown>) => fn(),
  isDockerTransientError: () => false,
}));

import { EphemeralEcosystemContainer } from '@infra/ecosystem-runtime/ephemeral-container';
import { CLI_NAME } from '@infra/brand';
import type { RunMode } from '@infra/ecosystem-runtime/types';

function makeContainer(opts: {
  runMode?: RunMode;
  image?: string;
  entrypointOverride?: string;
}) {
  return new EphemeralEcosystemContainer({
    runMode: opts.runMode ?? { kind: 'direct-exec', binary: 'npm' },
    projectDir: '/project',
    image: opts.image ?? 'node:20',
    logPrefix: 'npm',
    entrypointOverride: opts.entrypointOverride,
  });
}

describe('EphemeralEcosystemContainer — _buildDockerArgs', () => {
  // ─── entrypointOverride propagation ────────────────────────────────────────

  it('injects --entrypoint "" into docker run args when entrypointOverride is set to ""', () => {
    const container = makeContainer({ entrypointOverride: '' });
    const args = container._buildDockerArgs(['install']);

    const entrypointIdx = args.indexOf('--entrypoint');
    expect(entrypointIdx).toBeGreaterThan(-1);
    expect(args[entrypointIdx + 1]).toBe('');
  });

  it('does NOT inject --entrypoint when entrypointOverride is undefined', () => {
    const container = makeContainer({ entrypointOverride: undefined });
    const args = container._buildDockerArgs(['install']);
    expect(args).not.toContain('--entrypoint');
  });

  it('injects --entrypoint with a custom value when entrypointOverride is a non-empty string', () => {
    const container = makeContainer({ entrypointOverride: '/custom/entrypoint' });
    const args = container._buildDockerArgs(['run']);
    const idx = args.indexOf('--entrypoint');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('/custom/entrypoint');
  });

  // ─── --entrypoint appears BEFORE the image name ───────────────────────────

  it('places --entrypoint before the image name in the arg list', () => {
    const container = makeContainer({ image: `${CLI_NAME}-project/npm:abc123`, entrypointOverride: '' });
    const args = container._buildDockerArgs(['ci']);

    const entrypointIdx = args.indexOf('--entrypoint');
    const imageIdx = args.indexOf(`${CLI_NAME}-project/npm:abc123`);
    expect(entrypointIdx).toBeGreaterThan(-1);
    expect(imageIdx).toBeGreaterThan(-1);
    expect(entrypointIdx).toBeLessThan(imageIdx);
  });

  // ─── direct-exec without preamble ─────────────────────────────────────────

  it('produces correct args for direct-exec without preamble', () => {
    const container = makeContainer({
      runMode: { kind: 'direct-exec', binary: 'npm' },
      image: 'node:20',
    });
    const args = container._buildDockerArgs(['install', '--frozen-lockfile']);

    expect(args[0]).toBe('run');
    expect(args[1]).toBe('--rm');
    expect(args).toContain('node:20');
    expect(args).toContain('npm');
    expect(args).toContain('install');
    expect(args).toContain('--frozen-lockfile');
  });

  // ─── direct-exec with preamble ────────────────────────────────────────────

  it('wraps argv in sh -lc with preamble for direct-exec with preamble', () => {
    const container = makeContainer({
      runMode: {
        kind: 'direct-exec',
        binary: 'npm',
        preamble: () => 'apt-get install -y libvips',
      },
      image: 'node:20',
    });
    const args = container._buildDockerArgs(['install']);

    expect(args).toContain('sh');
    expect(args).toContain('-lc');
    const shCmd = args[args.indexOf('-lc') + 1];
    expect(shCmd).toContain('apt-get install -y libvips');
    expect(shCmd).toContain('exec "$@"');
  });

  // ─── shell-wrap without preamble ──────────────────────────────────────────

  it('joins tokens in sh -lc for shell-wrap without preamble', () => {
    const container = makeContainer({
      runMode: { kind: 'shell-wrap' },
      image: 'composer:2',
    });
    const args = container._buildDockerArgs(['install', '--no-interaction']);

    expect(args).toContain('sh');
    expect(args).toContain('-lc');
    const shCmd = args[args.indexOf('-lc') + 1];
    expect(shCmd).toBe('install --no-interaction');
  });

  // ─── shell-wrap with preamble ─────────────────────────────────────────────

  it('prepends preamble before joined tokens in shell-wrap with preamble', () => {
    const container = makeContainer({
      runMode: {
        kind: 'shell-wrap',
        preamble: () => 'curl -sS https://getcomposer.org/installer | php',
      },
      image: 'php:8.2-cli',
    });
    const args = container._buildDockerArgs(['install']);

    const shCmd = args[args.indexOf('-lc') + 1];
    expect(shCmd).toContain('curl -sS https://getcomposer.org/installer | php');
    expect(shCmd).toContain('install');
  });

  // ─── Security: --cap-drop=ALL and --security-opt ──────────────────────────

  it('always includes --cap-drop=ALL and --security-opt no-new-privileges', () => {
    const container = makeContainer({});
    const args = container._buildDockerArgs(['install']);
    expect(args).toContain('--cap-drop=ALL');
    expect(args).toContain('--security-opt');
    expect(args).toContain('no-new-privileges');
  });

  // ─── Volume mount ─────────────────────────────────────────────────────────

  it('mounts projectDir at /project with --workdir /project', () => {
    const container = makeContainer({});
    const args = container._buildDockerArgs(['install']);
    expect(args).toContain('--volume');
    const volIdx = args.indexOf('--volume');
    expect(args[volIdx + 1]).toContain('/project:/project');
    expect(args).toContain('--workdir');
    expect(args[args.indexOf('--workdir') + 1]).toBe('/project');
  });
});

// ─── _ensureImagePresent pull timeout ────────────────────────────────────────

describe('EphemeralEcosystemContainer — pull timeout', () => {
  let spawnStreamingMock: ReturnType<typeof vi.fn>;
  let execFileMock: ReturnType<typeof vi.fn>;
  let warnSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    spawnStreamingMock = vi.fn();
    execFileMock = vi.fn();
    warnSpy = vi.fn();

    vi.doMock('@infra/utils/spawn-streaming', () => ({
      spawnStreaming: spawnStreamingMock,
    }));

    vi.doMock('@infra/utils/logger', () => ({
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: warnSpy,
        error: vi.fn(),
        tagged: vi.fn(),
        phase: vi.fn(),
        skip: vi.fn(),
        header: vi.fn(),
      },
    }));

    vi.doMock('@infra/utils/docker-platform', () => ({
      needsHostGateway: () => false,
      resolvePlatform: (p: string | undefined) => p,
    }));

    vi.doMock('@infra/utils/retry', () => ({
      withRetry: async (fn: () => Promise<unknown>) => fn(),
      isDockerTransientError: () => false,
    }));

    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      return {
        ...actual,
        execFile: execFileMock,
        spawn: vi.fn(),
      };
    });

    vi.doMock('node:util', () => ({
      promisify: (fn: unknown) => {
        // promisify of execFile — return a function that calls execFileMock as promise
        return (...args: unknown[]) =>
          new Promise((resolve, reject) => {
            execFileMock(...args, (err: unknown, result: unknown) => {
              if (err) reject(err);
              else resolve(result);
            });
          });
      },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('passes timeoutMs to spawnStreaming during docker pull', async () => {
    // docker image inspect fails → image not cached → pull happens
    execFileMock.mockImplementation(
      (_file: unknown, _args: unknown, callback: (err: Error | null, result?: unknown) => void) => {
        callback(new Error('image not found'));
      },
    );

    spawnStreamingMock.mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
    });

    const { EphemeralEcosystemContainer: Container } = await import(
      '@infra/ecosystem-runtime/ephemeral-container'
    );

    const container = new Container({
      runMode: { kind: 'direct-exec', binary: 'npm' },
      projectDir: '/project',
      image: 'node:20',
      logPrefix: 'npm',
    });

    // run() calls _ensureImagePresent internally
    // We stub it by spying; instead just verify spawnStreaming was called with timeoutMs
    await container.run(['--version']).catch(() => {
      // docker run itself may fail since execFile is mocked — that's fine
    });

    expect(spawnStreamingMock).toHaveBeenCalledWith(
      expect.objectContaining({
        file: 'docker',
        args: ['pull', 'node:20'],
        timeoutMs: 300_000,
      }),
    );
  });

  it('logs a warning when docker pull times out', async () => {
    execFileMock.mockImplementation(
      (_file: unknown, _args: unknown, callback: (err: Error | null, result?: unknown) => void) => {
        callback(new Error('image not found'));
      },
    );

    spawnStreamingMock.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'Timed out after 300000ms',
      timedOut: true,
    });

    const { EphemeralEcosystemContainer: Container } = await import(
      '@infra/ecosystem-runtime/ephemeral-container'
    );
    const { logger } = await import('@infra/utils/logger');

    const container = new Container({
      runMode: { kind: 'direct-exec', binary: 'npm' },
      projectDir: '/project',
      image: 'node:20',
      logPrefix: 'npm',
    });

    await container.run(['--version']).catch(() => {});

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Docker pull timed out'),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('node:20'),
    );
  });

  it('does NOT log a warning when docker pull succeeds (timedOut=false)', async () => {
    execFileMock.mockImplementation(
      (_file: unknown, _args: unknown, callback: (err: Error | null, result?: unknown) => void) => {
        callback(new Error('image not found'));
      },
    );

    spawnStreamingMock.mockResolvedValue({
      exitCode: 0,
      stdout: 'Digest: sha256:abc',
      stderr: '',
      timedOut: false,
    });

    const { EphemeralEcosystemContainer: Container } = await import(
      '@infra/ecosystem-runtime/ephemeral-container'
    );
    const { logger } = await import('@infra/utils/logger');

    const container = new Container({
      runMode: { kind: 'direct-exec', binary: 'npm' },
      projectDir: '/project',
      image: 'node:20',
      logPrefix: 'npm',
    });

    await container.run(['--version']).catch(() => {});

    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('Docker pull timed out'),
    );
  });
});
