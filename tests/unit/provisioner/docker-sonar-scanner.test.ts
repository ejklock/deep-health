/**
 * Unit tests for DockerSonarScannerRunner and the sonar-specific resolvePlatform usage.
 *
 * Strategy: mock `node:child_process.execFile` to avoid real Docker calls.
 * All tests are pure unit tests — no Docker required.
 *
 * `resolvePlatform` is the shared helper from `@infra/utils/docker-platform`.
 * Tests verify the sonar-scanner-specific call signature (with 'linux/amd64' default).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DockerSonarScannerRunner } from '@infra/provisioner/docker-sonar-scanner';
import { resolvePlatform } from '@infra/utils/docker-platform';
import type { EphemeralContainerRunner, ContainerRunResult } from '@infra/provisioner/types';

// ─── Mock execFile ─────────────────────────────────────────────────────────────

vi.mock('node:child_process', () => ({
  execFile: vi.fn(
    (
      _cmd: string,
      _args: string[],
      callback: (err: null | Error, result: { stdout: string; stderr: string }) => void,
    ) => {
      callback(null, { stdout: 'INFO: ANALYSIS SUCCESSFUL', stderr: '' });
    },
  ),
}));

// Mock node:os to control platform/arch in tests
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

function resolveExecFile(stdout = '', stderr = '') {
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      callback: (err: null | Error, result: { stdout: string; stderr: string }) => void,
    ) => callback(null, { stdout, stderr }),
  );
}

function rejectExecFile(exitCode: number, stdout = '', stderr = '') {
  // promisify(execFile) rejects with an error that carries code/stdout/stderr
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      callback: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      const err = Object.assign(new Error('sonar-scanner failed'), {
        code: exitCode,
        stdout,
        stderr,
      });
      callback(err, { stdout, stderr });
    },
  );
}

// ─── resolvePlatform tests (sonar-scanner-cli call signature) ─────────────────
// DockerSonarScannerRunner calls resolvePlatform(platform, 'linux/amd64').
// These tests verify the behaviour for that specific invocation pattern.

const SONAR_DEFAULT = 'linux/amd64';

describe('resolvePlatform() — sonar-scanner-cli call signature', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns "linux/amd64" when arch is arm64 and no override is provided', () => {
    mockArch.mockReturnValue('arm64');
    expect(resolvePlatform(undefined, SONAR_DEFAULT)).toBe('linux/amd64');
  });

  it('returns undefined when arch is x64 and no override is provided', () => {
    mockArch.mockReturnValue('x64');
    expect(resolvePlatform(undefined, SONAR_DEFAULT)).toBeUndefined();
  });

  it('returns undefined when arch is ia32 and no override is provided', () => {
    mockArch.mockReturnValue('ia32');
    expect(resolvePlatform(undefined, SONAR_DEFAULT)).toBeUndefined();
  });

  it('returns the explicit override string regardless of arch', () => {
    mockArch.mockReturnValue('arm64');
    expect(resolvePlatform('linux/arm64', SONAR_DEFAULT)).toBe('linux/arm64');
  });

  it('returns undefined when override is empty string (suppresses auto-detection)', () => {
    mockArch.mockReturnValue('arm64');
    expect(resolvePlatform('', SONAR_DEFAULT)).toBeUndefined();
  });

  it('returns custom platform string when provided', () => {
    mockArch.mockReturnValue('x64');
    expect(resolvePlatform('linux/amd64', SONAR_DEFAULT)).toBe('linux/amd64');
  });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DockerSonarScannerRunner', () => {
  beforeEach(() => {
    resolveExecFile('INFO: ANALYSIS SUCCESSFUL', '');
    // Default arch to x64 (no --platform injection) for most tests
    mockArch.mockReturnValue('x64');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── Constructor / configuration ─────────────────────────────────────────────

  describe('constructor', () => {
    it('accepts required options without error', () => {
      expect(
        () =>
          new DockerSonarScannerRunner({
            projectDir: '/app',
            sonarHostUrl: 'http://localhost:9000',
          }),
      ).not.toThrow();
    });

    it('accepts custom image option', () => {
      expect(
        () =>
          new DockerSonarScannerRunner({
            projectDir: '/app',
            sonarHostUrl: 'http://localhost:9000',
            image: 'sonarsource/sonar-scanner-cli:5.0',
          }),
      ).not.toThrow();
    });

    it('accepts platform override option', () => {
      expect(
        () =>
          new DockerSonarScannerRunner({
            projectDir: '/app',
            sonarHostUrl: 'http://localhost:9000',
            platform: 'linux/amd64',
          }),
      ).not.toThrow();
    });
  });

  // ── _translateHostUrl ───────────────────────────────────────────────────────

  describe('_translateHostUrl()', () => {
    it('replaces localhost with host.docker.internal', () => {
      const runner = new DockerSonarScannerRunner({
        projectDir: '/app',
        sonarHostUrl: 'http://localhost:9000',
      });
      expect(runner._translateHostUrl('http://localhost:9000')).toBe(
        'http://host.docker.internal:9000',
      );
    });

    it('replaces 127.0.0.1 with host.docker.internal', () => {
      const runner = new DockerSonarScannerRunner({
        projectDir: '/app',
        sonarHostUrl: 'http://127.0.0.1:9000',
      });
      expect(runner._translateHostUrl('http://127.0.0.1:9000')).toBe(
        'http://host.docker.internal:9000',
      );
    });

    it('leaves other hostnames unchanged', () => {
      const runner = new DockerSonarScannerRunner({
        projectDir: '/app',
        sonarHostUrl: 'http://sonarqube.example.com:9000',
      });
      expect(runner._translateHostUrl('http://sonarqube.example.com:9000')).toBe(
        'http://sonarqube.example.com:9000',
      );
    });
  });

  // ── _buildDockerArgs ────────────────────────────────────────────────────────

  describe('_buildDockerArgs()', () => {
    it('includes docker run --rm', () => {
      const runner = new DockerSonarScannerRunner({
        projectDir: '/app',
        sonarHostUrl: 'http://localhost:9000',
      });
      const args = runner._buildDockerArgs('http://host.docker.internal:9000', []);
      expect(args).toContain('run');
      expect(args).toContain('--rm');
    });

    it('mounts projectDir at /usr/src', () => {
      const runner = new DockerSonarScannerRunner({
        projectDir: '/my/project',
        sonarHostUrl: 'http://localhost:9000',
      });
      const args = runner._buildDockerArgs('http://host.docker.internal:9000', []);
      const volIdx = args.indexOf('--volume');
      expect(volIdx).toBeGreaterThanOrEqual(0);
      expect(args[volIdx + 1]).toBe('/my/project:/usr/src');
    });

    it('injects -Dsonar.host.url with the translated URL', () => {
      const runner = new DockerSonarScannerRunner({
        projectDir: '/app',
        sonarHostUrl: 'http://localhost:9000',
      });
      const args = runner._buildDockerArgs('http://host.docker.internal:9000', []);
      expect(args).toContain('-Dsonar.host.url=http://host.docker.internal:9000');
    });

    it('appends all extraArgs', () => {
      const runner = new DockerSonarScannerRunner({
        projectDir: '/app',
        sonarHostUrl: 'http://localhost:9000',
      });
      const extraArgs = ['-Dsonar.projectKey=my-proj', '-Dsonar.token=mytoken'];
      const args = runner._buildDockerArgs('http://host.docker.internal:9000', extraArgs);
      expect(args).toContain('-Dsonar.projectKey=my-proj');
      expect(args).toContain('-Dsonar.token=mytoken');
    });

    it('uses default image when none specified', () => {
      const runner = new DockerSonarScannerRunner({
        projectDir: '/app',
        sonarHostUrl: 'http://localhost:9000',
      });
      const args = runner._buildDockerArgs('http://host.docker.internal:9000', []);
      expect(args).toContain('sonarsource/sonar-scanner-cli:latest');
    });

    it('uses custom image when specified', () => {
      const runner = new DockerSonarScannerRunner({
        projectDir: '/app',
        sonarHostUrl: 'http://localhost:9000',
        image: 'sonarsource/sonar-scanner-cli:5.0',
      });
      const args = runner._buildDockerArgs('http://host.docker.internal:9000', []);
      expect(args).toContain('sonarsource/sonar-scanner-cli:5.0');
    });

    it('does NOT include --platform when arch is x64 and no override', () => {
      mockArch.mockReturnValue('x64');
      const runner = new DockerSonarScannerRunner({
        projectDir: '/app',
        sonarHostUrl: 'http://localhost:9000',
      });
      const args = runner._buildDockerArgs('http://host.docker.internal:9000', []);
      expect(args).not.toContain('--platform');
    });

    it('injects --platform linux/amd64 when arch is arm64', () => {
      mockArch.mockReturnValue('arm64');
      const runner = new DockerSonarScannerRunner({
        projectDir: '/app',
        sonarHostUrl: 'http://localhost:9000',
      });
      const args = runner._buildDockerArgs('http://host.docker.internal:9000', []);
      const platformIdx = args.indexOf('--platform');
      expect(platformIdx).toBeGreaterThanOrEqual(0);
      expect(args[platformIdx + 1]).toBe('linux/amd64');
    });

    it('injects explicit platform override regardless of arch', () => {
      mockArch.mockReturnValue('x64');
      const runner = new DockerSonarScannerRunner({
        projectDir: '/app',
        sonarHostUrl: 'http://localhost:9000',
        platform: 'linux/arm64',
      });
      const args = runner._buildDockerArgs('http://host.docker.internal:9000', []);
      const platformIdx = args.indexOf('--platform');
      expect(platformIdx).toBeGreaterThanOrEqual(0);
      expect(args[platformIdx + 1]).toBe('linux/arm64');
    });

    it('suppresses --platform when platform option is empty string', () => {
      mockArch.mockReturnValue('arm64');
      const runner = new DockerSonarScannerRunner({
        projectDir: '/app',
        sonarHostUrl: 'http://localhost:9000',
        platform: '',
      });
      const args = runner._buildDockerArgs('http://host.docker.internal:9000', []);
      expect(args).not.toContain('--platform');
    });

    it('adds --add-host host.docker.internal:host-gateway on Linux (lines 128-129)', () => {
      mockPlatform.mockReturnValue('linux');
      const runner = new DockerSonarScannerRunner({
        projectDir: '/app',
        sonarHostUrl: 'http://localhost:9000',
      });
      const args = runner._buildDockerArgs('http://host.docker.internal:9000', []);
      const addHostIdx = args.indexOf('--add-host');
      expect(addHostIdx).toBeGreaterThanOrEqual(0);
      expect(args[addHostIdx + 1]).toBe('host.docker.internal:host-gateway');
      mockPlatform.mockReturnValue('darwin');
    });

    it('places --platform before --volume in arg list', () => {
      mockArch.mockReturnValue('arm64');
      const runner = new DockerSonarScannerRunner({
        projectDir: '/app',
        sonarHostUrl: 'http://localhost:9000',
      });
      const args = runner._buildDockerArgs('http://host.docker.internal:9000', []);
      const platformIdx = args.indexOf('--platform');
      const volumeIdx = args.indexOf('--volume');
      expect(platformIdx).toBeGreaterThanOrEqual(0);
      expect(volumeIdx).toBeGreaterThan(platformIdx);
    });
  });

  // ── run() ───────────────────────────────────────────────────────────────────

  describe('run()', () => {
    it('returns exitCode 0 and stdout on success', async () => {
      resolveExecFile('INFO: ANALYSIS SUCCESSFUL', '');
      const runner = new DockerSonarScannerRunner({
        projectDir: '/app',
        sonarHostUrl: 'http://localhost:9000',
      });
      const result = await runner.run(['-Dsonar.projectKey=test']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('ANALYSIS SUCCESSFUL');
    });

    it('calls execFile with docker as the command', async () => {
      const runner = new DockerSonarScannerRunner({
        projectDir: '/app',
        sonarHostUrl: 'http://localhost:9000',
      });
      await runner.run(['-Dsonar.projectKey=test']);

      expect(mockExecFile).toHaveBeenCalledOnce();
      const [cmd] = mockExecFile.mock.calls[0]!;
      expect(cmd).toBe('docker');
    });

    it('passes array args — no shell quoting hazards', async () => {
      const runner = new DockerSonarScannerRunner({
        projectDir: '/app',
        sonarHostUrl: 'http://localhost:9000',
      });
      await runner.run(['-Dsonar.projectKey=my proj with spaces']);

      const [, dockerArgs] = mockExecFile.mock.calls[0]!;
      // The arg must be a single element in the array, not shell-expanded
      expect(dockerArgs as string[]).toContain('-Dsonar.projectKey=my proj with spaces');
    });

    it('returns non-zero exitCode on failure', async () => {
      rejectExecFile(1, '', 'ANALYSIS FAILED');
      const runner = new DockerSonarScannerRunner({
        projectDir: '/app',
        sonarHostUrl: 'http://localhost:9000',
      });
      const result = await runner.run(['-Dsonar.projectKey=test']);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('ANALYSIS FAILED');
    });

    it('returns exitCode 1 when docker is not found', async () => {
      rejectExecFile(127, '', 'docker: command not found');
      const runner = new DockerSonarScannerRunner({
        projectDir: '/app',
        sonarHostUrl: 'http://localhost:9000',
      });
      const result = await runner.run([]);

      expect(result.exitCode).toBe(127);
    });

    it('translates localhost to host.docker.internal in the docker run args', async () => {
      const runner = new DockerSonarScannerRunner({
        projectDir: '/app',
        sonarHostUrl: 'http://localhost:19999',
      });
      await runner.run(['-Dsonar.projectKey=test']);

      const [, dockerArgs] = mockExecFile.mock.calls[0]!;
      const hostUrlArg = (dockerArgs as string[]).find((a) => a.startsWith('-Dsonar.host.url='));
      expect(hostUrlArg).toBe('-Dsonar.host.url=http://host.docker.internal:19999');
    });

    it('does not contain localhost in the docker run args when input has localhost', async () => {
      const runner = new DockerSonarScannerRunner({
        projectDir: '/app',
        sonarHostUrl: 'http://localhost:19999',
      });
      await runner.run([]);

      const [, dockerArgs] = mockExecFile.mock.calls[0]!;
      const hasRawLocalhost = (dockerArgs as string[]).some(
        (a) => a.includes('localhost') && a.startsWith('-Dsonar.host.url='),
      );
      expect(hasRawLocalhost).toBe(false);
    });

    it('passes --platform linux/amd64 in docker args on arm64 host', async () => {
      mockArch.mockReturnValue('arm64');
      const runner = new DockerSonarScannerRunner({
        projectDir: '/app',
        sonarHostUrl: 'http://localhost:9000',
      });
      await runner.run(['-Dsonar.projectKey=test']);

      const [, dockerArgs] = mockExecFile.mock.calls[0]!;
      const platformIdx = (dockerArgs as string[]).indexOf('--platform');
      expect(platformIdx).toBeGreaterThanOrEqual(0);
      expect((dockerArgs as string[])[platformIdx + 1]).toBe('linux/amd64');
    });

    it('does not pass --platform in docker args on x64 host', async () => {
      mockArch.mockReturnValue('x64');
      const runner = new DockerSonarScannerRunner({
        projectDir: '/app',
        sonarHostUrl: 'http://localhost:9000',
      });
      await runner.run(['-Dsonar.projectKey=test']);

      const [, dockerArgs] = mockExecFile.mock.calls[0]!;
      expect(dockerArgs as string[]).not.toContain('--platform');
    });
  });
});

// ─── EphemeralContainerRunner contract conformance ────────────────────────────

describe('DockerSonarScannerRunner — EphemeralContainerRunner contract', () => {
  beforeEach(() => {
    resolveExecFile('INFO: ANALYSIS SUCCESSFUL', '');
    mockArch.mockReturnValue('x64');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('satisfies EphemeralContainerRunner<string[]> at the type level', () => {
    const runner = new DockerSonarScannerRunner({
      projectDir: '/app',
      sonarHostUrl: 'http://localhost:9000',
    });
    // TypeScript will fail at compile time if the contract is not satisfied.
    const typed: EphemeralContainerRunner<string[]> = runner;
    expect(typed).toBeDefined();
  });

  it('run() returns a ContainerRunResult with exitCode, stdout, stderr on success', async () => {
    resolveExecFile('INFO: ANALYSIS SUCCESSFUL', '');
    const runner = new DockerSonarScannerRunner({
      projectDir: '/app',
      sonarHostUrl: 'http://localhost:9000',
    });
    const result: ContainerRunResult = await runner.run(['-Dsonar.projectKey=test']);
    expect(result).toHaveProperty('exitCode', 0);
    expect(result).toHaveProperty('stdout');
    expect(result).toHaveProperty('stderr');
    expect(typeof result.exitCode).toBe('number');
    expect(typeof result.stdout).toBe('string');
    expect(typeof result.stderr).toBe('string');
  });

  it('run() returns a ContainerRunResult with non-zero exitCode on failure', async () => {
    rejectExecFile(1, '', 'ANALYSIS FAILED');
    const runner = new DockerSonarScannerRunner({
      projectDir: '/app',
      sonarHostUrl: 'http://localhost:9000',
    });
    const result: ContainerRunResult = await runner.run(['-Dsonar.projectKey=test']);
    expect(result.exitCode).toBe(1);
    expect(result).toHaveProperty('stderr');
    expect(result).toHaveProperty('stdout');
  });
});

describe('DockerSonarScannerRunner.run() — catch branch edge cases (lines 87-89)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses exitCode=1 and String(err) when error has no code/stdout/stderr/message', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], callback: Function) => {
        callback('string-err');
      },
    );
    const runner = new DockerSonarScannerRunner({ projectDir: '/p', sonarHostUrl: 'http://localhost:9000', projectKey: 'k', token: 't' });
    const result = await runner.run([]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('string-err');
  });

  it('uses spawnErr.code when numeric (line 87 true branch)', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], callback: Function) => {
        callback(Object.assign(new Error('exit'), { code: 4, stdout: 'out', stderr: 'err' }));
      },
    );
    const runner = new DockerSonarScannerRunner({ projectDir: '/p', sonarHostUrl: 'http://localhost:9000', projectKey: 'k', token: 't' });
    const result = await runner.run([]);
    expect(result.exitCode).toBe(4);
    expect(result.stdout).toBe('out');
    expect(result.stderr).toBe('err');
  });
});
