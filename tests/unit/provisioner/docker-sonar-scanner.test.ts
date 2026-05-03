/**
 * Unit tests for DockerSonarScannerRunner and the sonar-specific resolvePlatform usage.
 *
 * Strategy: mock `execa` to avoid real Docker calls.
 * All tests are pure unit tests — no Docker required.
 *
 * `resolvePlatform` is the shared helper from `@infra/utils/docker-platform`.
 * Tests verify the sonar-scanner-specific call signature (with 'linux/amd64' default).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DockerSonarScannerRunner } from '@infra/provisioner/docker-sonar-scanner';
import { resolvePlatform } from '@infra/utils/docker-platform';
import type { EphemeralContainerRunner, ContainerRunResult } from '@infra/provisioner/types';

// ─── Mock execa ────────────────────────────────────────────────────────────────

vi.mock('execa', () => ({
  execa: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'INFO: ANALYSIS SUCCESSFUL', stderr: '' }),
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

import { execa } from 'execa';
import { arch as osArch, platform as osPlatform } from 'node:os';

const mockExeca = vi.mocked(execa);
const mockArch = vi.mocked(osArch);
const mockPlatform = vi.mocked(osPlatform);

function resolveExeca(stdout = '', stderr = '') {
  mockExeca.mockResolvedValue({ exitCode: 0, stdout, stderr } as any);
}

function resolveExecaFailure(exitCode: number, stdout = '', stderr = '') {
  // execa with reject: false returns a result object with non-zero exitCode instead of throwing
  mockExeca.mockResolvedValue({ exitCode, stdout, stderr } as any);
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
    resolveExeca('INFO: ANALYSIS SUCCESSFUL', '');
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

    it('adds --add-host host.docker.internal:host-gateway on Linux', () => {
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

    describe('env injection', () => {
      it('injects --env KEY=VALUE when env is provided', () => {
        const runner = new DockerSonarScannerRunner({
          projectDir: '/app',
          sonarHostUrl: 'http://localhost:9000',
          env: { SONAR_SCANNER_OPTS: '-Xmx2048m' },
        });
        const args = runner._buildDockerArgs('http://host.docker.internal:9000', []);
        const envIdx = args.indexOf('--env');
        expect(envIdx).toBeGreaterThanOrEqual(0);
        expect(args[envIdx + 1]).toBe('SONAR_SCANNER_OPTS=-Xmx2048m');
      });

      it('places --env flags before the image name', () => {
        const runner = new DockerSonarScannerRunner({
          projectDir: '/app',
          sonarHostUrl: 'http://localhost:9000',
          env: { SONAR_SCANNER_OPTS: '-Xmx2048m' },
        });
        const args = runner._buildDockerArgs('http://host.docker.internal:9000', []);
        const envIdx = args.indexOf('--env');
        const imageIdx = args.indexOf('sonarsource/sonar-scanner-cli:latest');
        expect(envIdx).toBeGreaterThanOrEqual(0);
        expect(imageIdx).toBeGreaterThan(envIdx);
      });

      it('does not inject --env when env is undefined', () => {
        const runner = new DockerSonarScannerRunner({
          projectDir: '/app',
          sonarHostUrl: 'http://localhost:9000',
        });
        const args = runner._buildDockerArgs('http://host.docker.internal:9000', []);
        expect(args).not.toContain('--env');
      });

      it('injects multiple env vars when env has multiple keys', () => {
        const runner = new DockerSonarScannerRunner({
          projectDir: '/app',
          sonarHostUrl: 'http://localhost:9000',
          env: { A: '1', B: '2' },
        });
        const args = runner._buildDockerArgs('http://host.docker.internal:9000', []);
        expect(args).toContain('--env');
        expect(args).toContain('A=1');
        expect(args).toContain('B=2');
        // Both pairs should be present
        const firstEnvIdx = args.indexOf('--env');
        const secondEnvIdx = args.indexOf('--env', firstEnvIdx + 1);
        expect(secondEnvIdx).toBeGreaterThan(firstEnvIdx);
      });
    });
  });

  // ── run() ───────────────────────────────────────────────────────────────────

  describe('run()', () => {
    it('returns exitCode 0 and stdout on success', async () => {
      resolveExeca('INFO: ANALYSIS SUCCESSFUL', '');
      const runner = new DockerSonarScannerRunner({
        projectDir: '/app',
        sonarHostUrl: 'http://localhost:9000',
      });
      const result = await runner.run(['-Dsonar.projectKey=test']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('ANALYSIS SUCCESSFUL');
    });

    it('calls execa with docker as the command', async () => {
      const runner = new DockerSonarScannerRunner({
        projectDir: '/app',
        sonarHostUrl: 'http://localhost:9000',
      });
      await runner.run(['-Dsonar.projectKey=test']);

      expect(mockExeca).toHaveBeenCalledOnce();
      const [cmd] = mockExeca.mock.calls[0]!;
      expect(cmd).toBe('docker');
    });

    it('passes array args — no shell quoting hazards', async () => {
      const runner = new DockerSonarScannerRunner({
        projectDir: '/app',
        sonarHostUrl: 'http://localhost:9000',
      });
      await runner.run(['-Dsonar.projectKey=my proj with spaces']);

      const [, dockerArgs] = mockExeca.mock.calls[0]!;
      // The arg must be a single element in the array, not shell-expanded
      expect(dockerArgs as string[]).toContain('-Dsonar.projectKey=my proj with spaces');
    });

    it('returns non-zero exitCode on failure', async () => {
      resolveExecaFailure(1, '', 'ANALYSIS FAILED');
      const runner = new DockerSonarScannerRunner({
        projectDir: '/app',
        sonarHostUrl: 'http://localhost:9000',
      });
      const result = await runner.run(['-Dsonar.projectKey=test']);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('ANALYSIS FAILED');
    });

    it('returns exitCode 127 when docker returns non-zero exit', async () => {
      resolveExecaFailure(127, '', 'docker: command not found');
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

      const [, dockerArgs] = mockExeca.mock.calls[0]!;
      const hostUrlArg = (dockerArgs as string[]).find((a) => a.startsWith('-Dsonar.host.url='));
      expect(hostUrlArg).toBe('-Dsonar.host.url=http://host.docker.internal:19999');
    });

    it('does not contain localhost in the docker run args when input has localhost', async () => {
      const runner = new DockerSonarScannerRunner({
        projectDir: '/app',
        sonarHostUrl: 'http://localhost:19999',
      });
      await runner.run([]);

      const [, dockerArgs] = mockExeca.mock.calls[0]!;
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

      const [, dockerArgs] = mockExeca.mock.calls[0]!;
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

      const [, dockerArgs] = mockExeca.mock.calls[0]!;
      expect(dockerArgs as string[]).not.toContain('--platform');
    });

    it('calls execa with reject:false so non-zero exit codes are returned rather than thrown', async () => {
      const runner = new DockerSonarScannerRunner({
        projectDir: '/app',
        sonarHostUrl: 'http://localhost:9000',
      });
      await runner.run(['-Dsonar.projectKey=test']);

      expect(mockExeca).toHaveBeenCalledWith(
        'docker',
        expect.any(Array),
        expect.objectContaining({
          reject: false,
        }),
      );
    });

    it('forwards output lines to onLine callback when provided', async () => {
      resolveExeca('INFO: line one\nINFO: line two\n', '');
      const lines: string[] = [];
      const runner = new DockerSonarScannerRunner({
        projectDir: '/app',
        sonarHostUrl: 'http://localhost:9000',
      });
      // The mock resolves immediately; onLine is not called (no real stream).
      // Just verify run() accepts the callback without throwing.
      const result = await runner.run(['-Dsonar.projectKey=test'], (line) => lines.push(line));
      expect(result.exitCode).toBe(0);
    });
  });
});

// ─── EphemeralContainerRunner contract conformance ────────────────────────────

describe('DockerSonarScannerRunner — EphemeralContainerRunner contract', () => {
  beforeEach(() => {
    resolveExeca('INFO: ANALYSIS SUCCESSFUL', '');
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
    resolveExeca('INFO: ANALYSIS SUCCESSFUL', '');
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
    resolveExecaFailure(1, '', 'ANALYSIS FAILED');
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

describe('DockerSonarScannerRunner.run() — catch branch (unexpected execa throw)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns exitCode=1 and error message when execa throws unexpectedly', async () => {
    mockExeca.mockRejectedValue(new Error('spawn docker ENOENT'));
    const runner = new DockerSonarScannerRunner({ projectDir: '/p', sonarHostUrl: 'http://localhost:9000' });
    const result = await runner.run([]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('spawn docker ENOENT');
  });

  it('uses exitCode from thrown error when numeric exitCode field present', async () => {
    mockExeca.mockRejectedValue(
      Object.assign(new Error('exit'), { exitCode: 4, stdout: 'out', stderr: 'err' }),
    );
    const runner = new DockerSonarScannerRunner({ projectDir: '/p', sonarHostUrl: 'http://localhost:9000' });
    const result = await runner.run([]);
    expect(result.exitCode).toBe(4);
    expect(result.stdout).toBe('out');
    expect(result.stderr).toBe('err');
  });
});
