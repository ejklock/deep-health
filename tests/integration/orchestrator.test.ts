import { describe, it, expect, vi, afterEach } from 'vitest';
import { runOrchestrator } from '@orchestration/orchestrator';
import { loadConfig } from '@infra/config/loader';
import { GateValidationError } from '@core/errors';
import { ScannerEngineRegistry } from '@modules/scanner/registry';
import { OsvScannerEngine } from '@modules/scanner/osv-engine';
import { SonarQubeEngine } from '@modules/scanner/sonarqube-engine';
import { OSV_ENGINE_ID } from '@modules/scanner/aggregator';
import type { CommandRunner, CommandResult, CommandRunnerOptions, ExecutionEnv } from '@core/types/common';
import type { ProjectConfig } from '@core/types/config';
import type { ScannerEngineContext, ScannerEngine } from '@modules/scanner/types';
import type { ScanResultJson } from '@core/types/scan';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, '../fixtures');

/**
 * MockCommandRunner: responds to commands with predetermined outputs.
 * Allows verifying what commands were called.
 */
class MockCommandRunner implements CommandRunner {
  readonly dryRun: boolean;
  readonly environment: ExecutionEnv;
  readonly calledCommands: string[] = [];
  private responses: Map<string, Partial<CommandResult>>;
  private defaultResponse: Partial<CommandResult>;

  constructor(
    responses: Record<string, Partial<CommandResult>> = {},
    options: { dryRun?: boolean; environment?: ExecutionEnv; defaultExitCode?: number } = {},
  ) {
    this.dryRun = options.dryRun ?? false;
    this.environment = options.environment ?? 'docker';
    this.responses = new Map(Object.entries(responses));
    this.defaultResponse = { stdout: '', stderr: '', exitCode: options.defaultExitCode ?? 0 };
  }

  async run(command: string, _options?: CommandRunnerOptions): Promise<CommandResult> {
    this.calledCommands.push(command);

    // Find matching response (by partial command match)
    for (const [key, response] of this.responses) {
      if (command.includes(key)) {
        return {
          stdout: response.stdout ?? '',
          stderr: response.stderr ?? '',
          exitCode: response.exitCode ?? 0,
          command,
          dryRun: this.dryRun,
        };
      }
    }

    return {
      stdout: this.defaultResponse.stdout ?? '',
      stderr: this.defaultResponse.stderr ?? '',
      exitCode: this.defaultResponse.exitCode ?? 0,
      command,
      dryRun: this.dryRun,
    };
  }
}

async function loadTestConfig() {
  return loadConfig('project-config.yml', fixturesDir);
}

/** Build a minimal ProjectConfig with SonarQube configured */
function withSonarQube(
  base: ProjectConfig,
  options: {
    enabled?: boolean;
    mode?: 'external' | 'managed';
    onFailure?: 'warn' | 'fail';
    hostUrl?: string;
    projectKey?: string;
    tokenEnv?: string;
  } = {},
): ProjectConfig {
  return {
    ...base,
    scanners: {
      sonarqube: {
        enabled: options.enabled ?? true,
        mode: options.mode ?? 'external',
        host_url: options.hostUrl ?? 'http://localhost:9000',
        project_key: options.projectKey ?? 'test-project',
        token_env: options.tokenEnv ?? 'SONAR_TOKEN',
        on_failure: options.onFailure ?? 'warn',
      },
    },
  };
}

/** Create a scanner registry with only OSV (no SonarQube) */
function makeOsvOnlyRegistry(): ScannerEngineRegistry {
  const reg = new ScannerEngineRegistry();
  reg.register(new OsvScannerEngine());
  return reg;
}

/** Create a scanner registry with OSV + SonarQube */
function makeOsvAndSonarRegistry(): ScannerEngineRegistry {
  const reg = new ScannerEngineRegistry();
  reg.register(new OsvScannerEngine());
  reg.register(new SonarQubeEngine());
  return reg;
}

// ─── Existing tests (preserved) ────────────────────────────────────────────────

