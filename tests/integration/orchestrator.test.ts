import { describe, it, expect, vi, afterEach } from 'vitest';
import { runOrchestrator } from '../../src/phases/orchestrator.js';
import { loadConfig } from '../../src/config/loader.js';
import { GateValidationError } from '../../src/utils/errors.js';
import { ScannerEngineRegistry } from '../../src/scanner/registry.js';
import { OsvScannerEngine } from '../../src/scanner/osv-engine.js';
import { SonarQubeEngine } from '../../src/scanner/sonarqube-engine.js';
import type { CommandRunner, CommandResult, CommandRunnerOptions, ExecutionEnv } from '../../src/types/common.js';
import type { ProjectConfig } from '../../src/types/config.js';
import type { ScannerEngineContext, ScannerEngine } from '../../src/scanner/types.js';
import type { ScanResultJson } from '../../src/types/scan.js';
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
    // In dry-run, scan is executed but returns empty results
    // No update phases should have caused real side effects
    const updateCommands = runner.calledCommands.filter(
      (cmd) => cmd.includes('npm update') || cmd.includes('composer update'),
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

  it('revert not called on successful npm update', async () => {
    const config = await loadTestConfig();
    const runner = new MockCommandRunner({
      '--version': { stdout: 'osv-scanner version 1.9.0', exitCode: 0 },
      // npm plugin is registered before composer, so package-lock.json arg comes first
      '--lockfile package-lock.json --lockfile composer.lock --format json': {
        stdout: JSON.stringify({ results: [] }),
        exitCode: 0,
      },
      'git status': { stdout: '', exitCode: 0 },
      'npm update': { stdout: 'updated', exitCode: 0 },
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

    const revertCalls = runner.calledCommands.filter((cmd) => cmd.includes('git checkout'));
    expect(revertCalls).toHaveLength(0);
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
    expect(result.scan?.agent).toBe('osv-scanner');
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
    expect(result.scan?.agent).toBe('osv-scanner');

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
    expect(result.scan?.agent).toBe('osv-scanner');
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
    expect(result.aggregated?.primary.agent).toBe('osv-scanner');
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

  it('emits warning and continues when secondary engine returns status=error with on_failure=warn', async () => {
    const baseConfig = await loadTestConfig();
    // Use a custom config with a stub engine id — resolveOnFailure defaults to warn for unknown ids
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

    const result = await runOrchestrator(runner, config, {
      configPath: 'project-config.yml',
      cwd: fixturesDir,
      dryRun: false,
      verbose: false,
      scannerRegistry: reg,
    });

    // Pipeline should continue — OSV result is the primary
    expect(result.scan).not.toBeNull();
    expect(result.scan?.agent).toBe('osv-scanner');

    // Warning recorded for the errored secondary engine
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.engineId).toBe('stub-engine');
    expect(result.warnings[0]?.message).toContain('intentional stub failure');

    // Errored engine result should NOT appear in aggregated.engineResults
    expect(result.aggregated?.engineResults['stub-engine']).toBeUndefined();
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
    expect(result.scan?.agent).toBe('osv-scanner');

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.engineId).toBe('sonarqube');
    expect(result.warnings[0]?.message).toContain('sonar quality gate failed');
  });
});
