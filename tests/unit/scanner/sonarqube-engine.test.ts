import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SonarQubeEngine } from '@modules/scanner/sonarqube-engine';
import { EnvironmentError } from '@core/errors';
import type { ScannerEngineContext } from '@modules/scanner/types';
import type { CommandRunner, CommandResult, CommandRunnerOptions, ExecutionEnv } from '@core/types/common';
import type { ProjectConfig } from '@core/types/config';
import type { EcosystemRegistry } from '@modules/ecosystem/registry';
import fs from 'node:fs';

// ─── Mock DockerSonarQubeProvisioner for unit tests ────────────────────────────
// We do NOT want real Docker calls in unit tests.

vi.mock('@infra/provisioner/docker-sonarqube.js', () => ({
  DockerSonarQubeProvisioner: vi.fn().mockImplementation(() => ({
    provision: vi.fn().mockResolvedValue({ baseUrl: 'http://localhost:19999' }),
    waitReady: vi.fn().mockResolvedValue(undefined),
    teardown: vi.fn().mockResolvedValue(undefined),
  })),
}));

// ─── Mock DockerSonarScannerRunner for unit tests ──────────────────────────────
// Controlled mock for the container-fallback path in managed mode.

vi.mock('@infra/provisioner/docker-sonar-scanner.js', () => ({
  DockerSonarScannerRunner: vi.fn().mockImplementation(() => ({
    run: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'ANALYSIS SUCCESSFUL', stderr: '' }),
  })),
}));

import { DockerSonarQubeProvisioner } from '@infra/provisioner/docker-sonarqube';
import { DockerSonarScannerRunner } from '@infra/provisioner/docker-sonar-scanner';

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

  /**
   * Shell-safe variant — records the reconstructed command string so existing
   * calledCommands assertions (includes('-Dsonar.projectKey'), contains('sonar.token='), etc.)
   * continue to work without modification.
   */
  async runArgs(file: string, args: string[], _opts?: CommandRunnerOptions): Promise<CommandResult> {
    const command = [file, ...args].join(' ');
    this.calledCommands.push(command);
    for (const [key, resp] of this.responses) {
      if (command.includes(key)) {
        return { stdout: resp.stdout ?? '', stderr: resp.stderr ?? '', exitCode: resp.exitCode ?? 0, command, dryRun: this.dryRun };
      }
    }
    return { stdout: '', stderr: '', exitCode: 0, command, dryRun: this.dryRun };
  }
}

function makeConfig(sonarEnabled = false, onFailure: 'warn' | 'fail' = 'warn', mode: 'external' | 'managed' = 'external', sendBranchName = false): ProjectConfig {
  return {
    project: { name: 'test', client: 'client' },
    protected_packages: { composer: [], npm: [] },
    safe_update_policy: {
      allow_patch_and_minor_within_constraints: true,
      require_authorization_for_constraint_change: false,
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
              send_branch_name: sendBranchName,
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
    branch: null,
  };
}

// ─── Helper: stub fetch for managed mode with token generation + metadata ───────

/**
 * Stubs global fetch to handle the managed-mode sequence:
 *  1. POST /api/user_tokens/revoke  (token cleanup, ignored)
 *  2. POST /api/user_tokens/generate → returns { token: 'ephemeral-tok' }
 *  3. GET  /api/qualitygates/project_status → qualityGateResponse
 *  4. GET  /api/measures/component → measuresResponse
 *  5. GET  /api/issues/search → (optional, defaults to 404 → null)
 */
function stubFetchForManagedMode(
  qualityGateResponse: object,
  measuresResponse: object,
  opts: { tokenGenerationFails?: boolean } = {},
) {
  const tokenResp = opts.tokenGenerationFails
    ? { ok: false, status: 500, statusText: 'Internal Server Error', json: async () => ({}) }
    : { ok: true, status: 200, json: async () => ({ token: 'ephemeral-tok', name: 'deep-health-scan' }) };

  vi.stubGlobal(
    'fetch',
    vi.fn()
      // revoke (best-effort)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) })
      // generate
      .mockResolvedValueOnce(tokenResp)
      // quality gate
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => qualityGateResponse })
      // measures
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => measuresResponse })
      // issues (best-effort — 404 → null)
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) }),
  );
}

// ─── Contract: runArgs must be the ONLY path used for scan execution ───────────

describe('CommandRunner contract — runArgs required for scan execution', () => {
  const engine = new SonarQubeEngine();

  beforeEach(() => {
    process.env['SONAR_TOKEN'] = 'test-token';
  });
  afterEach(() => {
    delete process.env['SONAR_TOKEN'];
    vi.unstubAllGlobals();
  });

  it('calls runArgs (not run) for the sonar-scanner scan invocation', async () => {
    const runArgsCalls: Array<{ file: string; args: string[] }> = [];
    const runCalls: string[] = [];

    // Instrumented runner that records which method handles each invocation
    const instrumentedRunner: CommandRunner = {
      dryRun: false,
      environment: 'local' as const,
      // run() is still needed for --version checks (assertAvailable) — record it separately
      async run(command: string): Promise<CommandResult> {
        runCalls.push(command);
        // sonar-scanner --version succeeds
        return { stdout: 'SonarScanner 5.0', stderr: '', exitCode: 0, command, dryRun: false };
      },
      // runArgs() is the required shell-safe path for actual scan invocations
      async runArgs(file: string, args: string[]): Promise<CommandResult> {
        runArgsCalls.push({ file, args });
        const command = [file, ...args].join(' ');
        return { stdout: 'ANALYSIS SUCCESSFUL', stderr: '', exitCode: 0, command, dryRun: false };
      },
    };

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network')));

    const config = makeConfig(true);
    const ctx: ScannerEngineContext = {
      runner: instrumentedRunner,
      config,
      cwd: '/tmp/test',
      ecosystemRegistry: {} as EcosystemRegistry,
      branch: null,
    };

    await engine.scan(ctx);

    // runArgs must have been called for the scan
    expect(runArgsCalls).toHaveLength(1);
    expect(runArgsCalls[0]!.file).toBe('sonar-scanner');
    expect(runArgsCalls[0]!.args).toContain('-Dsonar.projectKey=my-project');
    expect(runArgsCalls[0]!.args.some((a) => a.startsWith('-Dsonar.token='))).toBe(true);

    // run() may only be used for --version; NOT for the scan itself
    const scanViaSingleRun = runCalls.filter((c) => c.includes('-Dsonar.projectKey'));
    expect(scanViaSingleRun).toHaveLength(0);
  });
});

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