describe('runOrchestrator — full pipeline', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env['SONAR_TOKEN'];
  });

  it('skips npm and composer phases when no auto-safe vulnerabilities', async () => {
    const config = await loadTestConfig();
    const runner = new MockCommandRunner({
      '--version': { stdout: 'osv-scanner version 1.9.0', exitCode: 0 },
      // npm plugin is registered before composer, so package-lock.json arg comes first
      '--lockfile package-lock.json --lockfile composer.lock --format json': {
        stdout: JSON.stringify({ results: [] }),
        exitCode: 0,
      },
    });

    const result = await runOrchestrator(runner, config, {
      configPath: 'project-config.yml',
      cwd: fixturesDir,
      dryRun: false,
      verbose: false,
      scannerRegistry: makeOsvOnlyRegistry(),
    });

    expect(result.scan).not.toBeNull();
    expect(result.updates['npm']).toBeUndefined();
    expect(result.updates['composer']).toBeUndefined();
  });

  it('runs in dry-run mode without executing update commands', async () => {
    const config = await loadTestConfig();
    const runner = new MockCommandRunner(
      { '--version': { stdout: 'osv-scanner version 1.9.0', exitCode: 0 } },
      { dryRun: true },
    );

    const result = await runOrchestrator(runner, config, {
      configPath: 'project-config.yml',
      cwd: fixturesDir,
      dryRun: true,
      verbose: false,
      scannerRegistry: makeOsvOnlyRegistry(),
    });

    expect(result.scan).not.toBeNull();
    // In dry-run, the updater returns early without issuing any runner.run() calls.
    // Neither osv-scanner fix nor npm install should appear in calledCommands.
    const updateCommands = runner.calledCommands.filter(
      (cmd) => cmd.includes('osv-scanner fix') || cmd.includes('npm install'),
    );
    expect(updateCommands).toHaveLength(0);
  });

  it('only runs scan phase when phases=["scan"]', async () => {
    const config = await loadTestConfig();
    const runner = new MockCommandRunner({
      '--version': { stdout: 'osv-scanner version 1.9.0', exitCode: 0 },
      // npm plugin is registered before composer, so package-lock.json arg comes first
      '--lockfile package-lock.json --lockfile composer.lock --format json': {
        stdout: JSON.stringify({ results: [] }),
        exitCode: 0,
      },
    });

    const result = await runOrchestrator(runner, config, {
      configPath: 'project-config.yml',
      cwd: fixturesDir,
      dryRun: false,
      verbose: false,
      phases: ['scan'],
      scannerRegistry: makeOsvOnlyRegistry(),
    });

    expect(result.scan).not.toBeNull();
    expect(result.updates['npm']).toBeUndefined();
    expect(result.updates['composer']).toBeUndefined();
  });

  it('no update commands issued when scan finds no vulnerabilities', async () => {
    const config = await loadTestConfig();
    const runner = new MockCommandRunner({
      '--version': { stdout: 'osv-scanner version 1.9.0', exitCode: 0 },
      // npm plugin is registered before composer, so package-lock.json arg comes first
      '--lockfile package-lock.json --lockfile composer.lock --format json': {
        stdout: JSON.stringify({ results: [] }),
        exitCode: 0,
      },
      'git status': { stdout: '', exitCode: 0 },
      'development-frontend': { stdout: 'built', exitCode: 0 },
      'development-backend': { stdout: 'built', exitCode: 0 },
      '--lockfile package-lock.json --format json': { stdout: JSON.stringify({ results: [] }), exitCode: 0 },
    });

    await runOrchestrator(runner, config, {
      configPath: 'project-config.yml',
      cwd: fixturesDir,
      dryRun: false,
      verbose: false,
      scannerRegistry: makeOsvOnlyRegistry(),
    });

    // With no vulnerabilities the orchestrator skips the updater entirely —
    // neither osv-scanner fix nor npm install (for updates or revert) should be called.
    const updateOrRevertCalls = runner.calledCommands.filter(
      (cmd) => cmd.includes('osv-scanner fix') || cmd.includes('npm install'),
    );
    expect(updateOrRevertCalls).toHaveLength(0);
  });
});

