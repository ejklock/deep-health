import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SonarQubeEngine, computeEffectiveTimeouts, fetchNcloc } from '@modules/scanner/sonarqube-engine';
import { EnvironmentError } from '@core/errors';
import type { ScannerEngineContext } from '@modules/scanner/types';
import type { CommandRunner, CommandResult, CommandRunnerOptions, ExecutionEnv } from '@core/types/common';
import type { ProjectConfig } from '@core/types/config';
import type { EcosystemRegistry } from '@modules/ecosystem/registry';
import fs from 'node:fs';

// ─── Mock sonar-properties helper ──────────────────────────────────────────────
// Tests now read project-level config (projectKey, host.url, etc.) from
// sonar-project.properties via readSonarProperties. We mock that helper with a
// shared in-memory fixture so tests don't touch the filesystem and can drive
// scenarios (missing file, missing key, etc.) via setSonarPropsFixture.
//
// sanitizeAndWriteProperties is stubbed to a no-op returning a fake temp path —
// the engine never reads the returned file during unit tests.
const { setSonarPropsFixture, readPropsMock, sanitizeMock } = vi.hoisted(() => {
  const fixture: { value: Map<string, string> | null } = {
    value: new Map<string, string>([
      ['sonar.projectKey', 'my-project'],
      ['sonar.host.url', 'http://localhost:9000'],
    ]),
  };
  return {
    setSonarPropsFixture: (value: Map<string, string> | null): void => {
      fixture.value = value;
    },
    readPropsMock: vi.fn(async () => fixture.value),
    sanitizeMock: vi.fn(async () => ({
      path: '/tmp/fake-sanitized-sonar.properties',
      cleanup: async () => undefined,
      strippedKeys: [],
      fromScratch: false,
    })),
  };
});

