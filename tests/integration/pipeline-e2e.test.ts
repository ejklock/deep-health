/**
 * Pipeline E2E integration tests.
 *
 * Exercises the full orchestrator pipeline against fixture projects with
 * mocked CommandRunner and mocked Docker/ecosystem runtimes — no Docker required.
 *
 * Scenarios:
 *   - npm project with auto_safe vuln produces a success result
 *   - composer project with breaking vuln reports breaking classification
 *   - clean project (no vulns) exits cleanly with no updates
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { runOrchestrator } from '@orchestration/orchestrator';
import { ScannerEngineRegistry } from '@modules/scanner/registry';
import { OsvScannerEngine } from '@modules/scanner/osv-engine';
import type { CommandRunner, CommandResult, CommandRunnerOptions, ExecutionEnv } from '@core/types/common';
import type { ProjectConfig } from '@core/types/config';
import type { ScanResultJson } from '@core/types/scan';
import type { ScannerEngineContext, ScannerEngine } from '@modules/scanner/types';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// ─── Mock applyOsvFixViaStaging so tests don't need Docker ───────────────────

vi.mock('@orchestration/osv-fix-applier.js', () => ({
  applyOsvFixViaStaging: vi.fn().mockResolvedValue({
    applied: false,
    packagesUpdated: [],
    backups: new Map([
      ['package.json', '{"name":"test"}'],
      ['package-lock.json', '{"lockfileVersion":3}'],
    ]),
    rawFixStdout: '',
    rawFixStderr: '',
  }),
}));

// ─── Mock ecosystem runtime — pass through to MockCommandRunner ───────────────

vi.mock('@infra/ecosystem-runtime', async () => {
  const actual = await vi.importActual<typeof import('@infra/ecosystem-runtime')>(
    '@infra/ecosystem-runtime',
  );
  return {
    ...actual,
    resolveEcosystemRuntime: vi.fn(
      async (_plugin: unknown, hostRunner: unknown) => hostRunner,
    ),
  };
});

// ─── Fixtures / helpers ───────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, '../fixtures');

/**
 * MockCommandRunner: responds to commands with predetermined outputs.
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

  async runArgs(file: string, args: string[], _options?: CommandRunnerOptions): Promise<CommandResult> {
    return this.run([file, ...args].join(' '), _options);
  }
}

/** Stub engine that returns a pre-configured ScanResultJson. */
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

function makeOsvOnlyRegistry(): ScannerEngineRegistry {
  const reg = new ScannerEngineRegistry();
  reg.register(new OsvScannerEngine());
  return reg;
}

/**
 * Minimal ProjectConfig for the sample-npm-project fixture.
 * No docker; no composer; just npm with a simple build validation.
 */
function makeNpmOnlyConfig(): ProjectConfig {
  return {
    project: { name: 'sample-npm-project', client: 'Test' },
    ecosystems: [
      {
        id: 'npm',
        fixer: 'npm-audit',
        validationCommands: [{ name: 'build', command: 'npm run build' }],
        advisors: [{ name: 'audit', command: 'npm audit' }],
      },
    ],
    protected_packages: {},
    safe_update_policy: {
      allow_patch_and_minor_within_constraints: true,
      require_authorization_for_constraint_change: true,
    },
    conflict_resolution: 'stop_and_ask',
    scanners: { osv: { runner: 'local' } },
  } as unknown as ProjectConfig;
}

/**
 * Minimal ProjectConfig for the sample-composer-project fixture.
 */
function makeComposerOnlyConfig(): ProjectConfig {
  return {
    project: { name: 'sample-composer-project', client: 'Test' },
    ecosystems: [
      {
        id: 'composer',
        validationCommands: [{ name: 'tests', command: 'composer test' }],
        advisors: [{ name: 'audit', command: 'composer audit' }],
      },
    ],
    protected_packages: {},
    safe_update_policy: {
      allow_patch_and_minor_within_constraints: true,
      require_authorization_for_constraint_change: true,
    },
    conflict_resolution: 'stop_and_ask',
    scanners: { osv: { runner: 'local' } },
  } as unknown as ProjectConfig;
}