describe('SonarQubeEngine — managed mode', () => {
  const engine = new SonarQubeEngine();

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    delete process.env['SONAR_TOKEN'];
  });

  function makeManagedConfig(sendBranchName = false): ProjectConfig {
    return makeConfig(true, 'warn', 'managed', sendBranchName);
  }

  it('skips when sonarqube is not enabled even in managed mode', async () => {
    const runner = new MockRunner();
    const config = makeConfig(false);
    const result = await engine.scan(makeCtx(runner, config));

    expect(result.status).toBe('skipped');
    expect(runner.calledCommands).toHaveLength(0);
  });

  // ── Dry-run path ──────────────────────────────────────────────────────────────

  it('returns success in dry-run mode without provisioning a container or invoking scanner', async () => {
    // In managed dry-run, the short-circuit must fire BEFORE any provisioner or
    // sonar-scanner availability check is invoked. No Docker container is ever started.
    const runner = new MockRunner(
      { '--version': { exitCode: 0, stdout: 'SonarScanner 5.0' } },
      { dryRun: true },
    );
    const config = makeManagedConfig();

    const result = await engine.scan(makeCtx(runner, config));

    expect(result.status).toBe('success');

    // SonarQube provisioner must NOT have been instantiated or used
    const MockProvisioner = vi.mocked(DockerSonarQubeProvisioner);
    expect(MockProvisioner).not.toHaveBeenCalled();

    // Container scanner runner must NOT have been instantiated or used
    const MockScannerRunner = vi.mocked(DockerSonarScannerRunner);
    expect(MockScannerRunner).not.toHaveBeenCalled();

    // sonar-scanner availability check must NOT have been called (no --version)
    expect(runner.calledCommands).toHaveLength(0);

    // No actual sonar-scanner scan command issued
    const scanCalls = runner.calledCommands.filter((c) => c.includes('-Dsonar.projectKey'));
    expect(scanCalls).toHaveLength(0);
  });

  // ── Local scanner available path ──────────────────────────────────────────────

  it('provisions, scans with local scanner, and tears down when local sonar-scanner is available', async () => {
    const runner = new MockRunner({
      '--version': { exitCode: 0, stdout: 'SonarScanner 5.0' },
      'sonar-scanner -D': { exitCode: 0, stdout: 'ANALYSIS SUCCESSFUL' },
    });
    const config = makeManagedConfig();

    stubFetchForManagedMode(
      { projectStatus: { status: 'OK', conditions: [] } },
      { component: { measures: [] } },
    );

    const result = await engine.scan(makeCtx(runner, config));

    expect(result.status).toBe('success');
    expect(result.agent).toBe('sonarqube');

    // Local sonar-scanner should have been invoked
    const scanCmd = runner.calledCommands.find((c) => c.includes('-Dsonar.projectKey'));
    expect(scanCmd).toBeDefined();
    expect(scanCmd).toContain('sonar-scanner');

    // Provisioner should have been used for the SonarQube server
    const MockProvisioner = vi.mocked(DockerSonarQubeProvisioner);
    expect(MockProvisioner).toHaveBeenCalledOnce();
    const provInstance = MockProvisioner.mock.results[0]!.value as {
      provision: ReturnType<typeof vi.fn>;
      waitReady: ReturnType<typeof vi.fn>;
      teardown: ReturnType<typeof vi.fn>;
    };
    expect(provInstance.provision).toHaveBeenCalledOnce();
    expect(provInstance.waitReady).toHaveBeenCalledOnce();
    expect(provInstance.teardown).toHaveBeenCalledOnce();

    // Container scanner runner should NOT have been used (local scanner was available)
    const MockScannerRunner = vi.mocked(DockerSonarScannerRunner);
    expect(MockScannerRunner).not.toHaveBeenCalled();
  });

  it('uses sonar.token (not sonar.login/sonar.password) in local managed-mode scan command', async () => {
    const runner = new MockRunner({
      '--version': { exitCode: 0, stdout: 'SonarScanner 5.0' },
      'sonar-scanner -D': { exitCode: 0, stdout: 'ANALYSIS SUCCESSFUL' },
    });
    const config = makeManagedConfig();

    stubFetchForManagedMode(
      { projectStatus: { status: 'OK', conditions: [] } },
      { component: { measures: [] } },
    );

    await engine.scan(makeCtx(runner, config));

    // The scan command should include -Dsonar.token (token-based auth)
    const scanCommand = runner.calledCommands.find((c) => c.includes('-Dsonar.projectKey'));
    expect(scanCommand).toBeDefined();
    expect(scanCommand).toContain('sonar.token=');
    // Must NOT use deprecated login/password
    expect(scanCommand).not.toContain('sonar.login=');
    expect(scanCommand).not.toContain('sonar.password=');
  });

  it('tears down container even when local scan fails (finally guarantee — local path)', async () => {
    const runner = new MockRunner({
      '--version': { exitCode: 0, stdout: 'SonarScanner 5.0' },
      // sonar-scanner exits with error
      'sonar-scanner -D': { exitCode: 1, stderr: 'ANALYSIS FAILED' },
    });
    const config = makeManagedConfig();

    // Token gen succeeds; subsequent metadata calls fail (scan already failed)
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) }) // revoke
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ token: 'ephemeral-tok' }) }) // generate
        .mockResolvedValue({ ok: false, status: 503, statusText: 'unavailable', json: async () => ({}) }),
    );

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

  // ── Container fallback path ───────────────────────────────────────────────────

  it('falls back to container scanner when local sonar-scanner is unavailable', async () => {
    // Local sonar-scanner is NOT available (--version fails)
    const runner = new MockRunner({ '--version': { exitCode: 127, stderr: 'not found' } });
    const config = makeManagedConfig();

    stubFetchForManagedMode(
      { projectStatus: { status: 'OK', conditions: [] } },
      { component: { measures: [] } },
    );

    const result = await engine.scan(makeCtx(runner, config));

    expect(result.status).toBe('success');

    // Container scanner runner MUST have been used
    const MockScannerRunner = vi.mocked(DockerSonarScannerRunner);
    expect(MockScannerRunner).toHaveBeenCalledOnce();
    const scannerInstance = MockScannerRunner.mock.results[0]?.value as {
      run: ReturnType<typeof vi.fn>;
    };
    expect(scannerInstance.run).toHaveBeenCalledOnce();

    // SonarQube provisioner still runs (the server side)
    const MockProvisioner = vi.mocked(DockerSonarQubeProvisioner);
    expect(MockProvisioner).toHaveBeenCalledOnce();
    const provisionerInstance = MockProvisioner.mock.results[0]?.value as {
      provision: ReturnType<typeof vi.fn>;
      waitReady: ReturnType<typeof vi.fn>;
      teardown: ReturnType<typeof vi.fn>;
    };
    expect(provisionerInstance.provision).toHaveBeenCalledOnce();
    expect(provisionerInstance.teardown).toHaveBeenCalledOnce();
  });

  it('passes sonar.token (not sonar.login) in container fallback args', async () => {
    // Local scanner unavailable
    const runner = new MockRunner({ '--version': { exitCode: 127, stderr: 'not found' } });
    const config = makeManagedConfig();

    stubFetchForManagedMode(
      { projectStatus: { status: 'OK', conditions: [] } },
      { component: { measures: [] } },
    );

    await engine.scan(makeCtx(runner, config));

    // Verify the container runner received sonar.token arg, not sonar.login
    const MockScannerRunner = vi.mocked(DockerSonarScannerRunner);
    const scannerInstance = MockScannerRunner.mock.results[0]?.value as {
      run: ReturnType<typeof vi.fn>;
    };
    const runArgs: string[] = scannerInstance.run.mock.calls[0]?.[0] ?? [];
    expect(runArgs.some((a: string) => a.startsWith('-Dsonar.token='))).toBe(true);
    expect(runArgs.some((a: string) => a.startsWith('-Dsonar.login='))).toBe(false);
    expect(runArgs.some((a: string) => a.startsWith('-Dsonar.password='))).toBe(false);
  });

  it('returns error status when ephemeral token generation fails', async () => {
    const runner = new MockRunner({
      '--version': { exitCode: 0, stdout: 'SonarScanner 5.0' },
    });
    const config = makeManagedConfig();

    // Both token generation attempts fail
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) }) // revoke ok
        .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) }) // generate fails
        .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) }), // fallback generate also fails
    );

    const result = await engine.scan(makeCtx(runner, config));

    expect(result.status).toBe('error');
    expect(result.error).toContain('ephemeral token');

    // Teardown must still have been called
    const MockProvisioner = vi.mocked(DockerSonarQubeProvisioner);
    const instance = MockProvisioner.mock.results[0]?.value as {
      teardown: ReturnType<typeof vi.fn>;
    };
    expect(instance.teardown).toHaveBeenCalledOnce();
  });

  it('returns error status when container scanner exits non-zero (fallback path)', async () => {
    // Local scanner unavailable
    const runner = new MockRunner({ '--version': { exitCode: 127 } });
    const config = makeManagedConfig();

    // Container runner returns failure
    const MockScannerRunner = vi.mocked(DockerSonarScannerRunner);
    MockScannerRunner.mockImplementationOnce(() => ({
      run: vi.fn().mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'ANALYSIS FAILED' }),
    }) as unknown as DockerSonarScannerRunner);

    // Token gen succeeds; subsequent calls fail (irrelevant — scan already failed)
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) }) // revoke
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ token: 'ephemeral-tok' }) }) // generate
        .mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }),
    );

    const result = await engine.scan(makeCtx(runner, config));

    expect(result.status).toBe('error');
    expect(result.error).toContain('container');
  });

  it('tears down provisioner even when container scanner fails (finally guarantee — fallback path)', async () => {
    // Local scanner unavailable
    const runner = new MockRunner({ '--version': { exitCode: 127 } });
    const config = makeManagedConfig();

    // Container runner returns failure
    const MockScannerRunner = vi.mocked(DockerSonarScannerRunner);
    MockScannerRunner.mockImplementationOnce(() => ({
      run: vi.fn().mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'ANALYSIS FAILED' }),
    }) as unknown as DockerSonarScannerRunner);

    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ token: 'ephemeral-tok' }) })
        .mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }),
    );

    await engine.scan(makeCtx(runner, config));

    // Teardown must have been called
    const MockProvisioner = vi.mocked(DockerSonarQubeProvisioner);
    const instance = MockProvisioner.mock.results[0]?.value as {
      teardown: ReturnType<typeof vi.fn>;
    };
    expect(instance.teardown).toHaveBeenCalledOnce();
  });

  it('tears down provisioner when container scanner throws (finally guarantee — fallback path)', async () => {
    // Local scanner unavailable
    const runner = new MockRunner({ '--version': { exitCode: 127 } });
    const config = makeManagedConfig();

    // Container runner throws
    const MockScannerRunner = vi.mocked(DockerSonarScannerRunner);
    MockScannerRunner.mockImplementationOnce(() => ({
      run: vi.fn().mockRejectedValue(new Error('Docker not found')),
    }) as unknown as DockerSonarScannerRunner);

    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ token: 'ephemeral-tok' }) }),
    );

    await expect(engine.scan(makeCtx(runner, config))).rejects.toThrow('Docker not found');

    // Teardown must still have been called
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
});