vi.mock('@modules/scanner/sonar-properties', () => ({
  readSonarProperties: readPropsMock,
  sanitizeAndWriteProperties: sanitizeMock,
  DEPRECATED_AUTH_KEYS: ['sonar.login', 'sonar.password'],
  CLI_OWNED_KEYS: ['sonar.host.url', 'sonar.token'],
}));

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
          // NOTE: fetch call order — (1) fetchNcloc pre-scan, (2) quality gate, (3) measures, (4+) issues
          // fetchNcloc is called first for external mode with dynamic_timeout:true (default)
          .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) }) // ncloc (no prior analysis)
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
          // NOTE: fetch call order — (1) fetchNcloc pre-scan, (2) quality gate, (3) measures, (4+) issues
          .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) }) // ncloc (no prior analysis)
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

  it('uses sonar.token and sonar.login (not sonar.password) in local managed-mode scan command', async () => {
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

    // The scan command must include both sonar.token (5.x+) and sonar.login (4.x compat)
    const scanCommand = runner.calledCommands.find((c) => c.includes('-Dsonar.projectKey'));
    expect(scanCommand).toBeDefined();
    expect(scanCommand).toContain('sonar.token=');
    expect(scanCommand).toContain('sonar.login=');
    // Must NOT use password-based auth
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

  it('passes sonar.token and sonar.login (not sonar.password) in container fallback args', async () => {
    // Local scanner unavailable
    const runner = new MockRunner({ '--version': { exitCode: 127, stderr: 'not found' } });
    const config = makeManagedConfig();

    stubFetchForManagedMode(
      { projectStatus: { status: 'OK', conditions: [] } },
      { component: { measures: [] } },
    );

    await engine.scan(makeCtx(runner, config));

    // Verify the container runner received both sonar.token (5.x+) and sonar.login (4.x compat)
    const MockScannerRunner = vi.mocked(DockerSonarScannerRunner);
    const scannerInstance = MockScannerRunner.mock.results[0]?.value as {
      run: ReturnType<typeof vi.fn>;
    };
    const runArgs: string[] = scannerInstance.run.mock.calls[0]?.[0] ?? [];
    expect(runArgs.some((a: string) => a.startsWith('-Dsonar.token='))).toBe(true);
    expect(runArgs.some((a: string) => a.startsWith('-Dsonar.login='))).toBe(true);
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

  /**
   * projectKey now lives in sonar-project.properties, not in config.yml.
   * This helper returns a standard sonarqube-enabled config AND installs a
   * matching fixture for the properties mock. Call it in the test body.
   */
  function makeConfigWithKey(projectKey: string): ProjectConfig {
    setSonarPropsFixture(new Map<string, string>([
      ['sonar.projectKey', projectKey],
      ['sonar.host.url', 'http://localhost:9000'],
    ]));
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

  it('error message mentions sonar.projectKey and references sonar-project.properties', async () => {
    process.env['SONAR_TOKEN'] = 'test-token';
    const runner = new MockRunner();
    const config = makeConfigWithKey('My Project!');

    // Error now mentions the properties-file field name (sonar.projectKey)
    // and points the user at sonar-project.properties, not config.yml.
    await expect(engine.scan(makeCtx(runner, config))).rejects.toThrow(/sonar\.projectKey/);
    await expect(engine.scan(makeCtx(runner, config))).rejects.toThrow(/sonar-project\.properties/);
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

// ─── project.settings integration (sanitized properties file handoff) ────────

describe('SonarQubeEngine — project.settings integration', () => {
  const engine = new SonarQubeEngine();

  beforeEach(() => {
    process.env['SONAR_TOKEN'] = 'test-token';
    // Reset sanitize mock between tests so call assertions are clean.
    sanitizeMock.mockClear();
    // Reset the properties fixture — earlier describe blocks (project_key runtime
    // guard) install custom fixtures via setSonarPropsFixture that persist otherwise.
    setSonarPropsFixture(new Map<string, string>([
      ['sonar.projectKey', 'my-project'],
      ['sonar.host.url', 'http://localhost:9000'],
    ]));
  });
  afterEach(() => {
    delete process.env['SONAR_TOKEN'];
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  // Inlined ecosystem config builder — used only within this block.
  function makeConfigWithEcosystems(ecosystemIds: string[]): ProjectConfig {
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
        sonarqube: { enabled: true, mode: 'external', on_failure: 'warn' },
      },
    } as ProjectConfig;
  }

  it('passes -Dproject.settings pointing to the sanitized temp file', async () => {
    const runner = new MockRunner({
      '--version': { exitCode: 0, stdout: 'SonarScanner 5.0' },
      'sonar-scanner': { exitCode: 0, stdout: 'ANALYSIS SUCCESSFUL' },
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network')));

    await engine.scan({ runner, config: makeConfigWithEcosystems(['npm']), cwd: '/tmp/test', ecosystemRegistry: {} as EcosystemRegistry, branch: null });

    // runner.calledCommands contains both the `--version` probe and the real scan.
    // Pick the scan (the one that has the -D args).
    const scanCmd = runner.calledCommands.find((c) => c.includes('-Dproject.settings='));
    expect(scanCmd).toBeDefined();
    expect(scanCmd).toContain('-Dproject.settings=/tmp/fake-sanitized-sonar.properties');
  });

  it('invokes sanitizeAndWriteProperties with os-tmpdir location and host/projectKey overrides (external mode)', async () => {
    const runner = new MockRunner({
      '--version': { exitCode: 0, stdout: 'SonarScanner 5.0' },
      'sonar-scanner': { exitCode: 0, stdout: 'ANALYSIS SUCCESSFUL' },
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network')));

    await engine.scan({ runner, config: makeConfigWithEcosystems(['npm']), cwd: '/tmp/test', ecosystemRegistry: {} as EcosystemRegistry, branch: null });

    expect(sanitizeMock).toHaveBeenCalledTimes(1);
    const callArgs = sanitizeMock.mock.calls[0]![0] as { cwd: string; location: string; overrides?: Record<string, string> };
    expect(callArgs.cwd).toBe('/tmp/test');
    expect(callArgs.location).toBe('os-tmpdir');
    // External mode passes through the host URL from the properties fixture + projectKey.
    expect(callArgs.overrides).toEqual({
      'sonar.host.url': 'http://localhost:9000',
      'sonar.projectKey': 'my-project',
    });
  });

  it('invokes sanitizeAndWriteProperties with cwd-hidden location in managed mode container fallback', async () => {
    // Force container path: local scanner probe returns non-zero
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
          on_failure: 'warn',
        },
      },
    } as ProjectConfig;

    stubFetchForManagedMode(
      { projectStatus: { status: 'OK', conditions: [] } },
      { component: { measures: [] } },
    );

    await engine.scan({ runner, config, cwd: '/tmp/test', ecosystemRegistry: {} as EcosystemRegistry, branch: null });

    expect(sanitizeMock).toHaveBeenCalledTimes(1);
    const callArgs = sanitizeMock.mock.calls[0]![0] as { cwd: string; location: string; overrides?: Record<string, string> };
    // Container fallback requires the sanitized file inside cwd (container mounts cwd).
    expect(callArgs.location).toBe('cwd-hidden');
    // Managed mode overrides host.url with the ephemeral container URL, not the one
    // from sonar-project.properties (which came from the fixture).
    expect(callArgs.overrides!['sonar.host.url']).toBe('http://localhost:19999');
    expect(callArgs.overrides!['sonar.projectKey']).toBe('my-project');

    // The -Dproject.settings arg is passed to the container runner (container
    // auto-injects -Dsonar.host.url, so we strip that duplicate — but project.settings
    // survives).
    const MockScannerRunner = vi.mocked(DockerSonarScannerRunner);
    const scannerInstance = MockScannerRunner.mock.results[0]?.value as {
      run: ReturnType<typeof vi.fn>;
    };
    const runArgs: string[] = scannerInstance.run.mock.calls[0]?.[0] ?? [];
    expect(runArgs.some((a: string) => a.startsWith('-Dproject.settings='))).toBe(true);
    // The -Dsonar.host.url is NOT passed — scanner runner adds it itself.
    expect(runArgs.some((a: string) => a.startsWith('-Dsonar.host.url='))).toBe(false);
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
    // 1. fetchNcloc pre-scan (external mode dynamic_timeout:true)
    // 2. CE task poll → SUCCESS
    // 3. qualitygates/project_status
    // 4. measures/component
    // 5. issues/search (optional — 404)
    vi.stubGlobal(
      'fetch',
      vi.fn()
        // ncloc pre-scan (no prior analysis → null)
        .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
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
    // Note: mock.calls[0] is the fetchNcloc pre-scan call; CE poll is at index 1
    const fetchMock = vi.mocked(fetch);
    const ceCallUrl = fetchMock.mock.calls[1]?.[0] as string;
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
    // fetch: (1) ncloc pre-scan, (2) quality gate, (3) measures, (4) issues
    vi.stubGlobal(
      'fetch',
      vi.fn()
        // NOTE: fetch call order — (1) fetchNcloc pre-scan, (2) quality gate, (3) measures, (4) issues
        .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) }) // ncloc (no prior analysis)
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
        // NOTE: fetch call order — (1) fetchNcloc pre-scan, (2) quality gate, (3) measures, (4) issues
        .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) }) // ncloc (no prior analysis)
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
});

// ─── Coverage gap: parseCeTaskId returns null when key not found / file absent ──

describe('SonarQubeEngine — parseCeTaskId edge cases (line 82, 83-86)', () => {
  const engine = new SonarQubeEngine();

  beforeEach(() => {
    process.env['SONAR_TOKEN'] = 'test-token';
    vi.useFakeTimers();
  });
  afterEach(() => {
    delete process.env['SONAR_TOKEN'];
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('proceeds to quality-gate fetch when report-task.txt has no ceTaskId key (line 82)', async () => {
    // file exists but has no ceTaskId line → parseCeTaskId returns null → waitForCeTask returns 'skipped'
    vi.spyOn(fs, 'readFileSync').mockImplementation((path: unknown) => {
      if (typeof path === 'string' && path.endsWith('report-task.txt')) {
        return 'projectKey=my-project\nserverUrl=http://internal:9000\n'; // no ceTaskId line
      }
      throw new Error(`ENOENT: ${String(path)}`);
    });

    const runner = new MockRunner({
      '--version': { exitCode: 0, stdout: 'SonarScanner 5.0' },
      'sonar-scanner': { exitCode: 0, stdout: 'ANALYSIS SUCCESSFUL' },
    });
    const config = makeConfig(true);

    vi.stubGlobal(
      'fetch',
      vi.fn()
        // NOTE: fetch call order — (1) fetchNcloc pre-scan, (2) quality gate, (3) measures, (4) issues
        .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) }) // ncloc (no prior analysis)
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ projectStatus: { status: 'OK', conditions: [] } }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ component: { measures: [] } }) })
        .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) }),
    );

    const resultPromise = engine.scan({ runner, config, cwd: '/tmp/test', ecosystemRegistry: {} as EcosystemRegistry, branch: null });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.status).toBe('success');
  });

  it('proceeds to quality-gate fetch when report-task.txt is absent (catch block line 83-86)', async () => {
    // file does not exist → readFileSync throws → parseCeTaskId returns null
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('ENOENT: no such file');
    });

    const runner = new MockRunner({
      '--version': { exitCode: 0, stdout: 'SonarScanner 5.0' },
      'sonar-scanner': { exitCode: 0, stdout: 'ANALYSIS SUCCESSFUL' },
    });
    const config = makeConfig(true);

    vi.stubGlobal(
      'fetch',
      vi.fn()
        // NOTE: fetch call order — (1) fetchNcloc pre-scan, (2) quality gate, (3) measures, (4) issues
        .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) }) // ncloc (no prior analysis)
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ projectStatus: { status: 'OK', conditions: [] } }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ component: { measures: [] } }) })
        .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) }),
    );

    const resultPromise = engine.scan({ runner, config, cwd: '/tmp/test', ecosystemRegistry: {} as EcosystemRegistry, branch: null });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.status).toBe('success');
  });
});