// ─── OSV scan output builders ─────────────────────────────────────────────────

function buildAutoSafeNpmScanOutput(): string {
  return JSON.stringify({
    results: [
      {
        source: { path: 'package-lock.json', type: 'lockfile' },
        packages: [
          {
            package: { name: 'lodash', version: '4.17.20', ecosystem: 'npm' },
            vulnerabilities: [
              {
                id: 'GHSA-test-auto-safe-npm',
                summary: 'Prototype pollution',
                affected: [
                  {
                    package: { ecosystem: 'npm', name: 'lodash' },
                    ranges: [
                      { type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.17.21' }] },
                    ],
                  },
                ],
              },
            ],
            groups: [{ ids: ['GHSA-test-auto-safe-npm'] }],
          },
        ],
      },
    ],
  });
}

function buildBreakingComposerScanResult(): ScanResultJson {
  return {
    $schema: 'osv-scan-result/v1',
    agent: 'osv',
    status: 'success',
    environment: 'local',
    ecosystems: {
      composer: {
        vulnerabilities_total: 1,
        auto_safe: 0,
        breaking: 1,
        manual: 0,
        auto_safe_packages: [],
        breaking_packages: ['symfony/http-foundation@7.0.0'],
        manual_packages: [],
        vulnerabilities: [
          {
            ecosystem: 'composer',
            package: 'symfony/http-foundation',
            currentVersion: '6.0.0',
            safeVersion: '7.0.0',
            cvss: '9.0',
            ghsaId: 'GHSA-test-breaking-comp',
            risk: 'critical',
            classification: 'breaking',
            reason: 'major version bump required',
          },
        ],
      },
    },
    error: null,
  };
}

function buildEmptyOsvScanResult(): ScanResultJson {
  return {
    $schema: 'osv-scan-result/v1',
    agent: 'osv',
    status: 'success',
    environment: 'local',
    ecosystems: {},
    error: null,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('pipeline-e2e — npm project with auto_safe vuln', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('produces a successful update result and runs npm audit fix', async () => {
    const config = makeNpmOnlyConfig();
    const scanOutput = buildAutoSafeNpmScanOutput();

    const runner = new MockCommandRunner({
      '--version': { stdout: 'osv-scanner version 1.9.0', exitCode: 0 },
      '--lockfile package-lock.json --format json': { stdout: scanOutput, exitCode: 0 },
      'npm audit': { stdout: '', exitCode: 0 },
      'npm outdated': { stdout: '', exitCode: 0 },
      'npm audit fix': { stdout: 'npm fixed 1 vulnerability', exitCode: 0 },
      'npm run build': { stdout: 'build ok', exitCode: 0 },
    });

    const result = await runOrchestrator(runner, config, {
      configPath: 'project-config.yml',
      cwd: fixturesDir,
      dryRun: false,
      verbose: false,
      scannerRegistry: makeOsvOnlyRegistry(),
    });

    // Scan should have produced a result
    expect(result.scan).not.toBeNull();
    expect(result.scan?.agent).toBe('osv');

    // npm audit fix should have been called
    const auditFixCalls = runner.calledCommands.filter((c) => c.includes('npm audit fix'));
    expect(auditFixCalls.length).toBeGreaterThan(0);

    // Update result for npm should exist
    expect(result.updates['npm']).toBeDefined();
  });

  it('does not invoke osv-scanner fix when fixer=npm-audit (exclusive strategies)', async () => {
    const config = makeNpmOnlyConfig();
    const scanOutput = buildAutoSafeNpmScanOutput();

    const runner = new MockCommandRunner({
      '--version': { stdout: 'osv-scanner version 1.9.0', exitCode: 0 },
      '--lockfile package-lock.json --format json': { stdout: scanOutput, exitCode: 0 },
      'npm audit': { stdout: '', exitCode: 0 },
      'npm outdated': { stdout: '', exitCode: 0 },
      'npm audit fix': { stdout: 'fixed', exitCode: 0 },
      'npm run build': { stdout: 'ok', exitCode: 0 },
    });

    await runOrchestrator(runner, config, {
      configPath: 'project-config.yml',
      cwd: fixturesDir,
      dryRun: false,
      verbose: false,
      scannerRegistry: makeOsvOnlyRegistry(),
    });

    const osvFixCalls = runner.calledCommands.filter((c) =>
      c.includes('osv-scanner fix'),
    );
    expect(osvFixCalls).toHaveLength(0);
  });
});

describe('pipeline-e2e — composer project with breaking vuln', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports breaking classification for composer when safe version is major bump', async () => {
    const config = makeComposerOnlyConfig();
    const breakingScanResult = buildBreakingComposerScanResult();

    const reg = new ScannerEngineRegistry();
    reg.register(new StubScannerEngine('osv', breakingScanResult));

    const runner = new MockCommandRunner({
      'composer audit': { stdout: '', exitCode: 0 },
    });

    const result = await runOrchestrator(runner, config, {
      configPath: 'project-config.yml',
      cwd: fixturesDir,
      dryRun: false,
      verbose: false,
      scannerRegistry: reg,
    });

    expect(result.scan).not.toBeNull();
    expect(result.scan?.agent).toBe('osv');

    // Breaking vuln means hasPendingVulns should be true
    expect(result.hasPendingVulns).toBe(true);

    // Composer ecosystem in scan result has breaking=1
    const composerEco = result.scan?.ecosystems['composer'];
    expect(composerEco).toBeDefined();
    expect(composerEco?.breaking).toBe(1);
    expect(composerEco?.auto_safe).toBe(0);
  });

  it('does not run composer update commands for breaking vulns without authorization', async () => {
    const config = makeComposerOnlyConfig();
    const breakingScanResult = buildBreakingComposerScanResult();

    const reg = new ScannerEngineRegistry();
    reg.register(new StubScannerEngine('osv', breakingScanResult));

    const runner = new MockCommandRunner({
      'composer audit': { stdout: '', exitCode: 0 },
    });

    await runOrchestrator(runner, config, {
      configPath: 'project-config.yml',
      cwd: fixturesDir,
      dryRun: false,
      verbose: false,
      scannerRegistry: reg,
    });

    // No composer update should have been called
    const composerUpdateCalls = runner.calledCommands.filter(
      (c) => c.includes('composer update') || c.includes('composer require'),
    );
    expect(composerUpdateCalls).toHaveLength(0);
  });
});