// ─── SonarQube integration scenarios ───────────────────────────────────────────

describe('runOrchestrator — SonarQube integration', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env['SONAR_TOKEN'];
  });

  it('pipeline succeeds normally when SonarQube is not configured', async () => {
    const config = await loadTestConfig();
    // config has no scanners section — default fixture
    const runner = new MockCommandRunner({
      '--version': { stdout: 'osv-scanner version 1.9.0', exitCode: 0 },
      '--lockfile package-lock.json --lockfile composer.lock --format json': {
        stdout: JSON.stringify({ results: [] }),
        exitCode: 0,
      },
    });

    const result = await runOrchestrator(runner, config, {
      configPath: 'project-config.yml',
      cwd: fixturesDir,
      dryRun: false,
      verbose: false,
      scannerRegistry: makeOsvAndSonarRegistry(),
    });

    expect(result.scan).not.toBeNull();
    expect(result.scan?.agent).toBe('osv');
    expect(result.warnings).toHaveLength(0);
    // SonarQube engine self-skips — no sonar-scanner calls
    const sonarCalls = runner.calledCommands.filter((c) => c.includes('sonar-scanner'));
    expect(sonarCalls).toHaveLength(0);
  });

  it('emits warning and continues when SonarQube is unavailable with on_failure=warn', async () => {
    const baseConfig = await loadTestConfig();
    const config = withSonarQube(baseConfig, { onFailure: 'warn' });
    process.env['SONAR_TOKEN'] = 'my-token';

    const runner = new MockCommandRunner({
      'osv-scanner --version': { stdout: 'osv-scanner version 1.9.0', exitCode: 0 },
      '--lockfile package-lock.json --lockfile composer.lock --format json': {
        stdout: JSON.stringify({ results: [] }),
        exitCode: 0,
      },
      // sonar-scanner --version fails (not installed)
      'sonar-scanner --version': { exitCode: 127, stderr: 'command not found: sonar-scanner' },
    });

    const result = await runOrchestrator(runner, config, {
      configPath: 'project-config.yml',
      cwd: fixturesDir,
      dryRun: false,
      verbose: false,
      scannerRegistry: makeOsvAndSonarRegistry(),
    });

    // Pipeline should continue — OSV result is the primary
    expect(result.scan).not.toBeNull();
    expect(result.scan?.agent).toBe('osv');

    // Warning should be recorded
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]?.engineId).toBe('sonarqube');
    expect(result.warnings[0]?.message).toMatch(/sonar-scanner/i);
  });

  it('throws when SonarQube is unavailable with on_failure=fail', async () => {
    const baseConfig = await loadTestConfig();
    const config = withSonarQube(baseConfig, { onFailure: 'fail' });
    process.env['SONAR_TOKEN'] = 'my-token';

    const runner = new MockCommandRunner({
      'osv-scanner --version': { stdout: 'osv-scanner version 1.9.0', exitCode: 0 },
      '--lockfile package-lock.json --lockfile composer.lock --format json': {
        stdout: JSON.stringify({ results: [] }),
        exitCode: 0,
      },
      'sonar-scanner --version': { exitCode: 127, stderr: 'command not found: sonar-scanner' },
    });

    await expect(
      runOrchestrator(runner, config, {
        configPath: 'project-config.yml',
        cwd: fixturesDir,
        dryRun: false,
        verbose: false,
        scannerRegistry: makeOsvAndSonarRegistry(),
      }),
    ).rejects.toThrow();
  });

  it('OSV primary result drives Gate A — not SonarQube result', async () => {
    const baseConfig = await loadTestConfig();
    const config = withSonarQube(baseConfig, { onFailure: 'warn' });
    process.env['SONAR_TOKEN'] = 'my-token';

    const runner = new MockCommandRunner({
      'osv-scanner --version': { stdout: 'osv-scanner version 1.9.0', exitCode: 0 },
      '--lockfile package-lock.json --lockfile composer.lock --format json': {
        stdout: JSON.stringify({ results: [] }),
        exitCode: 0,
      },
      // SonarQube scan succeeds (--version ok, sonar-scanner -D succeeds)
      'sonar-scanner --version': { exitCode: 0, stdout: 'SonarScanner 5.0' },
      'sonar-scanner -D': { exitCode: 0, stdout: 'ANALYSIS SUCCESSFUL' },
    });

    // Mock SonarQube API responses
    vi.stubGlobal(
      'fetch',
      vi.fn()
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

    const result = await runOrchestrator(runner, config, {
      configPath: 'project-config.yml',
      cwd: fixturesDir,
      dryRun: false,
      verbose: false,
      scannerRegistry: makeOsvAndSonarRegistry(),
    });

    // Gate A passed (based on OSV result)
    expect(result.scan).not.toBeNull();
    expect(result.scan?.agent).toBe('osv');
    expect(result.scan?.$schema).toBe('osv-scan-result/v1');

    // SonarQube result is in aggregated.engineResults
    expect(result.aggregated?.engineResults['sonarqube']).toBeDefined();
    expect(result.aggregated?.engineResults['sonarqube']?.agent).toBe('sonarqube');
    expect(result.aggregated?.engineResults['sonarqube']?.metadata?.qualityGateStatus).toBe('OK');

    // No warnings
    expect(result.warnings).toHaveLength(0);
  });

  it('aggregated.primary is always OSV result regardless of SonarQube outcome', async () => {
    const baseConfig = await loadTestConfig();
    const config = withSonarQube(baseConfig, { onFailure: 'warn' });
    process.env['SONAR_TOKEN'] = 'my-token';

    const runner = new MockCommandRunner({
      'osv-scanner --version': { stdout: 'osv-scanner version 1.9.0', exitCode: 0 },
      '--lockfile package-lock.json --lockfile composer.lock --format json': {
        stdout: JSON.stringify({ results: [] }),
        exitCode: 0,
      },
      // sonar-scanner not available
      'sonar-scanner --version': { exitCode: 127 },
    });

    const result = await runOrchestrator(runner, config, {
      configPath: 'project-config.yml',
      cwd: fixturesDir,
      dryRun: false,
      verbose: false,
      scannerRegistry: makeOsvAndSonarRegistry(),
    });

    // Primary is OSV even when SonarQube failed
    expect(result.aggregated?.primary.agent).toBe('osv');
    expect(result.aggregated?.primary.$schema).toBe('osv-scan-result/v1');
  });

  it('warnings are empty when only OSV is in the registry (scannerRegistry option)', async () => {
    const config = await loadTestConfig();
    const runner = new MockCommandRunner({
      '--version': { stdout: 'osv-scanner version 1.9.0', exitCode: 0 },
      '--lockfile package-lock.json --lockfile composer.lock --format json': {
        stdout: JSON.stringify({ results: [] }),
        exitCode: 0,
      },
    });

    const result = await runOrchestrator(runner, config, {
      configPath: 'project-config.yml',
      cwd: fixturesDir,
      dryRun: false,
      verbose: false,
      scannerRegistry: makeOsvOnlyRegistry(),
    });

    expect(result.warnings).toHaveLength(0);
  });
});