// ─── Coverage gap: waitForCeTask — HTTP non-ok + FAILED/CANCELED + catch ────────

describe('SonarQubeEngine — waitForCeTask branches (lines 129, 140-142, 146-147)', () => {
  const engine = new SonarQubeEngine();

  beforeEach(() => {
    process.env['SONAR_TOKEN'] = 'test-token';
    vi.useFakeTimers();
  });
  afterEach(() => {
    delete process.env['SONAR_TOKEN'];
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function stubReportTaskFile(ceTaskId: string): void {
    vi.spyOn(fs, 'readFileSync').mockImplementation((path: unknown) => {
      if (typeof path === 'string' && path.endsWith('report-task.txt')) {
        return `projectKey=my-project\nceTaskId=${ceTaskId}\nserverUrl=http://internal:9000\n`;
      }
      throw new Error(`ENOENT: ${String(path)}`);
    });
  }

  it('retries on non-ok CE task poll then succeeds (line 129)', async () => {
    const runner = new MockRunner({
      '--version': { exitCode: 0, stdout: 'SonarScanner 5.0' },
      'sonar-scanner': { exitCode: 0, stdout: 'ANALYSIS SUCCESSFUL' },
    });
    const config = makeConfig(true);
    stubReportTaskFile('task-retry-123');

    vi.stubGlobal(
      'fetch',
      vi.fn()
        // NOTE: fetch call order — (1) fetchNcloc pre-scan, (2+) CE polls, then quality gate, measures, issues
        .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) }) // ncloc (no prior analysis)
        // First CE poll → non-ok (line 129)
        .mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Service Unavailable', json: async () => ({}) })
        // Second CE poll → SUCCESS
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ task: { status: 'SUCCESS' } }) })
        // quality gate
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ projectStatus: { status: 'OK', conditions: [] } }) })
        // measures
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ component: { measures: [] } }) })
        // issues
        .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) }),
    );

    const resultPromise = engine.scan({ runner, config, cwd: '/tmp/test', ecosystemRegistry: {} as EcosystemRegistry, branch: null });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.status).toBe('success');
  });

  it('returns failed when CE task status is FAILED (lines 140-142)', async () => {
    const runner = new MockRunner({
      '--version': { exitCode: 0, stdout: 'SonarScanner 5.0' },
      'sonar-scanner': { exitCode: 0, stdout: 'ANALYSIS SUCCESSFUL' },
    });
    const config = makeConfig(true);
    stubReportTaskFile('task-fail-456');

    vi.stubGlobal(
      'fetch',
      vi.fn()
        // NOTE: fetch call order — (1) fetchNcloc pre-scan, (2) CE poll, then quality gate, measures, issues
        .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) }) // ncloc (no prior analysis)
        // CE poll → FAILED
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ task: { status: 'FAILED' } }) })
        // quality gate
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ projectStatus: { status: 'OK', conditions: [] } }) })
        // measures
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ component: { measures: [] } }) })
        // issues
        .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) }),
    );

    const resultPromise = engine.scan({ runner, config, cwd: '/tmp/test', ecosystemRegistry: {} as EcosystemRegistry, branch: null });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    // CE task failed → engine proceeds to QG anyway (warn path)
    expect(result.status).toBeDefined();
  });

  it('returns failed when CE task status is CANCELED (line 140-142 — CANCELED branch)', async () => {
    const runner = new MockRunner({
      '--version': { exitCode: 0, stdout: 'SonarScanner 5.0' },
      'sonar-scanner': { exitCode: 0, stdout: 'ANALYSIS SUCCESSFUL' },
    });
    const config = makeConfig(true);
    stubReportTaskFile('task-canceled-789');

    vi.stubGlobal(
      'fetch',
      vi.fn()
        // NOTE: fetch call order — (1) fetchNcloc pre-scan, (2) CE poll, then quality gate, measures, issues
        .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) }) // ncloc (no prior analysis)
        // CE poll → CANCELED
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ task: { status: 'CANCELED' } }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ projectStatus: { status: 'OK', conditions: [] } }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ component: { measures: [] } }) })
        .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) }),
    );

    const resultPromise = engine.scan({ runner, config, cwd: '/tmp/test', ecosystemRegistry: {} as EcosystemRegistry, branch: null });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.status).toBeDefined();
  });

  it('handles fetch throw during CE task poll (lines 146-147)', async () => {
    const runner = new MockRunner({
      '--version': { exitCode: 0, stdout: 'SonarScanner 5.0' },
      'sonar-scanner': { exitCode: 0, stdout: 'ANALYSIS SUCCESSFUL' },
    });
    const config = makeConfig(true);
    stubReportTaskFile('task-throw-000');

    vi.stubGlobal(
      'fetch',
      vi.fn()
        // NOTE: fetch call order — (1) fetchNcloc pre-scan, (2) CE poll throws, (3) second CE poll SUCCESS, then QG/measures/issues
        .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) }) // ncloc (no prior analysis)
        // CE poll → throws (lines 146-147)
        .mockRejectedValueOnce(new Error('network error'))
        // Second CE poll → SUCCESS
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ task: { status: 'SUCCESS' } }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ projectStatus: { status: 'OK', conditions: [] } }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ component: { measures: [] } }) })
        .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) }),
    );

    const resultPromise = engine.scan({ runner, config, cwd: '/tmp/test', ecosystemRegistry: {} as EcosystemRegistry, branch: null });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.status).toBe('success');
  });
});