// ─── Runtime project_key validation ────────────────────────────────────────────

describe('SonarQubeEngine — project_key runtime guard', () => {
  const engine = new SonarQubeEngine();

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    delete process.env['SONAR_TOKEN'];
  });

  function makeConfigWithKey(projectKey: string): ProjectConfig {
    return {
      project: { name: 'test', client: 'client' },
      protected_packages: {},
      safe_update_policy: {
        allow_patch_and_minor_within_constraints: true,
        require_authorization_for_constraint_change: false,
      },
      conflict_resolution: 'stop_and_ask',
      ecosystems: [{ id: 'npm' }],
      scanners: {
        sonarqube: {
          enabled: true,
          mode: 'external',
          host_url: 'http://localhost:9000',
          project_key: projectKey,
          token_env: 'SONAR_TOKEN',
          on_failure: 'warn',
        },
      },
    } as ProjectConfig;
  }

  it('throws EnvironmentError when project_key contains spaces', async () => {
    process.env['SONAR_TOKEN'] = 'test-token';
    const runner = new MockRunner();
    const config = makeConfigWithKey('My Project');

    await expect(engine.scan(makeCtx(runner, config))).rejects.toThrow(EnvironmentError);
  });

  it('error message mentions project_key and actionable fix instruction', async () => {
    process.env['SONAR_TOKEN'] = 'test-token';
    const runner = new MockRunner();
    const config = makeConfigWithKey('My Project!');

    await expect(engine.scan(makeCtx(runner, config))).rejects.toThrow(/project_key/);
    await expect(engine.scan(makeCtx(runner, config))).rejects.toThrow(/project-config\.yml/);
  });

  it('does NOT throw for already-valid project_key', async () => {
    process.env['SONAR_TOKEN'] = 'test-token';
    const runner = new MockRunner({
      '--version': { exitCode: 0, stdout: 'SonarScanner 5.0' },
      'sonar-scanner -D': { exitCode: 0, stdout: 'ANALYSIS SUCCESSFUL' },
    });
    const config = makeConfigWithKey('my-valid-project');

    // stub fetch so network calls don't fail the test
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network')));

    const result = await engine.scan(makeCtx(runner, config));
    // Should not throw; scan succeeds (metadata may be UNKNOWN but status is success)
    expect(result.status).toBe('success');
  });

  it('does NOT throw for project_key with colons (org:project)', async () => {
    process.env['SONAR_TOKEN'] = 'test-token';
    const runner = new MockRunner({
      '--version': { exitCode: 0, stdout: 'SonarScanner 5.0' },
      'sonar-scanner -D': { exitCode: 0, stdout: 'ANALYSIS SUCCESSFUL' },
    });
    const config = makeConfigWithKey('org:my-project');

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network')));

    const result = await engine.scan(makeCtx(runner, config));
    expect(result.status).toBe('success');
  });
});

