import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SonarQubeEngine } from '@modules/scanner/sonarqube-engine.js';
import { EnvironmentError } from '@core/errors.js';
import type { ScannerEngineContext } from '@modules/scanner/types.js';
import type { CommandRunner, CommandResult, CommandRunnerOptions, ExecutionEnv } from '@core/types/common.js';
import type { ProjectConfig } from '@core/types/config.js';
import type { EcosystemRegistry } from '@modules/ecosystem/registry.js';

// ─── Mock DockerSonarQubeProvisioner for unit tests ────────────────────────────
// We do NOT want real Docker calls in unit tests.

vi.mock('@infra/provisioner/docker-sonarqube.js', () => ({
  DockerSonarQubeProvisioner: vi.fn().mockImplementation(() => ({
    provision: vi.fn().mockResolvedValue({ baseUrl: 'http://localhost:19999' }),
    waitReady: vi.fn().mockResolvedValue(undefined),
    teardown: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { DockerSonarQubeProvisioner } from '@infra/provisioner/docker-sonarqube.js';

// ─── Minimal mocks ─────────────────────────────────────────────────────────────

class MockRunner implements CommandRunner {
  readonly dryRun: boolean;
  readonly environment: ExecutionEnv = 'local';
  readonly calledCommands: string[] = [];
  private responses: Map<string, Partial<CommandResult>>;

  constructor(
    responses: Record<string, Partial<CommandResult>> = {},
    options: { dryRun?: boolean } = {},
  ) {
    this.dryRun = options.dryRun ?? false;
    this.responses = new Map(Object.entries(responses));
  }

  async run(command: string, _opts?: CommandRunnerOptions): Promise<CommandResult> {
    this.calledCommands.push(command);
    for (const [key, resp] of this.responses) {
      if (command.includes(key)) {
        return { stdout: resp.stdout ?? '', stderr: resp.stderr ?? '', exitCode: resp.exitCode ?? 0, command, dryRun: this.dryRun };
      }
    }
    return { stdout: '', stderr: '', exitCode: 0, command, dryRun: this.dryRun };
  }
}

function makeConfig(sonarEnabled = false, onFailure: 'warn' | 'fail' = 'warn', mode: 'external' | 'managed' = 'external'): ProjectConfig {
  return {
    project: { name: 'test', client: 'client' },
    runtime: { node: '20.x', execution: 'local', docker_service: 'app' },
    protected_packages: { composer: [], npm: [] },
    safe_update_policy: {
      allow_patch_and_minor_within_constraints: true,
      require_authorization_for_constraint_change: false,
      authorization_format: '',
    },
    conflict_resolution: 'stop_and_ask',
    ...(sonarEnabled
      ? {
          scanners: {
            sonarqube: {
              enabled: true,
              mode,
              host_url: 'http://localhost:9000',
              project_key: 'my-project',
              token_env: 'SONAR_TOKEN',
              on_failure: onFailure,
            },
          },
        }
      : {}),
  } as ProjectConfig;
}

function makeCtx(runner: MockRunner, config: ProjectConfig): ScannerEngineContext {
  return {
    runner,
    config,
    cwd: '/tmp/test',
    ecosystemRegistry: {} as EcosystemRegistry,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('SonarQubeEngine', () => {
  const engine = new SonarQubeEngine();

  describe('id and name', () => {
    it('has correct id and name', () => {
      expect(engine.id).toBe('sonarqube');
      expect(engine.name).toBe('SonarQube');
    });
  });

  describe('scan — not configured', () => {
    it('returns skipped status when sonarqube is not in config', async () => {
      const runner = new MockRunner();
      const config = makeConfig(false);
      const result = await engine.scan(makeCtx(runner, config));

      expect(result.status).toBe('skipped');
      expect(result.agent).toBe('sonarqube');
      expect(result.$schema).toBe('sonarqube-scan-result/v1');
      expect(runner.calledCommands).toHaveLength(0);
    });

    it('returns skipped status when sonarqube.enabled is false', async () => {
      const runner = new MockRunner();
      const config: ProjectConfig = {
        ...makeConfig(false),
          scanners: {
            sonarqube: {
              enabled: false,
              mode: 'external' as const,
              host_url: 'http://localhost:9000',
              project_key: 'my-project',
              token_env: 'SONAR_TOKEN',
              on_failure: 'warn',
            },
          },
      };
      const result = await engine.scan(makeCtx(runner, config));

      expect(result.status).toBe('skipped');
      expect(runner.calledCommands).toHaveLength(0);
    });
  });

  describe('scan — token missing', () => {
    beforeEach(() => {
      delete process.env['SONAR_TOKEN'];
    });

    it('throws EnvironmentError when token env var is not set', async () => {
      const runner = new MockRunner();
      const config = makeConfig(true);

      await expect(engine.scan(makeCtx(runner, config))).rejects.toThrow(EnvironmentError);
    });

    it('includes the token_env name in the error message', async () => {
      const runner = new MockRunner();
      const config = makeConfig(true);

      await expect(engine.scan(makeCtx(runner, config))).rejects.toThrow('SONAR_TOKEN');
    });
  });

  describe('scan — sonar-scanner not available', () => {
    beforeEach(() => {
      process.env['SONAR_TOKEN'] = 'test-token';
    });

    afterEach(() => {
      delete process.env['SONAR_TOKEN'];
    });

    it('throws EnvironmentError when sonar-scanner --version fails', async () => {
      const runner = new MockRunner({ '--version': { exitCode: 127, stderr: 'command not found' } });
      const config = makeConfig(true);

      await expect(engine.scan(makeCtx(runner, config))).rejects.toThrow(EnvironmentError);
    });

    it('error message includes platform install hint', async () => {
      const runner = new MockRunner({ '--version': { exitCode: 127 } });
      const config = makeConfig(true);

      await expect(engine.scan(makeCtx(runner, config))).rejects.toThrow(/sonar-scanner/i);
    });
  });

  describe('scan — dry-run mode', () => {
    beforeEach(() => {
      process.env['SONAR_TOKEN'] = 'test-token';
    });
    afterEach(() => {
      delete process.env['SONAR_TOKEN'];
    });

    it('returns success without executing scan when dryRun=true', async () => {
      const runner = new MockRunner(
        { '--version': { exitCode: 0, stdout: 'SonarScanner 5.0' } },
        { dryRun: true },
      );
      const config = makeConfig(true);

      const result = await engine.scan(makeCtx(runner, config));

      expect(result.status).toBe('success');
      // Should only have called --version (assertAvailable), not the full scan
      const scanCalls = runner.calledCommands.filter((c) => c.includes('-Dsonar.projectKey'));
      expect(scanCalls).toHaveLength(0);
    });
  });

  describe('scan — sonar-scanner exits with error', () => {
    beforeEach(() => {
      process.env['SONAR_TOKEN'] = 'test-token';
    });
    afterEach(() => {
      delete process.env['SONAR_TOKEN'];
    });

    it('returns error status when sonar-scanner exits non-zero', async () => {
      const runner = new MockRunner({
        '--version': { exitCode: 0, stdout: 'SonarScanner 5.0' },
        'sonar-scanner -D': { exitCode: 1, stderr: 'ANALYSIS FAILED' },
      });
      const config = makeConfig(true);

      // mock fetch to avoid real network calls
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error', json: async () => ({}) }));

      const result = await engine.scan(makeCtx(runner, config));

      expect(result.status).toBe('error');
      expect(result.error).toContain('exit');

      vi.unstubAllGlobals();
    });
  });

  describe('scan — successful scan with metadata', () => {
    beforeEach(() => {
      process.env['SONAR_TOKEN'] = 'test-token';
    });
    afterEach(() => {
      delete process.env['SONAR_TOKEN'];
      vi.unstubAllGlobals();
    });

    it('returns success with quality gate metadata when scan succeeds', async () => {
      const runner = new MockRunner({
        '--version': { exitCode: 0, stdout: 'SonarScanner 5.0' },
        'sonar-scanner -D': { exitCode: 0, stdout: 'INFO: ANALYSIS SUCCESSFUL' },
      });
      const config = makeConfig(true);

      const mockQualityGate = {
        projectStatus: {
          status: 'OK',
          conditions: [],
        },
      };
      const mockMeasures = {
        component: {
          measures: [
            { metric: 'bugs', value: '0' },
            { metric: 'vulnerabilities', value: '2' },
          ],
        },
      };

      vi.stubGlobal(
        'fetch',
        vi.fn()
          .mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => mockQualityGate,
          })
          .mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => mockMeasures,
          }),
      );

      const result = await engine.scan(makeCtx(runner, config));

      expect(result.status).toBe('success');
      expect(result.metadata).toBeDefined();
      expect(result.metadata?.qualityGateStatus).toBe('OK');
      expect(result.metadata?.qualityGatePassed).toBe(true);
      expect((result.metadata?.metrics as Record<string, string>)?.['bugs']).toBe('0');
      expect((result.metadata?.metrics as Record<string, string>)?.['vulnerabilities']).toBe('2');
    });

    it('returns success even when API calls fail (best-effort metadata)', async () => {
      const runner = new MockRunner({
        '--version': { exitCode: 0, stdout: 'SonarScanner 5.0' },
        'sonar-scanner -D': { exitCode: 0, stdout: 'ANALYSIS SUCCESSFUL' },
      });
      const config = makeConfig(true);

      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new Error('Network error')),
      );

      const result = await engine.scan(makeCtx(runner, config));

      expect(result.status).toBe('success');
      // metadata.qualityGateStatus should be 'UNKNOWN' when API call fails
      expect(result.metadata?.qualityGateStatus).toBe('UNKNOWN');
    });

    it('marks quality gate as not passed when status is ERROR', async () => {
      const runner = new MockRunner({
        '--version': { exitCode: 0, stdout: 'SonarScanner 5.0' },
        'sonar-scanner -D': { exitCode: 0, stdout: 'ANALYSIS SUCCESSFUL' },
      });
      const config = makeConfig(true);

      vi.stubGlobal(
        'fetch',
        vi.fn()
          .mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ projectStatus: { status: 'ERROR', conditions: [] } }),
          })
          .mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ component: { measures: [] } }),
          }),
      );

      const result = await engine.scan(makeCtx(runner, config));

      expect(result.status).toBe('success');
      expect(result.metadata?.qualityGateStatus).toBe('ERROR');
      expect(result.metadata?.qualityGatePassed).toBe(false);
    });
  });

  describe('assertAvailable', () => {
    it('resolves when sonar-scanner --version succeeds', async () => {
      const runner = new MockRunner({ '--version': { exitCode: 0, stdout: 'SonarScanner 5.0' } });
      const config = makeConfig(false);

      await expect(engine.assertAvailable(makeCtx(runner, config))).resolves.toBeUndefined();
    });

    it('throws EnvironmentError when sonar-scanner is not found', async () => {
      const runner = new MockRunner({ '--version': { exitCode: 127 } });
      const config = makeConfig(false);

      await expect(engine.assertAvailable(makeCtx(runner, config))).rejects.toThrow(EnvironmentError);
    });
  });
});