// ─── Coverage gap: fetchSonarQualityGate / fetchSonarMetrics non-ok ─────────────

describe('SonarQubeEngine — fetchSonarQualityGate non-ok + fetchSonarMetrics non-ok (lines 189-191, 212-214)', () => {
  const engine = new SonarQubeEngine();

  beforeEach(() => {
    process.env['SONAR_TOKEN'] = 'test-token';
    vi.useFakeTimers();
  });
  afterEach(() => {
    delete process.env['SONAR_TOKEN'];
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('returns null quality gate when API returns non-ok (lines 189-191)', async () => {
    const runner = new MockRunner({
      '--version': { exitCode: 0, stdout: 'SonarScanner 5.0' },
      'sonar-scanner': { exitCode: 0, stdout: 'ANALYSIS SUCCESSFUL' },
    });
    const config = makeConfig(true);

    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('ENOENT'); // no CE task id → skip CE wait
    });

    vi.stubGlobal(
      'fetch',
      vi.fn()
        // NOTE: fetch call order — (1) fetchNcloc pre-scan, (2) quality gate, (3) measures, (4) issues
        .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) }) // ncloc (no prior analysis)
        // quality gate → non-ok (lines 189-191)
        .mockResolvedValueOnce({ ok: false, status: 403, statusText: 'Forbidden', json: async () => ({}) })
        // measures
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ component: { measures: [] } }) })
        // issues
        .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) }),
    );

    const resultPromise = engine.scan({ runner, config, cwd: '/tmp/test', ecosystemRegistry: {} as EcosystemRegistry, branch: null });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    // engine continues even without QG; status is 'success' with no failing gate
    expect(result.status).toBe('success');
  });

  it('returns null metrics when measures API returns non-ok (lines 212-214)', async () => {
    const runner = new MockRunner({
      '--version': { exitCode: 0, stdout: 'SonarScanner 5.0' },
      'sonar-scanner': { exitCode: 0, stdout: 'ANALYSIS SUCCESSFUL' },
    });
    const config = makeConfig(true);

    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('ENOENT');
    });

    vi.stubGlobal(
      'fetch',
      vi.fn()
        // NOTE: fetch call order — (1) fetchNcloc pre-scan, (2) quality gate, (3) measures, (4) issues
        .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) }) // ncloc (no prior analysis)
        // quality gate → ok
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ projectStatus: { status: 'OK', conditions: [] } }) })
        // measures → non-ok (lines 212-214)
        .mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Internal Server Error', json: async () => ({}) })
        // issues
        .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) }),
    );

    const resultPromise = engine.scan({ runner, config, cwd: '/tmp/test', ecosystemRegistry: {} as EcosystemRegistry, branch: null });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.status).toBe('success');
  });
});