// ─── Branch forwarding ────────────────────────────────────────────────────────

describe('SonarQubeEngine — branch forwarding', () => {
  const engine = new SonarQubeEngine();

  beforeEach(() => {
    process.env['SONAR_TOKEN'] = 'test-token';
  });

  afterEach(() => {
    delete process.env['SONAR_TOKEN'];
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  function makeCtxWithBranch(
    runner: MockRunner,
    config: ProjectConfig,
    branch: string | null,
  ): ScannerEngineContext {
    return { ...makeCtx(runner, config), branch };
  }

  // ── External mode: opt-in ─────────────────────────────────────────────────────

  it('includes -Dsonar.branch.name in local scan command when send_branch_name=true and branch is set', async () => {
    const runner = new MockRunner({
      '--version': { exitCode: 0, stdout: 'SonarScanner 5.0' },
      'sonar-scanner -D': { exitCode: 0, stdout: 'ANALYSIS SUCCESSFUL' },
    });
    const config = makeConfig(true, 'warn', 'external', /* sendBranchName */ true);

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network')));

    await engine.scan(makeCtxWithBranch(runner, config, 'main'));

    const scanCmd = runner.calledCommands.find((c) => c.includes('-Dsonar.projectKey'));
    expect(scanCmd).toBeDefined();
    expect(scanCmd).toContain('-Dsonar.branch.name=main');
  });

  it('does NOT include -Dsonar.branch.name in local scan command when branch is null (even with send_branch_name=true)', async () => {
    const runner = new MockRunner({
      '--version': { exitCode: 0, stdout: 'SonarScanner 5.0' },
      'sonar-scanner -D': { exitCode: 0, stdout: 'ANALYSIS SUCCESSFUL' },
    });
    const config = makeConfig(true, 'warn', 'external', /* sendBranchName */ true);

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network')));

    await engine.scan(makeCtxWithBranch(runner, config, null));

    const scanCmd = runner.calledCommands.find((c) => c.includes('-Dsonar.projectKey'));
    expect(scanCmd).toBeDefined();
    expect(scanCmd).not.toContain('-Dsonar.branch.name');
  });

  // ── External mode: CE-safe default ───────────────────────────────────────────

  it('does NOT include -Dsonar.branch.name by default (send_branch_name absent — CE-safe)', async () => {
    const runner = new MockRunner({
      '--version': { exitCode: 0, stdout: 'SonarScanner 5.0' },
      'sonar-scanner -D': { exitCode: 0, stdout: 'ANALYSIS SUCCESSFUL' },
    });
    // send_branch_name defaults to false
    const config = makeConfig(true, 'warn', 'external', /* sendBranchName */ false);

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network')));

    await engine.scan(makeCtxWithBranch(runner, config, 'main'));

    const scanCmd = runner.calledCommands.find((c) => c.includes('-Dsonar.projectKey'));
    expect(scanCmd).toBeDefined();
    expect(scanCmd).not.toContain('-Dsonar.branch.name');
  });

  // ── Managed mode (local scanner path): opt-in ─────────────────────────────────

  it('includes -Dsonar.branch.name in managed local scan when send_branch_name=true and branch is set', async () => {
    const runner = new MockRunner({
      '--version': { exitCode: 0, stdout: 'SonarScanner 5.0' },
      'sonar-scanner -D': { exitCode: 0, stdout: 'ANALYSIS SUCCESSFUL' },
    });
    const config = makeConfig(true, 'warn', 'managed', /* sendBranchName */ true);

    stubFetchForManagedMode(
      { projectStatus: { status: 'OK', conditions: [] } },
      { component: { measures: [] } },
    );

    await engine.scan(makeCtxWithBranch(runner, config, 'main'));

    const scanCmd = runner.calledCommands.find((c) => c.includes('-Dsonar.projectKey'));
    expect(scanCmd).toBeDefined();
    expect(scanCmd).toContain('-Dsonar.branch.name=main');
  });

  // ── Managed mode (local scanner path): CE-safe default ───────────────────────

  it('does NOT include -Dsonar.branch.name in managed local scan when send_branch_name=false (default)', async () => {
    const runner = new MockRunner({
      '--version': { exitCode: 0, stdout: 'SonarScanner 5.0' },
      'sonar-scanner -D': { exitCode: 0, stdout: 'ANALYSIS SUCCESSFUL' },
    });
    const config = makeConfig(true, 'warn', 'managed', /* sendBranchName */ false);

    stubFetchForManagedMode(
      { projectStatus: { status: 'OK', conditions: [] } },
      { component: { measures: [] } },
    );

    await engine.scan(makeCtxWithBranch(runner, config, 'main'));

    const scanCmd = runner.calledCommands.find((c) => c.includes('-Dsonar.projectKey'));
    expect(scanCmd).toBeDefined();
    expect(scanCmd).not.toContain('-Dsonar.branch.name');
  });

  // ── Container fallback path: opt-in ──────────────────────────────────────────

  it('includes -Dsonar.branch.name in container fallback args when send_branch_name=true and branch is set', async () => {
    // Local scanner unavailable — forces container fallback
    const runner = new MockRunner({ '--version': { exitCode: 127, stderr: 'not found' } });
    const config = makeConfig(true, 'warn', 'managed', /* sendBranchName */ true);

    stubFetchForManagedMode(
      { projectStatus: { status: 'OK', conditions: [] } },
      { component: { measures: [] } },
    );

    await engine.scan(makeCtxWithBranch(runner, config, 'feature/my-branch'));

    const MockScannerRunner = vi.mocked(DockerSonarScannerRunner);
    const scannerInstance = MockScannerRunner.mock.results[0]?.value as {
      run: ReturnType<typeof vi.fn>;
    };
    const runArgs: string[] = scannerInstance.run.mock.calls[0]?.[0] ?? [];
    expect(runArgs.some((a: string) => a === '-Dsonar.branch.name=feature/my-branch')).toBe(true);
  });

  // ── Container fallback path: CE-safe default ─────────────────────────────────

  it('does NOT include -Dsonar.branch.name in container fallback args when send_branch_name=false (default)', async () => {
    // Local scanner unavailable — forces container fallback
    const runner = new MockRunner({ '--version': { exitCode: 127, stderr: 'not found' } });
    const config = makeConfig(true, 'warn', 'managed', /* sendBranchName */ false);

    stubFetchForManagedMode(
      { projectStatus: { status: 'OK', conditions: [] } },
      { component: { measures: [] } },
    );

    await engine.scan(makeCtxWithBranch(runner, config, 'main'));

    const MockScannerRunner = vi.mocked(DockerSonarScannerRunner);
    const scannerInstance = MockScannerRunner.mock.results[0]?.value as {
      run: ReturnType<typeof vi.fn>;
    };
    const runArgs: string[] = scannerInstance.run.mock.calls[0]?.[0] ?? [];
    expect(runArgs.some((a: string) => a.startsWith('-Dsonar.branch.name'))).toBe(false);
  });

  it('does NOT include -Dsonar.branch.name in container fallback args when branch is null (even with send_branch_name=true)', async () => {
    // Local scanner unavailable — forces container fallback
    const runner = new MockRunner({ '--version': { exitCode: 127, stderr: 'not found' } });
    const config = makeConfig(true, 'warn', 'managed', /* sendBranchName */ true);

    stubFetchForManagedMode(
      { projectStatus: { status: 'OK', conditions: [] } },
      { component: { measures: [] } },
    );

    await engine.scan(makeCtxWithBranch(runner, config, null));

    const MockScannerRunner = vi.mocked(DockerSonarScannerRunner);
    const scannerInstance = MockScannerRunner.mock.results[0]?.value as {
      run: ReturnType<typeof vi.fn>;
    };
    const runArgs: string[] = scannerInstance.run.mock.calls[0]?.[0] ?? [];
    expect(runArgs.some((a: string) => a.startsWith('-Dsonar.branch.name'))).toBe(false);
  });
});

// ─── Exclusion args ───────────────────────────────────────────────────────────

describe('SonarQubeEngine — exclusion args', () => {
  const engine = new SonarQubeEngine();

  beforeEach(() => {
    process.env['SONAR_TOKEN'] = 'test-token';
  });
  afterEach(() => {
    delete process.env['SONAR_TOKEN'];
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  function makeConfigWithEcosystems(
    ecosystemIds: string[],
    sonarOverrides: Partial<{ exclusions: string[]; coverage_exclusions: string[]; ce_task_timeout_seconds: number }> = {},
  ): ProjectConfig {
    return {
      project: { name: 'test', client: 'client' },
      ecosystems: ecosystemIds.map((id) => ({ id })),
      protected_packages: {},
      safe_update_policy: {
        allow_patch_and_minor_within_constraints: true,
        require_authorization_for_constraint_change: false,
      },
      conflict_resolution: 'stop_and_ask',
      scanners: {
        sonarqube: {
          enabled: true,
          mode: 'external',
          host_url: 'http://localhost:9000',
          project_key: 'my-project',
          token_env: 'SONAR_TOKEN',
          on_failure: 'warn',
          ...sonarOverrides,
        },
      },
    } as ProjectConfig;
  }

  it('applies npm ecosystem defaults when exclusions not set (node_modules/**, tests/**)', async () => {
    const runner = new MockRunner({
      '--version': { exitCode: 0, stdout: 'SonarScanner 5.0' },
      'sonar-scanner': { exitCode: 0, stdout: 'ANALYSIS SUCCESSFUL' },
    });
    const config = makeConfigWithEcosystems(['npm']);

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network')));

    await engine.scan({ runner, config, cwd: '/tmp/test', ecosystemRegistry: {} as EcosystemRegistry, branch: null });

    const scanCmd = runner.calledCommands.find((c) => c.includes('-Dsonar.projectKey'));
    expect(scanCmd).toBeDefined();
    expect(scanCmd).toContain('-Dsonar.exclusions=node_modules/**,tests/**');
    expect(scanCmd).toContain('-Dsonar.coverage.exclusions=node_modules/**,tests/**');
  });

  it('applies composer ecosystem defaults when exclusions not set (vendor/**, tests/**)', async () => {
    const runner = new MockRunner({
      '--version': { exitCode: 0, stdout: 'SonarScanner 5.0' },
      'sonar-scanner': { exitCode: 0, stdout: 'ANALYSIS SUCCESSFUL' },
    });
    const config = makeConfigWithEcosystems(['composer']);

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network')));

    await engine.scan({ runner, config, cwd: '/tmp/test', ecosystemRegistry: {} as EcosystemRegistry, branch: null });

    const scanCmd = runner.calledCommands.find((c) => c.includes('-Dsonar.projectKey'));
    expect(scanCmd).toBeDefined();
    expect(scanCmd).toContain('-Dsonar.exclusions=vendor/**,tests/**');
    expect(scanCmd).toContain('-Dsonar.coverage.exclusions=vendor/**,tests/**');
  });

  it('deduplicates exclusion patterns when both npm and composer are active', async () => {
    const runner = new MockRunner({
      '--version': { exitCode: 0, stdout: 'SonarScanner 5.0' },
      'sonar-scanner': { exitCode: 0, stdout: 'ANALYSIS SUCCESSFUL' },
    });
    const config = makeConfigWithEcosystems(['npm', 'composer']);

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network')));

    await engine.scan({ runner, config, cwd: '/tmp/test', ecosystemRegistry: {} as EcosystemRegistry, branch: null });

    const scanCmd = runner.calledCommands.find((c) => c.includes('-Dsonar.projectKey'));
    expect(scanCmd).toBeDefined();
    // tests/** appears in both npm and composer defaults — must NOT be duplicated
    const excl = scanCmd?.match(/-Dsonar\.exclusions=([^ ]+)/)?.[1] ?? '';
    const parts = excl.split(',');
    const uniqueParts = new Set(parts);
    expect(parts.length).toBe(uniqueParts.size);
    // Should contain all four unique patterns
    expect(excl).toContain('node_modules/**');
    expect(excl).toContain('vendor/**');
    expect(excl).toContain('tests/**');
  });

  it('uses explicit exclusions as full override (no merge with defaults)', async () => {
    const runner = new MockRunner({
      '--version': { exitCode: 0, stdout: 'SonarScanner 5.0' },
      'sonar-scanner': { exitCode: 0, stdout: 'ANALYSIS SUCCESSFUL' },
    });
    const config = makeConfigWithEcosystems(['npm'], {
      exclusions: ['dist/**', 'build/**'],
      coverage_exclusions: ['**/*.spec.ts'],
    });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network')));

    await engine.scan({ runner, config, cwd: '/tmp/test', ecosystemRegistry: {} as EcosystemRegistry, branch: null });

    const scanCmd = runner.calledCommands.find((c) => c.includes('-Dsonar.projectKey'));
    expect(scanCmd).toBeDefined();
    expect(scanCmd).toContain('-Dsonar.exclusions=dist/**,build/**');
    expect(scanCmd).toContain('-Dsonar.coverage.exclusions=**/*.spec.ts');
    // defaults must NOT appear when explicit override is set
    expect(scanCmd).not.toContain('node_modules/**');
  });

  it('omits -Dsonar.exclusions entirely when explicit override is empty array', async () => {
    const runner = new MockRunner({
      '--version': { exitCode: 0, stdout: 'SonarScanner 5.0' },
      'sonar-scanner': { exitCode: 0, stdout: 'ANALYSIS SUCCESSFUL' },
    });
    const config = makeConfigWithEcosystems(['npm'], {
      exclusions: [],
      coverage_exclusions: [],
    });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network')));

    await engine.scan({ runner, config, cwd: '/tmp/test', ecosystemRegistry: {} as EcosystemRegistry, branch: null });

    const scanCmd = runner.calledCommands.find((c) => c.includes('-Dsonar.projectKey'));
    expect(scanCmd).toBeDefined();
    expect(scanCmd).not.toContain('-Dsonar.exclusions=');
    expect(scanCmd).not.toContain('-Dsonar.coverage.exclusions=');
  });

  it('produces no exclusion args for unknown ecosystem without explicit config', async () => {
    const runner = new MockRunner({
      '--version': { exitCode: 0, stdout: 'SonarScanner 5.0' },
      'sonar-scanner': { exitCode: 0, stdout: 'ANALYSIS SUCCESSFUL' },
    });
    const config = makeConfigWithEcosystems(['ruby']); // no defaults defined

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network')));

    await engine.scan({ runner, config, cwd: '/tmp/test', ecosystemRegistry: {} as EcosystemRegistry, branch: null });

    const scanCmd = runner.calledCommands.find((c) => c.includes('-Dsonar.projectKey'));
    expect(scanCmd).toBeDefined();
    expect(scanCmd).not.toContain('-Dsonar.exclusions=');
    expect(scanCmd).not.toContain('-Dsonar.coverage.exclusions=');
  });

  it('passes exclusion args through to container fallback path in managed mode', async () => {
    // Local scanner unavailable — forces container fallback
    const runner = new MockRunner({ '--version': { exitCode: 127, stderr: 'not found' } });
    const config: ProjectConfig = {
      project: { name: 'test', client: 'client' },
      ecosystems: [{ id: 'npm' }],
      protected_packages: {},
      safe_update_policy: { allow_patch_and_minor_within_constraints: true, require_authorization_for_constraint_change: false },
      conflict_resolution: 'stop_and_ask',
      scanners: {
        sonarqube: {
          enabled: true,
          mode: 'managed',
          host_url: 'http://localhost:9000',
          project_key: 'my-project',
          token_env: 'SONAR_TOKEN',
          on_failure: 'warn',
          exclusions: ['custom/**'],
        },
      },
    } as ProjectConfig;

    stubFetchForManagedMode(
      { projectStatus: { status: 'OK', conditions: [] } },
      { component: { measures: [] } },
    );

    await engine.scan({ runner, config, cwd: '/tmp/test', ecosystemRegistry: {} as EcosystemRegistry, branch: null });

    const MockScannerRunner = vi.mocked(DockerSonarScannerRunner);
    const scannerInstance = MockScannerRunner.mock.results[0]?.value as {
      run: ReturnType<typeof vi.fn>;
    };
    const runArgs: string[] = scannerInstance.run.mock.calls[0]?.[0] ?? [];
    expect(runArgs.some((a: string) => a === '-Dsonar.exclusions=custom/**')).toBe(true);
  });
});

// ─── CE-task waiting ──────────────────────────────────────────────────────────

describe('SonarQubeEngine — CE-task waiting', () => {
  const engine = new SonarQubeEngine();

  beforeEach(() => {
    process.env['SONAR_TOKEN'] = 'test-token';
    vi.useFakeTimers();
  });
  afterEach(() => {
    delete process.env['SONAR_TOKEN'];
    vi.restoreAllMocks(); // restores fs.readFileSync spy + clears all mocks
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /**
   * Helper: write a fake report-task.txt with the given ceTaskId to a temp path
   * and make parseCeTaskId find it by spying on fs.readFileSync.
   */
  function stubReportTaskFile(ceTaskId: string): void {
    vi.spyOn(fs, 'readFileSync').mockImplementation((path: unknown) => {
      if (typeof path === 'string' && path.endsWith('report-task.txt')) {
        return `projectKey=my-project\nceTaskId=${ceTaskId}\nserverUrl=http://internal:9000\n`;
      }
      // For any other path, use real implementation via error (tests don't need other files)
      throw new Error(`ENOENT: no such file: ${String(path)}`);
    });
  }

  it('polls CE task and proceeds to quality gate after SUCCESS status (no timeout)', async () => {
    const runner = new MockRunner({
      '--version': { exitCode: 0, stdout: 'SonarScanner 5.0' },
      'sonar-scanner': { exitCode: 0, stdout: 'ANALYSIS SUCCESSFUL' },
    });
    const config = makeConfig(true);

    stubReportTaskFile('task-abc-123');

    // fetch sequence:
    // 1. CE task poll → SUCCESS
    // 2. qualitygates/project_status
    // 3. measures/component
    // 4. issues/search (optional — 404)
    vi.stubGlobal(
      'fetch',
      vi.fn()
        // CE task poll
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ task: { status: 'SUCCESS' } }) })
        // quality gate
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ projectStatus: { status: 'OK', conditions: [] } }) })
        // measures
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ component: { measures: [] } }) })
        // issues (best-effort 404 → null)
        .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) }),
    );

    const resultPromise = engine.scan({ runner, config, cwd: '/tmp/test', ecosystemRegistry: {} as EcosystemRegistry, branch: null });

    // The CE poller fires immediately on first poll — advance past the initial fetch
    await vi.runAllTimersAsync();

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.metadata?.qualityGateStatus).toBe('OK');

    // Verify CE task was polled using hostUrl (http://localhost:9000), NOT the serverUrl from the file
    const fetchMock = vi.mocked(fetch);
    const ceCallUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(ceCallUrl).toContain('localhost:9000');
    expect(ceCallUrl).toContain('/api/ce/task?id=task-abc-123');
    // Must NOT use the internal Docker URL from report-task.txt
    expect(ceCallUrl).not.toContain('internal:9000');
  });

  it('degrades gracefully when CE task times out — pipeline is NOT hard-failed', async () => {
    const runner = new MockRunner({
      '--version': { exitCode: 0, stdout: 'SonarScanner 5.0' },
      'sonar-scanner': { exitCode: 0, stdout: 'ANALYSIS SUCCESSFUL' },
    });
    // ce_task_timeout_seconds=1 → very short timeout to force timeout path
    const config: ProjectConfig = {
      ...makeConfig(true),
      scanners: {
        sonarqube: {
          enabled: true,
          mode: 'external',
          host_url: 'http://localhost:9000',
          project_key: 'my-project',
          token_env: 'SONAR_TOKEN',
          on_failure: 'warn',
          ce_task_timeout_seconds: 1,
        },
      },
    } as ProjectConfig;

    stubReportTaskFile('task-timeout-test');

    // CE task always returns IN_PROGRESS → timeout will be hit
    vi.stubGlobal(
      'fetch',
      vi.fn()
        // CE polls (IN_PROGRESS repeatedly) then quality gate fetch after timeout
        .mockResolvedValue({ ok: true, status: 200, json: async () => ({ task: { status: 'IN_PROGRESS' } }) }),
    );

    const resultPromise = engine.scan({ runner, config, cwd: '/tmp/test', ecosystemRegistry: {} as EcosystemRegistry, branch: null });

    // Advance time well past the 1s timeout
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.runAllTimersAsync();

    // After timeout, stub fetch to resolve quality gate + measures + issues
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ projectStatus: { status: 'NONE', conditions: [] } }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ component: { measures: [] } }) } as Response)
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) } as Response);

    await vi.runAllTimersAsync();

    const result = await resultPromise;

    // Pipeline must NOT fail — should be 'success' (metadata may show NONE)
    expect(result.status).toBe('success');
  });
});