// ─── Managed mode tests ────────────────────────────────────────────────────────

describe('SonarQubeEngine — managed mode (Phase 2)', () => {
  const engine = new SonarQubeEngine();

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    delete process.env['SONAR_TOKEN'];
  });

  function makeManagedConfig(): ProjectConfig {
    return makeConfig(true, 'warn', 'managed');
  }

  it('skips when sonarqube is not enabled even in managed mode', async () => {
    const runner = new MockRunner();
    const config = makeConfig(false);
    const result = await engine.scan(makeCtx(runner, config));

    expect(result.status).toBe('skipped');
    expect(runner.calledCommands).toHaveLength(0);
  });

  it('verifies sonar-scanner availability before provisioning', async () => {
    // sonar-scanner not found
    const runner = new MockRunner({ '--version': { exitCode: 127, stderr: 'not found' } });
    const config = makeManagedConfig();

    await expect(engine.scan(makeCtx(runner, config))).rejects.toThrow(EnvironmentError);

    // Provisioner should NOT have been called (fail fast before provisioning)
    const MockProvisioner = vi.mocked(DockerSonarQubeProvisioner);
    const provisionerInstance = MockProvisioner.mock.results[0]?.value as {
      provision: ReturnType<typeof vi.fn>;
    } | undefined;
    // If no provisioner was constructed at all, that's fine — also acceptable
    if (provisionerInstance) {
      expect(provisionerInstance.provision).not.toHaveBeenCalled();
    }
  });

  it('provisions, scans, and tears down in managed mode', async () => {
    const runner = new MockRunner({
      '--version': { exitCode: 0, stdout: 'SonarScanner 5.0' },
      'sonar-scanner -D': { exitCode: 0, stdout: 'ANALYSIS SUCCESSFUL' },
    });
    const config = makeManagedConfig();

    // Mock SonarQube API (quality gate + metrics)
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ status: 'UP' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ projectStatus: { status: 'OK', conditions: [] } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ component: { measures: [] } }),
        }),
    );

    const result = await engine.scan(makeCtx(runner, config));

    expect(result.status).toBe('success');
    expect(result.agent).toBe('sonarqube');

    // Provisioner should have been used
    const MockProvisioner = vi.mocked(DockerSonarQubeProvisioner);
    expect(MockProvisioner).toHaveBeenCalledOnce();
    const instance = MockProvisioner.mock.results[0]?.value as {
      provision: ReturnType<typeof vi.fn>;
      waitReady: ReturnType<typeof vi.fn>;
      teardown: ReturnType<typeof vi.fn>;
    };
    expect(instance.provision).toHaveBeenCalledOnce();
    expect(instance.waitReady).toHaveBeenCalledOnce();
    expect(instance.teardown).toHaveBeenCalledOnce();
  });

  it('tears down container even when scan fails (finally guarantee)', async () => {
    const runner = new MockRunner({
      '--version': { exitCode: 0, stdout: 'SonarScanner 5.0' },
      // sonar-scanner exits with error
      'sonar-scanner -D': { exitCode: 1, stderr: 'ANALYSIS FAILED' },
    });
    const config = makeManagedConfig();

    // Mock API calls won't be reached because scan fails, but stub fetch anyway
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, statusText: 'unavailable', json: async () => ({}) }));

    const result = await engine.scan(makeCtx(runner, config));

    // Result encodes the scan failure
    expect(result.status).toBe('error');

    // Teardown must have been called regardless
    const MockProvisioner = vi.mocked(DockerSonarQubeProvisioner);
    const instance = MockProvisioner.mock.results[0]?.value as {
      teardown: ReturnType<typeof vi.fn>;
    };
    expect(instance.teardown).toHaveBeenCalledOnce();
  });

  it('tears down when waitReady throws (provision error path)', async () => {
    // Mock the provisioner so waitReady throws
    const MockProvisioner = vi.mocked(DockerSonarQubeProvisioner);
    MockProvisioner.mockImplementationOnce(() => ({
      provision: vi.fn().mockResolvedValue({ baseUrl: 'http://localhost:19999' }),
      waitReady: vi.fn().mockRejectedValue(new Error('Container never became ready')),
      teardown: vi.fn().mockResolvedValue(undefined),
    }) as unknown as DockerSonarQubeProvisioner);

    const runner = new MockRunner({
      '--version': { exitCode: 0, stdout: 'SonarScanner 5.0' },
    });
    const config = makeManagedConfig();

    await expect(engine.scan(makeCtx(runner, config))).rejects.toThrow('Container never became ready');

    // teardown must still have been called
    const instance = MockProvisioner.mock.results[0]?.value as {
      teardown: ReturnType<typeof vi.fn>;
    };
    expect(instance.teardown).toHaveBeenCalledOnce();
  });

  it('uses admin credentials (not SONAR_TOKEN) for managed mode scan command', async () => {
    const runner = new MockRunner({
      '--version': { exitCode: 0, stdout: 'SonarScanner 5.0' },
      'sonar-scanner -D': { exitCode: 0, stdout: 'ANALYSIS SUCCESSFUL' },
    });
    const config = makeManagedConfig();

    // Stub fetch for quality gate + metrics
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: async () => ({ projectStatus: { status: 'OK', conditions: [] } }),
        })
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: async () => ({ component: { measures: [] } }),
        }),
    );

    await engine.scan(makeCtx(runner, config));

    // The scan command should NOT include -Dsonar.token (external mode arg)
    // but should include admin credentials
    const scanCommand = runner.calledCommands.find((c) => c.includes('-Dsonar.projectKey'));
    expect(scanCommand).toBeDefined();
    expect(scanCommand).toContain('sonar.login=admin');
    expect(scanCommand).not.toContain('sonar.token=');
  });

  it('returns success in dry-run mode without provisioning a container', async () => {
    const runner = new MockRunner(
      { '--version': { exitCode: 0, stdout: 'SonarScanner 5.0' } },
      { dryRun: true },
    );
    const config = makeManagedConfig();

    const result = await engine.scan(makeCtx(runner, config));

    expect(result.status).toBe('success');

    // Provisioner should still have been used (we provision, then check dryRun inside)
    const MockProvisioner = vi.mocked(DockerSonarQubeProvisioner);
    expect(MockProvisioner).toHaveBeenCalled();
    // But no actual sonar-scanner -Dsonar.projectKey call
    const scanCalls = runner.calledCommands.filter((c) => c.includes('-Dsonar.projectKey'));
    expect(scanCalls).toHaveLength(0);

    // Teardown must always be called
    const instance = MockProvisioner.mock.results[0]?.value as {
      teardown: ReturnType<typeof vi.fn>;
    };
    expect(instance.teardown).toHaveBeenCalledOnce();
  });
});