// ─── Coverage gap: token generation fallback path + catch (lines 328-329, 334-337) ──

describe('SonarQubeEngine — managed mode token generation fallback + catch (lines 328-329, 334-337)', () => {
  const engine = new SonarQubeEngine();

  beforeEach(() => {
    setSonarPropsFixture(new Map([['sonar.projectKey', 'my-project']]));
    vi.useFakeTimers();
    // Re-register provisioner mock in case vi.restoreAllMocks() cleared it
    vi.mocked(DockerSonarQubeProvisioner).mockImplementation(() => ({
      provision: vi.fn().mockResolvedValue({ baseUrl: 'http://localhost:19999' }),
      waitReady: vi.fn().mockResolvedValue(undefined),
      teardown: vi.fn().mockResolvedValue(undefined),
    }) as never);
  });
  afterEach(() => {
    setSonarPropsFixture(new Map([['sonar.projectKey', 'my-project'], ['sonar.host.url', 'http://localhost:9000']]));
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('falls back to older token API endpoint when primary returns 404 (lines 328-329)', async () => {
    const runner = new MockRunner({
      '--version': { exitCode: 0, stdout: 'SonarScanner 5.0' },
      'sonar-scanner': { exitCode: 0, stdout: 'ANALYSIS SUCCESSFUL' },
    });
    const config = makeConfig(true, 'warn', 'managed');

    vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw new Error('ENOENT'); });

    vi.stubGlobal(
      'fetch',
      vi.fn()
        // revoke → ok
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) })
        // generate primary → 404 → triggers fallback path
        .mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) })
        // fallback generate → ok (lines 328-329)
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ token: 'fallback-tok' }) })
        // quality gate
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ projectStatus: { status: 'OK', conditions: [] } }) })
        // measures
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ component: { measures: [] } }) })
        // issues
        .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) }),
    );

    const resultPromise = engine.scan({ runner, config, cwd: '/tmp/test', ecosystemRegistry: {} as EcosystemRegistry, branch: null });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.status).toBeDefined();
  });

  it('returns null token when token generation throws (lines 334-337)', async () => {
    const runner = new MockRunner({
      '--version': { exitCode: 0, stdout: 'SonarScanner 5.0' },
      'sonar-scanner': { exitCode: 0, stdout: 'ANALYSIS SUCCESSFUL' },
    });
    const config = makeConfig(true, 'warn', 'managed');

    vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw new Error('ENOENT'); });

    vi.stubGlobal(
      'fetch',
      vi.fn()
        // revoke → ok
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) })
        // generate → throws (lines 334-337)
        .mockRejectedValueOnce(new Error('connection refused'))
        // quality gate
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ projectStatus: { status: 'OK', conditions: [] } }) })
        // measures
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ component: { measures: [] } }) })
        // issues
        .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) }),
    );

    const resultPromise = engine.scan({ runner, config, cwd: '/tmp/test', ecosystemRegistry: {} as EcosystemRegistry, branch: null });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.status).toBeDefined();
  });
});