describe('SonarQubeEngine — CE-task waiting (no fake timers)', () => {
  const engine = new SonarQubeEngine();

  beforeEach(() => {
    process.env['SONAR_TOKEN'] = 'test-token';
  });
  afterEach(() => {
    delete process.env['SONAR_TOKEN'];
    vi.restoreAllMocks(); // restores any fs.readFileSync spies from previous suites
    vi.unstubAllGlobals();
  });

  it('falls back to immediate quality gate fetch when report-task.txt is missing (graceful)', async () => {
    const runner = new MockRunner({
      '--version': { exitCode: 0, stdout: 'SonarScanner 5.0' },
      'sonar-scanner': { exitCode: 0, stdout: 'ANALYSIS SUCCESSFUL' },
    });
    const config = makeConfig(true);

    // No stub → fs.readFileSync throws → parseCeTaskId returns null → CE wait skipped
    // fetch: directly quality gate + measures + issues
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ projectStatus: { status: 'OK', conditions: [] } }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ component: { measures: [] } }) })
        .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) }),
    );

    const result = await engine.scan({ runner, config, cwd: '/tmp/test', ecosystemRegistry: {} as EcosystemRegistry, branch: null });

    expect(result.status).toBe('success');
    expect(result.metadata?.qualityGateStatus).toBe('OK');
  });

  it('skips CE waiting when ce_task_timeout_seconds is 0', async () => {
    const runner = new MockRunner({
      '--version': { exitCode: 0, stdout: 'SonarScanner 5.0' },
      'sonar-scanner': { exitCode: 0, stdout: 'ANALYSIS SUCCESSFUL' },
    });
    const config: ProjectConfig = {
      ...makeConfig(true),
      scanners: {
        sonarqube: {
          enabled: true,
          mode: 'external',
          host_url: 'http://localhost:9000',
          project_key: 'my-project',
          token_env: 'SONAR_TOKEN',
          on_failure: 'warn',
          ce_task_timeout_seconds: 0,
        },
      },
    } as ProjectConfig;

    vi.spyOn(fs, 'readFileSync').mockImplementation((path: unknown) => {
      if (typeof path === 'string' && path.endsWith('report-task.txt')) {
        return `ceTaskId=task-disabled-wait\n`;
      }
      throw new Error(`ENOENT: no such file: ${String(path)}`);
    });

    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ projectStatus: { status: 'OK', conditions: [] } }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ component: { measures: [] } }) })
        .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) }),
    );

    const result = await engine.scan({ runner, config, cwd: '/tmp/test', ecosystemRegistry: {} as EcosystemRegistry, branch: null });

    expect(result.status).toBe('success');

    // Verify the CE task API was NOT called (no /api/ce/task calls)
    const fetchMock = vi.mocked(fetch);
    const ceCalls = fetchMock.mock.calls.filter(([url]) => typeof url === 'string' && String(url).includes('/api/ce/task'));
    expect(ceCalls).toHaveLength(0);
  });
})