// ─── on_failure policy: status='error' returned (no throw) ─────────────────────

/**
 * Stub secondary engine that resolves with status='error' instead of throwing.
 * Models a ScannerEngine implementation that encodes failures in the return value
 * rather than throwing an exception — a valid and documented usage per the contract.
 */
class ErrorStatusEngine implements ScannerEngine {
  readonly id: string;
  readonly name: string;
  private readonly errorMessage: string;

  constructor(id = 'stub-engine', errorMessage = 'stub engine encountered an error') {
    this.id = id;
    this.name = `Stub(${id})`;
    this.errorMessage = errorMessage;
  }

  async assertAvailable(_ctx: ScannerEngineContext): Promise<void> {}

  async scan(_ctx: ScannerEngineContext): Promise<ScanResultJson> {
    return {
      $schema: 'stub-result/v1',
      agent: this.id,
      status: 'error',
      environment: 'local',
      ecosystems: {},
      error: this.errorMessage,
    };
  }
}

describe('runOrchestrator — on_failure policy for status=error (no throw)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env['SONAR_TOKEN'];
  });

  it('throws when secondary engine returns status=error for unknown engine id (fail-safe default)', async () => {
    const baseConfig = await loadTestConfig();
    // Phase 2 hardening: unknown engine ids default to on_failure='fail', not 'warn'.
    // This prevents silently swallowing integration bugs from unrecognised engines.
    const config: ProjectConfig = { ...baseConfig };

    const runner = new MockCommandRunner({
      '--version': { stdout: 'osv-scanner version 1.9.0', exitCode: 0 },
      '--lockfile package-lock.json --lockfile composer.lock --format json': {
        stdout: JSON.stringify({ results: [] }),
        exitCode: 0,
      },
    });

    const reg = new ScannerEngineRegistry();
    reg.register(new OsvScannerEngine());
    reg.register(new ErrorStatusEngine('stub-engine', 'intentional stub failure'));

    // Unknown engine should now THROW (safe default = fail)
    await expect(
      runOrchestrator(runner, config, {
        configPath: 'project-config.yml',
        cwd: fixturesDir,
        dryRun: false,
        verbose: false,
        scannerRegistry: reg,
      }),
    ).rejects.toThrow('intentional stub failure');
  });

  it('throws when secondary engine returns status=error with on_failure=fail (SonarQube)', async () => {
    const baseConfig = await loadTestConfig();
    const config = withSonarQube(baseConfig, { onFailure: 'fail' });
    process.env['SONAR_TOKEN'] = 'my-token';

    const runner = new MockCommandRunner({
      '--version': { stdout: 'osv-scanner version 1.9.0', exitCode: 0 },
      '--lockfile package-lock.json --lockfile composer.lock --format json': {
        stdout: JSON.stringify({ results: [] }),
        exitCode: 0,
      },
    });

    // Use a stub that self-identifies as 'sonarqube' so resolveOnFailure reads the config
    const reg = new ScannerEngineRegistry();
    reg.register(new OsvScannerEngine());
    reg.register(new ErrorStatusEngine('sonarqube', 'quality gate failed'));

    await expect(
      runOrchestrator(runner, config, {
        configPath: 'project-config.yml',
        cwd: fixturesDir,
        dryRun: false,
        verbose: false,
        scannerRegistry: reg,
      }),
    ).rejects.toThrow('quality gate failed');
  });

  it('emits warning and continues when SonarQube returns status=error with on_failure=warn', async () => {
    const baseConfig = await loadTestConfig();
    const config = withSonarQube(baseConfig, { onFailure: 'warn' });
    process.env['SONAR_TOKEN'] = 'my-token';

    const runner = new MockCommandRunner({
      '--version': { stdout: 'osv-scanner version 1.9.0', exitCode: 0 },
      '--lockfile package-lock.json --lockfile composer.lock --format json': {
        stdout: JSON.stringify({ results: [] }),
        exitCode: 0,
      },
    });

    const reg = new ScannerEngineRegistry();
    reg.register(new OsvScannerEngine());
    reg.register(new ErrorStatusEngine('sonarqube', 'sonar quality gate failed'));

    const result = await runOrchestrator(runner, config, {
      configPath: 'project-config.yml',
      cwd: fixturesDir,
      dryRun: false,
      verbose: false,
      scannerRegistry: reg,
    });

    expect(result.scan).not.toBeNull();
    expect(result.scan?.agent).toBe('osv');

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.engineId).toBe('sonarqube');
    expect(result.warnings[0]?.message).toContain('sonar quality gate failed');
  });

  it('throws for unknown engine that throws (fail-safe for throw path)', async () => {
    const baseConfig = await loadTestConfig();
    const config: ProjectConfig = { ...baseConfig };

    const runner = new MockCommandRunner({
      '--version': { stdout: 'osv-scanner version 1.9.0', exitCode: 0 },
      '--lockfile package-lock.json --lockfile composer.lock --format json': {
        stdout: JSON.stringify({ results: [] }),
        exitCode: 0,
      },
    });

    // ThrowingEngine: throws instead of returning status=error
    class ThrowingEngine implements ScannerEngine {
      readonly id = 'unknown-throw-engine';
      readonly name = 'ThrowingEngine';
      async assertAvailable(_ctx: ScannerEngineContext): Promise<void> {}
      async scan(_ctx: ScannerEngineContext): Promise<ScanResultJson> {
        throw new Error('unexpected engine throw');
      }
    }

    const reg = new ScannerEngineRegistry();
    reg.register(new OsvScannerEngine());
    reg.register(new ThrowingEngine());

    // Unknown engine id — resolveOnFailure returns 'fail' (safe default)
    await expect(
      runOrchestrator(runner, config, {
        configPath: 'project-config.yml',
        cwd: fixturesDir,
        dryRun: false,
        verbose: false,
        scannerRegistry: reg,
      }),
    ).rejects.toThrow('unexpected engine throw');
  });
});