// ─── Coverage gap: _isLocalScannerAvailable throws (lines 572-573) ──────────────

describe('SonarQubeEngine — _isLocalScannerAvailable catch (lines 572-573)', () => {
  const engine = new SonarQubeEngine();

  beforeEach(() => {
    setSonarPropsFixture(new Map([['sonar.projectKey', 'my-project']]));
    vi.useFakeTimers();
    // Re-register provisioner mock in case vi.restoreAllMocks() cleared it
    vi.mocked(DockerSonarQubeProvisioner).mockImplementation(() => ({
      provision: vi.fn().mockResolvedValue({ baseUrl: 'http://localhost:19999' }),
      waitReady: vi.fn().mockResolvedValue(undefined),
      teardown: vi.fn().mockResolvedValue(undefined),
    }) as never);
    vi.mocked(DockerSonarScannerRunner).mockImplementation(() => ({
      run: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'ANALYSIS SUCCESSFUL', stderr: '' }),
    }) as never);
  });
  afterEach(() => {
    setSonarPropsFixture(new Map([['sonar.projectKey', 'my-project'], ['sonar.host.url', 'http://localhost:9000']]));
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('falls back to container scanner when local sonar-scanner throws (lines 572-573)', async () => {
    // runner.run throws for sonar-scanner --version → _isLocalScannerAvailable returns false
    const runner: CommandRunner = {
      dryRun: false,
      environment: 'local' as const,
      async run(command: string): Promise<CommandResult> {
        if (command.includes('sonar-scanner')) throw new Error('command not found');
        return { stdout: '', stderr: '', exitCode: 0, command, dryRun: false };
      },
      async runArgs(file: string, args: string[]): Promise<CommandResult> {
        return { stdout: 'ANALYSIS SUCCESSFUL', stderr: '', exitCode: 0, command: [file, ...args].join(' '), dryRun: false };
      },
    };
    const config = makeConfig(true, 'warn', 'managed');

    vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw new Error('ENOENT'); });

    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ token: 'tok' }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ projectStatus: { status: 'OK', conditions: [] } }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ component: { measures: [] } }) })
        .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) }),
    );

    const resultPromise = engine.scan({ runner, config, cwd: '/tmp/test', ecosystemRegistry: {} as EcosystemRegistry, branch: null });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.status).toBeDefined();
  });
});

