/**
 * Unit tests for OsvDockerRunner.
 *
 * Strategy: mock `node:child_process.execFile` and `node:os` to avoid real
 * Docker calls.  All tests are pure unit tests — no Docker required.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OsvDockerRunner } from '@infra/provisioner/osv-runner';
import type { EphemeralContainerRunner, ContainerRunResult } from '@infra/provisioner/types';

// ─── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('node:child_process', () => ({
  execFile: vi.fn(
    (
      _cmd: string,
      _args: string[],
      callback: (err: null | Error, result: { stdout: string; stderr: string }) => void,
    ) => {
      callback(null, { stdout: '{}', stderr: '' });
    },
  ),
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    platform: vi.fn(() => 'darwin'),
    arch: vi.fn(() => 'x64'),
  };
});

import { execFile } from 'node:child_process';
import { arch as osArch, platform as osPlatform } from 'node:os';

const mockExecFile = vi.mocked(execFile);
const mockArch = vi.mocked(osArch);
const mockPlatform = vi.mocked(osPlatform);

// ─── Helper factories ──────────────────────────────────────────────────────────

function resolveExecFile(stdout = '{}', stderr = '') {
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      callback: (err: null | Error, result: { stdout: string; stderr: string }) => void,
    ) => callback(null, { stdout, stderr }),
  );
}

function rejectExecFile(exitCode: number, stdout = '', stderr = '') {
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      callback: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      const err = Object.assign(new Error('osv-scanner failed'), {
        code: exitCode,
        stdout,
        stderr,
      });
      callback(err, { stdout, stderr });
    },
  );
}

// ─── Contract conformance ──────────────────────────────────────────────────────

describe('OsvDockerRunner — contract conformance', () => {
  it('satisfies EphemeralContainerRunner<string[]> at the type level', () => {
    const runner = new OsvDockerRunner({ projectDir: '/project' });
    // TypeScript will fail at compile time if the contract is not satisfied.
    const typed: EphemeralContainerRunner<string[]> = runner;
    expect(typed).toBeDefined();
  });

  it('run() returns a ContainerRunResult shape', async () => {
    resolveExecFile('{"results":[]}', '');
    const runner = new OsvDockerRunner({ projectDir: '/project' });
    const result: ContainerRunResult = await runner.run([]);
    expect(result).toHaveProperty('exitCode');
    expect(result).toHaveProperty('stdout');
    expect(result).toHaveProperty('stderr');
    expect(typeof result.exitCode).toBe('number');
    expect(typeof result.stdout).toBe('string');
    expect(typeof result.stderr).toBe('string');
  });
});

// ─── OsvDockerRunner ───────────────────────────────────────────────────────────

describe('OsvDockerRunner', () => {
  beforeEach(() => {
    resolveExecFile('{}', '');
    mockArch.mockReturnValue('x64');
    mockPlatform.mockReturnValue('darwin');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── Constructor ──────────────────────────────────────────────────────────────

  describe('constructor', () => {
    it('accepts required options without error', () => {
      expect(() => new OsvDockerRunner({ projectDir: '/app' })).not.toThrow();
    });

    it('accepts custom image option', () => {
      expect(
        () => new OsvDockerRunner({ projectDir: '/app', image: 'ghcr.io/google/osv-scanner:v1' }),
      ).not.toThrow();
    });

    it('accepts platform override option', () => {
      expect(
        () => new OsvDockerRunner({ projectDir: '/app', platform: 'linux/amd64' }),
      ).not.toThrow();
    });

    it('accepts readonly: false option', () => {
      expect(
        () => new OsvDockerRunner({ projectDir: '/app', readonly: false }),
      ).not.toThrow();
    });
  });

  // ── _buildDockerArgs() ───────────────────────────────────────────────────────

  describe('_buildDockerArgs()', () => {
    it('includes "run" and "--rm"', () => {
      const runner = new OsvDockerRunner({ projectDir: '/app' });
      const args = runner._buildDockerArgs([]);
      expect(args).toContain('run');
      expect(args).toContain('--rm');
    });

    it('mounts projectDir at /project read-only by default', () => {
      const runner = new OsvDockerRunner({ projectDir: '/my/project' });
      const args = runner._buildDockerArgs([]);
      const volIdx = args.indexOf('--volume');
      expect(volIdx).toBeGreaterThanOrEqual(0);
      expect(args[volIdx + 1]).toBe('/my/project:/project:ro');
    });

    it('mounts projectDir at /project read-write when readonly: false', () => {
      const runner = new OsvDockerRunner({ projectDir: '/my/project', readonly: false });
      const args = runner._buildDockerArgs([]);
      const volIdx = args.indexOf('--volume');
      expect(volIdx).toBeGreaterThanOrEqual(0);
      expect(args[volIdx + 1]).toBe('/my/project:/project:rw');
    });

    it('sets --workdir /project after --volume', () => {
      const runner = new OsvDockerRunner({ projectDir: '/app' });
      const args = runner._buildDockerArgs([]);
      const wdIdx = args.indexOf('--workdir');
      expect(wdIdx).toBeGreaterThanOrEqual(0);
      expect(args[wdIdx + 1]).toBe('/project');
      const volIdx = args.indexOf('--volume');
      expect(wdIdx).toBeGreaterThan(volIdx);
    });

    it('places --workdir /project before the image', () => {
      const runner = new OsvDockerRunner({ projectDir: '/app' });
      const args = runner._buildDockerArgs([]);
      const wdIdx = args.indexOf('--workdir');
      const imageIdx = args.indexOf('ghcr.io/google/osv-scanner:latest');
      expect(wdIdx).toBeGreaterThanOrEqual(0);
      expect(imageIdx).toBeGreaterThan(wdIdx);
    });

    it('uses default OSV image when none specified', () => {
      const runner = new OsvDockerRunner({ projectDir: '/app' });
      const args = runner._buildDockerArgs([]);
      expect(args).toContain('ghcr.io/google/osv-scanner:latest');
    });

    it('uses custom image when specified', () => {
      const runner = new OsvDockerRunner({
        projectDir: '/app',
        image: 'ghcr.io/google/osv-scanner:v1.9.0',
      });
      const args = runner._buildDockerArgs([]);
      expect(args).toContain('ghcr.io/google/osv-scanner:v1.9.0');
    });

    it('always appends --format json after tool args', () => {
      const runner = new OsvDockerRunner({ projectDir: '/app' });
      const args = runner._buildDockerArgs(['--lockfile', '/project/package-lock.json']);
      expect(args[args.length - 1]).toBe('json');
      expect(args[args.length - 2]).toBe('--format');
    });

    it('passes lockfile args as individual array elements', () => {
      const runner = new OsvDockerRunner({ projectDir: '/app' });
      const lockfileArgs = ['--lockfile', '/project/package-lock.json'];
      const args = runner._buildDockerArgs(lockfileArgs);
      expect(args).toContain('--lockfile');
      expect(args).toContain('/project/package-lock.json');
    });

    it('does NOT include --platform when arch is x64 and no override given', () => {
      mockArch.mockReturnValue('x64');
      const runner = new OsvDockerRunner({ projectDir: '/app' });
      const args = runner._buildDockerArgs([]);
      expect(args).not.toContain('--platform');
    });

    it('does NOT inject --platform on arm64 (OSV image has native arm64 support)', () => {
      mockArch.mockReturnValue('arm64');
      const runner = new OsvDockerRunner({ projectDir: '/app' });
      const args = runner._buildDockerArgs([]);
      expect(args).not.toContain('--platform');
    });

    it('uses explicit platform override on arm64 when provided', () => {
      mockArch.mockReturnValue('arm64');
      const runner = new OsvDockerRunner({ projectDir: '/app', platform: 'linux/amd64' });
      const args = runner._buildDockerArgs([]);
      const idx = args.indexOf('--platform');
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(args[idx + 1]).toBe('linux/amd64');
    });

    it('suppresses --platform when platform option is empty string', () => {
      mockArch.mockReturnValue('arm64');
      const runner = new OsvDockerRunner({ projectDir: '/app', platform: '' });
      const args = runner._buildDockerArgs([]);
      expect(args).not.toContain('--platform');
    });

    it('does NOT add --add-host on darwin', () => {
      mockPlatform.mockReturnValue('darwin');
      const runner = new OsvDockerRunner({ projectDir: '/app' });
      const args = runner._buildDockerArgs([]);
      expect(args).not.toContain('--add-host');
    });

    it('adds --add-host host.docker.internal:host-gateway on linux', () => {
      mockPlatform.mockReturnValue('linux');
      const runner = new OsvDockerRunner({ projectDir: '/app' });
      const args = runner._buildDockerArgs([]);
      const addHostIdx = args.indexOf('--add-host');
      expect(addHostIdx).toBeGreaterThanOrEqual(0);
      expect(args[addHostIdx + 1]).toBe('host.docker.internal:host-gateway');
    });

    it('places --platform before --volume in arg list when platform given', () => {
      mockArch.mockReturnValue('x64');
      const runner = new OsvDockerRunner({ projectDir: '/app', platform: 'linux/amd64' });
      const args = runner._buildDockerArgs([]);
      const platformIdx = args.indexOf('--platform');
      const volumeIdx = args.indexOf('--volume');
      expect(platformIdx).toBeGreaterThanOrEqual(0);
      expect(volumeIdx).toBeGreaterThan(platformIdx);
    });
  });

  // ── run() ────────────────────────────────────────────────────────────────────

  describe('run()', () => {
    it('returns exitCode 0 and stdout on success', async () => {
      resolveExecFile('{"results":[]}', '');
      const runner = new OsvDockerRunner({ projectDir: '/app' });
      const result = await runner.run(['--lockfile', '/project/package-lock.json']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('"results"');
    });

    it('calls execFile with "docker" as the command', async () => {
      const runner = new OsvDockerRunner({ projectDir: '/app' });
      await runner.run([]);
      expect(mockExecFile).toHaveBeenCalledOnce();
      const [cmd] = mockExecFile.mock.calls[0]!;
      expect(cmd).toBe('docker');
    });

    it('passes array args — no shell quoting hazards', async () => {
      const runner = new OsvDockerRunner({ projectDir: '/app' });
      await runner.run(['--lockfile', '/project/path with spaces/package-lock.json']);
      const [, dockerArgs] = mockExecFile.mock.calls[0]!;
      expect(dockerArgs as string[]).toContain('/project/path with spaces/package-lock.json');
    });

    it('returns non-zero exitCode on failure', async () => {
      rejectExecFile(1, '', 'scan failed: no lockfiles found');
      const runner = new OsvDockerRunner({ projectDir: '/app' });
      const result = await runner.run([]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('scan failed');
    });

    it('returns exitCode 127 when docker is not found', async () => {
      rejectExecFile(127, '', 'docker: command not found');
      const runner = new OsvDockerRunner({ projectDir: '/app' });
      const result = await runner.run([]);
      expect(result.exitCode).toBe(127);
    });

    it('captures stdout even on non-zero exit (partial scan results)', async () => {
      rejectExecFile(1, '{"results":[]}', 'some warning');
      const runner = new OsvDockerRunner({ projectDir: '/app' });
      const result = await runner.run([]);
      expect(result.stdout).toBe('{"results":[]}');
      expect(result.stderr).toBe('some warning');
    });

    it('appends --format json in the docker args', async () => {
      const runner = new OsvDockerRunner({ projectDir: '/app' });
      await runner.run(['--lockfile', '/project/package-lock.json']);
      const [, dockerArgs] = mockExecFile.mock.calls[0]!;
      const args = dockerArgs as string[];
      expect(args).toContain('--format');
      expect(args).toContain('json');
      const fmtIdx = args.indexOf('--format');
      expect(args[fmtIdx + 1]).toBe('json');
    });

    it('mounts projectDir at /project:ro in the docker args by default', async () => {
      const runner = new OsvDockerRunner({ projectDir: '/my-project' });
      await runner.run([]);
      const [, dockerArgs] = mockExecFile.mock.calls[0]!;
      const args = dockerArgs as string[];
      const volIdx = args.indexOf('--volume');
      expect(volIdx).toBeGreaterThanOrEqual(0);
      expect(args[volIdx + 1]).toBe('/my-project:/project:ro');
    });

    it('mounts projectDir at /project:rw when readonly: false', async () => {
      const runner = new OsvDockerRunner({ projectDir: '/my-project', readonly: false });
      await runner.run([]);
      const [, dockerArgs] = mockExecFile.mock.calls[0]!;
      const args = dockerArgs as string[];
      const volIdx = args.indexOf('--volume');
      expect(volIdx).toBeGreaterThanOrEqual(0);
      expect(args[volIdx + 1]).toBe('/my-project:/project:rw');
    });

    it('sets --workdir /project in the docker args', async () => {
      const runner = new OsvDockerRunner({ projectDir: '/app' });
      await runner.run([]);
      const [, dockerArgs] = mockExecFile.mock.calls[0]!;
      const args = dockerArgs as string[];
      const wdIdx = args.indexOf('--workdir');
      expect(wdIdx).toBeGreaterThanOrEqual(0);
      expect(args[wdIdx + 1]).toBe('/project');
    });

    it('passes raw plugin args through without path translation', async () => {
      const runner = new OsvDockerRunner({ projectDir: '/app' });
      const rawArgs = ['--lockfile', 'package-lock.json'];
      await runner.run(rawArgs);
      const [, dockerArgs] = mockExecFile.mock.calls[0]!;
      const args = dockerArgs as string[];
      expect(args).toContain('--lockfile');
      expect(args).toContain('package-lock.json');
      // Raw relative path — not prefixed with /project/
      expect(args).not.toContain('/project/package-lock.json');
    });
  });
});