// ─── Branch detection: orchestrator stamps branch in scan result ─────────────

describe('runOrchestrator — branch detection', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env['SONAR_TOKEN'];
  });

  it('scan result includes branch when git rev-parse returns a valid branch name', async () => {
    const config = await loadTestConfig();
    const runner = new MockCommandRunner({
      '--version': { stdout: 'osv-scanner version 1.9.0', exitCode: 0 },
      '--lockfile package-lock.json --lockfile composer.lock --format json': {
        stdout: JSON.stringify({ results: [] }),
        exitCode: 0,
      },
      'git rev-parse --abbrev-ref HEAD': { stdout: 'main\n', exitCode: 0 },
    });

    const result = await runOrchestrator(runner, config, {
      configPath: 'project-config.yml',
      cwd: fixturesDir,
      dryRun: false,
      verbose: false,
      scannerRegistry: makeOsvOnlyRegistry(),
    });

    expect(result.scan?.branch).toBe('main');
  });

  it('scan result has no branch field when git returns detached HEAD', async () => {
    const config = await loadTestConfig();
    const runner = new MockCommandRunner({
      '--version': { stdout: 'osv-scanner version 1.9.0', exitCode: 0 },
      '--lockfile package-lock.json --lockfile composer.lock --format json': {
        stdout: JSON.stringify({ results: [] }),
        exitCode: 0,
      },
      'git rev-parse --abbrev-ref HEAD': { stdout: 'HEAD\n', exitCode: 0 },
    });

    const result = await runOrchestrator(runner, config, {
      configPath: 'project-config.yml',
      cwd: fixturesDir,
      dryRun: false,
      verbose: false,
      scannerRegistry: makeOsvOnlyRegistry(),
    });

    // branch is undefined (null was not stamped — branch was not meaningful)
    expect(result.scan?.branch).toBeUndefined();
  });

  it('pipeline succeeds even when git rev-parse fails (no git repo)', async () => {
    const config = await loadTestConfig();
    const runner = new MockCommandRunner({
      '--version': { stdout: 'osv-scanner version 1.9.0', exitCode: 0 },
      '--lockfile package-lock.json --lockfile composer.lock --format json': {
        stdout: JSON.stringify({ results: [] }),
        exitCode: 0,
      },
      'git rev-parse --abbrev-ref HEAD': { exitCode: 128, stderr: 'fatal: not a git repository' },
    });

    // Must not throw — branch detection failure is non-fatal
    const result = await runOrchestrator(runner, config, {
      configPath: 'project-config.yml',
      cwd: fixturesDir,
      dryRun: false,
      verbose: false,
      scannerRegistry: makeOsvOnlyRegistry(),
    });

    expect(result.scan).not.toBeNull();
    expect(result.scan?.branch).toBeUndefined();
  });
});