describe('pipeline-e2e — clean project (no vulnerabilities)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exits cleanly with no update commands and no pending vulns', async () => {
    const config = makeNpmOnlyConfig();
    const emptyResult = buildEmptyOsvScanResult();

    const reg = new ScannerEngineRegistry();
    reg.register(new StubScannerEngine('osv', emptyResult));

    const runner = new MockCommandRunner({
      'npm audit': { stdout: '', exitCode: 0 },
    });

    const result = await runOrchestrator(runner, config, {
      configPath: 'project-config.yml',
      cwd: fixturesDir,
      dryRun: false,
      verbose: false,
      scannerRegistry: reg,
    });

    expect(result.scan).not.toBeNull();
    expect(result.scan?.agent).toBe('osv');
    expect(result.hasPendingVulns).toBe(false);

    // No update commands for clean project
    const updateCalls = runner.calledCommands.filter(
      (c) => c.includes('npm audit fix') || c.includes('osv-scanner fix'),
    );
    expect(updateCalls).toHaveLength(0);

    // No updates recorded
    expect(Object.keys(result.updates)).toHaveLength(0);
  });

  it('overallStatus reflects success for a clean project', async () => {
    const config = makeNpmOnlyConfig();
    const emptyResult = buildEmptyOsvScanResult();

    const reg = new ScannerEngineRegistry();
    reg.register(new StubScannerEngine('osv', emptyResult));

    const runner = new MockCommandRunner({});

    const result = await runOrchestrator(runner, config, {
      configPath: 'project-config.yml',
      cwd: fixturesDir,
      dryRun: false,
      verbose: false,
      scannerRegistry: reg,
    });

    // Pipeline should not have errored
    expect(result.overallStatus).not.toBe('error');
    expect(result.warnings).toHaveLength(0);
  });
});