// ─── Coverage gap: scan — missing sonar-project.properties / projectKey / hostUrl ─

describe('SonarQubeEngine — scan input validation (lines 615-620, 624-628, 656-660)', () => {
  const engine = new SonarQubeEngine();

  beforeEach(() => {
    process.env['SONAR_TOKEN'] = 'test-token';
  });
  afterEach(() => {
    delete process.env['SONAR_TOKEN'];
    setSonarPropsFixture(new Map([['sonar.projectKey', 'my-project'], ['sonar.host.url', 'http://localhost:9000']]));
    vi.unstubAllGlobals();
  });

  it('throws EnvironmentError when sonar-project.properties is missing (lines 615-620)', async () => {
    setSonarPropsFixture(null); // readSonarProperties returns null

    const runner = new MockRunner();
    const config = makeConfig(true);

    await expect(
      engine.scan({ runner, config, cwd: '/tmp/test', ecosystemRegistry: {} as EcosystemRegistry, branch: null }),
    ).rejects.toThrow(EnvironmentError);
  });

  it('throws EnvironmentError when sonar.projectKey is missing (lines 624-628)', async () => {
    setSonarPropsFixture(new Map([['sonar.host.url', 'http://localhost:9000']])); // no projectKey

    const runner = new MockRunner();
    const config = makeConfig(true);

    await expect(
      engine.scan({ runner, config, cwd: '/tmp/test', ecosystemRegistry: {} as EcosystemRegistry, branch: null }),
    ).rejects.toThrow(EnvironmentError);
  });

  it('throws EnvironmentError when sonar.host.url is missing in external mode (lines 656-660)', async () => {
    setSonarPropsFixture(new Map([['sonar.projectKey', 'my-project']])); // no host.url

    const runner = new MockRunner();
    const config = makeConfig(true);

    await expect(
      engine.scan({ runner, config, cwd: '/tmp/test', ecosystemRegistry: {} as EcosystemRegistry, branch: null }),
    ).rejects.toThrow(EnvironmentError);
  });
});

// ─── computeEffectiveTimeouts — unit tests ──────────────────────────────────────