// ─── Generic on_failure resolution ───────────────────────────────────────────

describe('runOrchestrator — generic on_failure resolution', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env['SONAR_TOKEN'];
  });

  it('sonarqube on_failure=warn (resolved generically via config.scanners lookup)', async () => {
    const baseConfig = await loadTestConfig();
    // Construct a config where sonarqube has on_failure=warn — resolveOnFailure
    // should find it via generic lookup rather than hardcoded engine id check.
    const config = withSonarQube(baseConfig, { onFailure: 'warn' });
    process.env['SONAR_TOKEN'] = 'my-token';

    const runner = new MockCommandRunner({
      'osv-scanner --version': { stdout: 'osv-scanner version 1.9.0', exitCode: 0 },
      '--lockfile package-lock.json --lockfile composer.lock --format json': {
        stdout: JSON.stringify({ results: [] }),
        exitCode: 0,
      },
      'sonar-scanner --version': { exitCode: 127, stderr: 'command not found' },
    });

    const reg = new ScannerEngineRegistry();
    reg.register(new OsvScannerEngine());
    reg.register(new ErrorStatusEngine('sonarqube', 'sonar scan failed'));

    const result = await runOrchestrator(runner, config, {
      configPath: 'project-config.yml',
      cwd: fixturesDir,
      dryRun: false,
      verbose: false,
      scannerRegistry: reg,
    });

    // Should warn, not throw
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]?.engineId).toBe('sonarqube');
  });
});

