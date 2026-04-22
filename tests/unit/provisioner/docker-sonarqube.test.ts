/**
 * Unit tests for DockerSonarQubeProvisioner.
 *
 * Strategy: mock `node:child_process.execFile` to avoid real Docker calls,
 * and mock `fetch` to control readiness polling responses.
 * All tests are pure unit tests — no Docker required.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DockerSonarQubeProvisioner } from '@infra/provisioner/docker-sonarqube';

// ─── Mock execFile (docker commands) ──────────────────────────────────────────

// We mock the entire child_process module so docker is never actually called.
vi.mock('node:child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], callback: (err: null | Error, result: { stdout: string; stderr: string }) => void) => {
    callback(null, { stdout: '', stderr: '' });
  }),
}));

import { execFile } from 'node:child_process';

// execFileAsync is a promisify wrapper — we need the underlying mock
const mockExecFile = vi.mocked(execFile);

function setupExecFileMock(
  impl: (_cmd: string, _args: string[], callback: (err: null | Error, result: { stdout: string; stderr: string }) => void) => void,
) {
  mockExecFile.mockImplementation(impl as typeof execFile);
}

function resolveExecFile() {
  setupExecFileMock((_cmd, _args, cb) => cb(null, { stdout: '', stderr: '' }));
}

function rejectExecFile(message: string) {
  setupExecFileMock((_cmd, _args, cb) => cb(new Error(message), { stdout: '', stderr: '' }));
}

// ─── Mock fetch (readiness polling) ───────────────────────────────────────────

function stubReadyFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'UP' }),
    }),
  );
}

function stubNotReadyThenReadyFetch(notReadyCount = 1) {
  const responses = [
    ...Array.from({ length: notReadyCount }, () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: 'STARTING' }),
    })),
    {
      ok: true,
      status: 200,
      json: async () => ({ status: 'UP' }),
    },
  ];
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => responses.shift()!));
}

function stubNeverReadyFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'STARTING' }),
    }),
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DockerSonarQubeProvisioner', () => {
  beforeEach(() => {
    resolveExecFile();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  // ── provision() ─────────────────────────────────────────────────────────────

  describe('provision()', () => {
    it('returns a baseUrl with localhost and a port', async () => {
      const provisioner = new DockerSonarQubeProvisioner();
      const { baseUrl } = await provisioner.provision();

      expect(baseUrl).toMatch(/^http:\/\/localhost:\d+$/);
    });

    it('uses the fixed port when hostPort is provided', async () => {
      const provisioner = new DockerSonarQubeProvisioner({ hostPort: 19000 });
      const { baseUrl } = await provisioner.provision();

      expect(baseUrl).toBe('http://localhost:19000');
    });

    it('calls docker run with the correct arguments', async () => {
      const provisioner = new DockerSonarQubeProvisioner({
        hostPort: 19001,
        image: 'sonarqube:community',
      });

      await provisioner.provision();

      expect(mockExecFile).toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining(['run', '--detach', '-p', '19001:9000']),
        expect.any(Function),
      );
    });

    it('includes SONAR_ES_BOOTSTRAP_CHECKS_DISABLE=true in docker run args', async () => {
      const provisioner = new DockerSonarQubeProvisioner({ hostPort: 19002 });
      await provisioner.provision();

      const [, dockerArgs] = mockExecFile.mock.calls[0]!;
      expect(dockerArgs).toContain('SONAR_ES_BOOTSTRAP_CHECKS_DISABLE=true');
    });

    it('uses containerNamePrefix option', async () => {
      const provisioner = new DockerSonarQubeProvisioner({
        hostPort: 19003,
        containerNamePrefix: 'my-test-sq',
      });

      await provisioner.provision();

      const [, dockerArgs] = mockExecFile.mock.calls[0]!;
      const nameIdx = (dockerArgs as string[]).indexOf('--name');
      const containerName = (dockerArgs as string[])[nameIdx + 1] ?? '';
      expect(containerName).toMatch(/^my-test-sq-/);
    });

    it('is idempotent — second call returns same URL without docker run', async () => {
      const provisioner = new DockerSonarQubeProvisioner({ hostPort: 19004 });
      const { baseUrl: first } = await provisioner.provision();
      const { baseUrl: second } = await provisioner.provision();

      expect(first).toBe(second);
      // docker run should only be called once
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });

    it('exposes containerName_ and resolvedPort_ after provision', async () => {
      const provisioner = new DockerSonarQubeProvisioner({ hostPort: 19005 });
      expect(provisioner.containerName_).toBeNull();
      expect(provisioner.resolvedPort_).toBeNull();

      await provisioner.provision();

      expect(provisioner.containerName_).toMatch(/^osv-sq-ephemeral-/);
      expect(provisioner.resolvedPort_).toBe(19005);
    });

    it('throws when docker run fails', async () => {
      rejectExecFile('docker: command not found');
      const provisioner = new DockerSonarQubeProvisioner({ hostPort: 19006 });

      await expect(provisioner.provision()).rejects.toThrow('docker: command not found');
    });
  });

  // ── waitReady() ──────────────────────────────────────────────────────────────

  describe('waitReady()', () => {
    it('throws if called before provision()', async () => {
      const provisioner = new DockerSonarQubeProvisioner();
      await expect(provisioner.waitReady()).rejects.toThrow('provision()');
    });

    it('resolves when SonarQube reports status UP immediately', async () => {
      stubReadyFetch();
      const provisioner = new DockerSonarQubeProvisioner({ hostPort: 19010 });
      await provisioner.provision();

      await expect(provisioner.waitReady()).resolves.toBeUndefined();
    });

    it('resolves after a few STARTING polls before UP', async () => {
      stubNotReadyThenReadyFetch(2);
      const provisioner = new DockerSonarQubeProvisioner({
        hostPort: 19011,
        pollIntervalMs: 0,
      });
      await provisioner.provision();

      await expect(provisioner.waitReady()).resolves.toBeUndefined();
    });

    it('throws when timeout is exceeded', async () => {
      stubNeverReadyFetch();
      const provisioner = new DockerSonarQubeProvisioner({
        hostPort: 19012,
        pollIntervalMs: 0,
      });
      await provisioner.provision();

      await expect(
        provisioner.waitReady(100), // 100ms — expires almost immediately
      ).rejects.toThrow(/did not become ready/i);
    });

    it('polls the correct URL', async () => {
      stubReadyFetch();
      const provisioner = new DockerSonarQubeProvisioner({ hostPort: 19013 });
      await provisioner.provision();
      await provisioner.waitReady();

      const fetchMock = vi.mocked(fetch);
      const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
      expect(calledUrl).toBe('http://localhost:19013/api/system/status');
    });
  });

  // ── teardown() ───────────────────────────────────────────────────────────────

  describe('teardown()', () => {
    it('is a no-op when provision() was never called', async () => {
      const provisioner = new DockerSonarQubeProvisioner();
      await expect(provisioner.teardown()).resolves.toBeUndefined();
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('calls docker stop then docker rm after provision()', async () => {
      const provisioner = new DockerSonarQubeProvisioner({ hostPort: 19020 });
      await provisioner.provision();

      vi.clearAllMocks(); // reset so we can assert teardown calls
      resolveExecFile();

      await provisioner.teardown();

      const calls = mockExecFile.mock.calls.map((c) => c[1] as string[]);
      const stopCall = calls.find((args) => args[0] === 'stop');
      const rmCall = calls.find((args) => args[0] === 'rm');

      expect(stopCall).toBeDefined();
      expect(rmCall).toBeDefined();
    });

    it('is idempotent — second teardown is a no-op', async () => {
      const provisioner = new DockerSonarQubeProvisioner({ hostPort: 19021 });
      await provisioner.provision();
      resolveExecFile();

      await provisioner.teardown();
      const callsAfterFirst = mockExecFile.mock.calls.length;

      await provisioner.teardown(); // second call
      expect(mockExecFile.mock.calls.length).toBe(callsAfterFirst); // no additional calls
    });

    it('does not throw when docker stop fails', async () => {
      const provisioner = new DockerSonarQubeProvisioner({ hostPort: 19022 });
      await provisioner.provision();

      // First two calls (stop + rm) will fail
      rejectExecFile('container not found');

      await expect(provisioner.teardown()).resolves.toBeUndefined();
    });
  });

  // ── full lifecycle ────────────────────────────────────────────────────────────

  describe('full lifecycle: provision → waitReady → teardown', () => {
    it('completes without throwing', async () => {
      stubReadyFetch();
      const provisioner = new DockerSonarQubeProvisioner({ hostPort: 19030 });

      const { baseUrl } = await provisioner.provision();
      expect(baseUrl).toBe('http://localhost:19030');

      await provisioner.waitReady();

      resolveExecFile();
      await provisioner.teardown();
    });
  });

  // ── shutdown-hook integration ─────────────────────────────────────────────────

  describe('shutdown-hook integration (signal-safe cleanup)', () => {
    it('registers a shutdown hook during provision() so abrupt exit still tears down', async () => {
      const { _activeHookCount, _resetShutdownHooks } = await import('@infra/utils/shutdown-hooks');
      _resetShutdownHooks();

      expect(_activeHookCount()).toBe(0);

      const provisioner = new DockerSonarQubeProvisioner({ hostPort: 19040 });
      await provisioner.provision();

      // Exactly one hook registered after provisioning.
      expect(_activeHookCount()).toBe(1);

      _resetShutdownHooks();
    });

    it('unregisters the shutdown hook during normal teardown() to avoid double-fire at exit', async () => {
      const { _activeHookCount, _resetShutdownHooks } = await import('@infra/utils/shutdown-hooks');
      _resetShutdownHooks();

      const provisioner = new DockerSonarQubeProvisioner({ hostPort: 19041 });
      await provisioner.provision();
      expect(_activeHookCount()).toBe(1);

      resolveExecFile();
      await provisioner.teardown();

      // Hook is gone after normal teardown — won't re-fire at process exit.
      expect(_activeHookCount()).toBe(0);
    });
  });
});