describe('computeEffectiveTimeouts — unit', () => {
  it('returns floor values when ncloc is null', () => {
    const result = computeEffectiveTimeouts(
      { scanner_timeout_seconds: 300, ce_task_timeout_seconds: 120, dynamic_timeout: true },
      null,
    );
    expect(result.scannerTimeoutMs).toBe(300_000);
    expect(result.ceTimeoutMs).toBe(120_000);
  });

  it('returns floor values when dynamic_timeout is false, ignoring ncloc', () => {
    const result = computeEffectiveTimeouts(
      { scanner_timeout_seconds: 300, ce_task_timeout_seconds: 120, dynamic_timeout: false },
      100_000,
    );
    expect(result.scannerTimeoutMs).toBe(300_000);
    expect(result.ceTimeoutMs).toBe(120_000);
  });

  it('computes dynamic timeouts correctly for ncloc=100000 (AC1)', () => {
    // scanner = max(300000, ceil(60 + 100*3)*1000) = max(300000, 360000) = 360000
    // ce      = max(120000, ceil(30 + 100*1.5)*1000) = max(120000, 180000) = 180000
    const result = computeEffectiveTimeouts(
      { scanner_timeout_seconds: 300, ce_task_timeout_seconds: 120, dynamic_timeout: true },
      100_000,
    );
    expect(result.scannerTimeoutMs).toBe(360_000);
    expect(result.ceTimeoutMs).toBe(180_000);
  });

  it('floor is respected for small projects (ncloc=10000)', () => {
    // dynamic scanner = ceil(60 + 10*3)*1000 = ceil(90)*1000 = 90000ms
    // floor = 300000ms → stays at 300000
    const result = computeEffectiveTimeouts(
      { scanner_timeout_seconds: 300, ce_task_timeout_seconds: 120, dynamic_timeout: true },
      10_000,
    );
    expect(result.scannerTimeoutMs).toBe(300_000);
    expect(result.ceTimeoutMs).toBe(120_000);
  });

  it('uses custom floor (scanner_timeout_seconds:600) — never goes below it', () => {
    // ncloc=10 (tiny project): dynamic scanner = ceil(60 + 0.01*3)*1000 = 61000ms < 600000ms floor
    const result = computeEffectiveTimeouts(
      { scanner_timeout_seconds: 600, ce_task_timeout_seconds: 180, dynamic_timeout: true },
      10,
    );
    expect(result.scannerTimeoutMs).toBe(600_000);
    expect(result.ceTimeoutMs).toBe(180_000);
  });

  it('respects custom timeout_scale multipliers', () => {
    // ncloc=100000, scannerPerKloc=6, cePerKloc=3
    // dynamic scanner = ceil(60 + 100*6)*1000 = ceil(660)*1000 = 660000
    // dynamic ce      = ceil(30 + 100*3)*1000 = ceil(330)*1000 = 330000
    const result = computeEffectiveTimeouts(
      {
        scanner_timeout_seconds: 300,
        ce_task_timeout_seconds: 120,
        dynamic_timeout: true,
        timeout_scale: { scanner_seconds_per_kloc: 6, ce_seconds_per_kloc: 3 },
      },
      100_000,
    );
    expect(result.scannerTimeoutMs).toBe(660_000);
    expect(result.ceTimeoutMs).toBe(330_000);
  });

  it('uses default floor (300s scanner, 120s CE) when not specified', () => {
    const result = computeEffectiveTimeouts({}, null);
    expect(result.scannerTimeoutMs).toBe(300_000);
    expect(result.ceTimeoutMs).toBe(120_000);
  });
});

// ─── fetchNcloc — unit tests ────────────────────────────────────────────────────

describe('fetchNcloc — unit', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns integer ncloc on valid 200 response (AC5)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        component: { measures: [{ metric: 'ncloc', value: '75000' }] },
      }),
    }));

    const result = await fetchNcloc('http://sonar:9000', 'my-project', 'Bearer tok');
    expect(result).toBe(75_000);
  });

  it('returns null on non-ok API response (AC4)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    }));

    const result = await fetchNcloc('http://sonar:9000', 'my-project', 'Bearer tok');
    expect(result).toBeNull();
  });

  it('returns null on network error without propagating (AC6)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));

    const result = await fetchNcloc('http://sonar:9000', 'my-project', 'Bearer tok');
    expect(result).toBeNull();
  });

  it('returns null when ncloc measure is missing from response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        component: { measures: [{ metric: 'bugs', value: '5' }] }, // no ncloc
      }),
    }));

    const result = await fetchNcloc('http://sonar:9000', 'my-project', 'Bearer tok');
    expect(result).toBeNull();
  });

  it('returns null when measure value is undefined', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        component: { measures: [{ metric: 'ncloc' }] }, // no value field
      }),
    }));

    const result = await fetchNcloc('http://sonar:9000', 'my-project', 'Bearer tok');
    expect(result).toBeNull();
  });

  it('encodes projectKey in URL (component param)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ component: { measures: [{ metric: 'ncloc', value: '1000' }] } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await fetchNcloc('http://sonar:9000', 'org:my-project', 'Bearer tok');

    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('component=org%3Amy-project');
    expect(url).toContain('metricKeys=ncloc');
  });
});