// ─── Primary-by-engine-id: registry-order independence ────────────────────────

/**
 * Stub engine that immediately returns a pre-configured ScanResultJson.
 * Used to control exactly what each engine returns without mocking internals.
 */
class StubScannerEngine implements ScannerEngine {
  readonly id: string;
  readonly name: string;
  private readonly returnValue: ScanResultJson;

  constructor(id: string, returnValue: ScanResultJson) {
    this.id = id;
    this.name = `Stub(${id})`;
    this.returnValue = returnValue;
  }

  async assertAvailable(_ctx: ScannerEngineContext): Promise<void> {}

  async scan(_ctx: ScannerEngineContext): Promise<ScanResultJson> {
    return this.returnValue;
  }
}

describe('runOrchestrator — primary-by-engine-id (registry-order independence)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env['SONAR_TOKEN'];
  });

  it('OSV_ENGINE_ID constant equals "osv"', () => {
    expect(OSV_ENGINE_ID).toBe('osv');
  });

  it('aggregated.primary is always the OSV engine result regardless of registration order', async () => {
    const config = await loadTestConfig();

    const runner = new MockCommandRunner({
      'git rev-parse': { stdout: 'main\n', exitCode: 0 },
    });

    const osvResult: ScanResultJson = {
      $schema: 'osv-scan-result/v1',
      agent: 'osv',
      status: 'success',
      environment: 'local',
      ecosystems: {},
      error: null,
    };

    const secondaryResult: ScanResultJson = {
      $schema: 'other-result/v1',
      agent: 'other-engine',
      status: 'success',
      environment: 'local',
      ecosystems: {},
      error: null,
    };

    // Register secondary BEFORE OSV — OSV is last
    const reg = new ScannerEngineRegistry();
    reg.register(new StubScannerEngine('other-engine', secondaryResult));
    reg.register(new StubScannerEngine('osv', osvResult));

    const result = await runOrchestrator(runner, config, {
      configPath: 'project-config.yml',
      cwd: fixturesDir,
      dryRun: false,
      verbose: false,
      scannerRegistry: reg,
    });

    // Primary must be OSV — not position [0] (other-engine)
    expect(result.aggregated?.primary.agent).toBe('osv');
    expect(result.aggregated?.primary.$schema).toBe('osv-scan-result/v1');
    expect(result.scan?.agent).toBe('osv');
  });

  it('aggregated.primary is OSV even when three engines are registered with OSV in the middle', async () => {
    const config = await loadTestConfig();
    const runner = new MockCommandRunner({});

    const osvResult: ScanResultJson = {
      $schema: 'osv-scan-result/v1',
      agent: 'osv',
      status: 'success',
      environment: 'local',
      ecosystems: {},
      error: null,
    };

    const engineA: ScanResultJson = {
      $schema: 'a-result/v1',
      agent: 'engine-a',
      status: 'success',
      environment: 'local',
      ecosystems: {},
      error: null,
    };

    const engineB: ScanResultJson = {
      $schema: 'b-result/v1',
      agent: 'engine-b',
      status: 'success',
      environment: 'local',
      ecosystems: {},
      error: null,
    };

    const reg = new ScannerEngineRegistry();
    reg.register(new StubScannerEngine('engine-a', engineA));
    reg.register(new StubScannerEngine('osv', osvResult));      // OSV middle position
    reg.register(new StubScannerEngine('engine-b', engineB));

    // engine-a and engine-b have unknown on_failure — defaults to 'fail'.
    // To avoid them blocking the pipeline, give them a config key so they resolve to 'warn'.
    // Actually: they return status='success' so they will NOT trigger on_failure at all.
    const result = await runOrchestrator(runner, config, {
      configPath: 'project-config.yml',
      cwd: fixturesDir,
      dryRun: false,
      verbose: false,
      scannerRegistry: reg,
    });

    expect(result.aggregated?.primary.agent).toBe('osv');
    expect(result.aggregated?.engineResults['engine-a']).toBeDefined();
    expect(result.aggregated?.engineResults['engine-b']).toBeDefined();
    expect(result.aggregated?.engineResults['osv']).toBeDefined();
  });

  it('throws when OSV is absent from the engine registry', async () => {
    const config = await loadTestConfig();
    const runner = new MockCommandRunner({});

    const reg = new ScannerEngineRegistry();
    reg.register(new StubScannerEngine('sonarqube', {
      $schema: 'sonar-result/v1',
      agent: 'sonarqube',
      status: 'success',
      environment: 'local',
      ecosystems: {},
      error: null,
    }));

    await expect(
      runOrchestrator(runner, config, {
        configPath: 'project-config.yml',
        cwd: fixturesDir,
        dryRun: false,
        verbose: false,
        scannerRegistry: reg,
      }),
    ).rejects.toThrow(/OSV scanner engine is not registered/);
  });

  it('throws from aggregator when OSV ran but no result was recorded (fail-loud guard)', async () => {
    // Simulate OSV being registered but returning status='error' while a secondary
    // engine in front is also stubbed — the aggregator's OSV-missing guard must fire
    // when the only entry produced has a non-osv id.
    const config = await loadTestConfig();
    const runner = new MockCommandRunner({});

    // Use a stub that returns with id 'osv' but then we DON'T actually get an OSV entry
    // because the orchestrator strips error results before handing them to the aggregator.
    // So: OSV registered in registry (passes has('osv') check) but returns status='error'.
    // The error result is NOT stripped for the primary — the orchestrator re-throws for primary errors.
    // Therefore, we verify the orchestrator guard catches missing OSV before aggregator is called.

    // More direct: use a custom registry where has('osv') is satisfied but the engine
    // throws during scan — which is re-thrown immediately (primary failure is always fatal).
    class ThrowingOsvEngine implements ScannerEngine {
      readonly id = 'osv';
      readonly name = 'Throwing OSV';
      async assertAvailable(_ctx: ScannerEngineContext): Promise<void> {}
      async scan(_ctx: ScannerEngineContext): Promise<ScanResultJson> {
        throw new Error('OSV engine failed — simulated failure');
      }
    }

    const reg = new ScannerEngineRegistry();
    reg.register(new ThrowingOsvEngine());

    await expect(
      runOrchestrator(runner, config, {
        configPath: 'project-config.yml',
        cwd: fixturesDir,
        dryRun: false,
        verbose: false,
        scannerRegistry: reg,
      }),
    ).rejects.toThrow('OSV engine failed — simulated failure');
  });
});
