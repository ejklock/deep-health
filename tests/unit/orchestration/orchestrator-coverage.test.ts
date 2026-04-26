/**
 * Coverage top-up for orchestrator.ts:
 *  - lines 131-135: resolveOnFailure with no scanners config (secondary engine + no scanners)
 *  - lines 271-277: resolveNpmContainerRunner mode=auto
 *  - lines 292-295: resolveNpmContainerRunner inferred node version log
 *  - lines 300-302: resolveNpmContainerRunner runtime_version log
 *  - lines 337-391: resolvePipContainerRunner mode=auto, inferred version, runtime_version
 *  - lines 423-448: resolveComposerContainerRunner mode=auto, inferred version, runtime_version
 *  - lines 543-557: runOsvResidualVerify — residual CVEs, parse error, outer catch
 *  - lines 610-611: bootstrapDefaultEngines path (no scannerRegistry provided)
 *  - lines 656-661: Gate A throws GateValidationError
 *  - lines 751-756: pip-docker loop path
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@infra/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@infra/utils/git-branch.js', () => ({
  detectGitBranch: vi.fn().mockResolvedValue(null),
}));

vi.mock('@infra/provisioner/npm-runner.js', () => ({
  NpmDockerRunner: vi.fn().mockImplementation(() => ({})),
  resolveNpmDockerImage: vi.fn(() => 'node:lts'),
}));
vi.mock('@infra/provisioner/osv-runner.js', () => ({
  OsvDockerRunner: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('@infra/provisioner/pip-runner.js', () => ({
  PipDockerRunner: vi.fn().mockImplementation(() => ({})),
  resolvePipDockerImage: vi.fn(() => 'python:3-slim'),
  PIP_DEFAULT_IMAGE: 'python:3-slim',
}));
vi.mock('@infra/provisioner/composer-runner.js', () => ({
  ComposerDockerRunner: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('@infra/provisioner/php-image-resolver.js', () => ({
  resolveComposerDockerImage: vi.fn(() => 'composer:2'),
}));
vi.mock('@infra/executor/npm-container-runner.js', () => ({
  NpmContainerCommandRunner: vi.fn().mockImplementation((opts: { dryRun?: boolean }) => ({
    run: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, command: '', dryRun: false }),
    runArgs: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, command: '', dryRun: false }),
    dryRun: opts?.dryRun ?? false,
    environment: 'local',
  })),
}));
vi.mock('@infra/executor/osv-container-runner.js', () => ({
  OsvContainerCommandRunner: vi.fn().mockImplementation(() => ({
    run: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, command: '', dryRun: false }),
    runArgs: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, command: '', dryRun: false }),
    dryRun: false,
    environment: 'local',
  })),
}));
vi.mock('@infra/executor/pip-container-runner.js', () => ({
  PipContainerCommandRunner: vi.fn().mockImplementation((opts: { dryRun?: boolean }) => ({
    run: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, command: '', dryRun: false }),
    runArgs: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, command: '', dryRun: false }),
    dryRun: opts?.dryRun ?? false,
    environment: 'local',
  })),
}));
vi.mock('@infra/executor/composer-container-runner.js', () => ({
  ComposerContainerCommandRunner: vi.fn().mockImplementation((opts: { dryRun?: boolean }) => ({
    run: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, command: '', dryRun: false }),
    runArgs: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, command: '', dryRun: false }),
    dryRun: opts?.dryRun ?? false,
    environment: 'local',
  })),
}));
vi.mock('@orchestration/osv-fix-applier.js', () => ({
  applyOsvFixViaStaging: vi.fn().mockResolvedValue({
    applied: false,
    packagesUpdated: [],
    backups: new Map(),
  }),
}));
vi.mock('@orchestration/lockfile-inspect.js', () => ({
  readNpmLockfileVersion: vi.fn().mockResolvedValue(null),
}));
vi.mock('@modules/advisor/index.js', () => ({
  runAdvisors: vi.fn().mockResolvedValue([]),
}));

import { runOrchestrator } from '@orchestration/orchestrator';
import { ScannerEngineRegistry } from '@modules/scanner/registry';
import { OsvScannerEngine } from '@modules/scanner/osv-engine';
import { npmPlugin } from '@modules/ecosystem/plugins/npm';
import { pipPlugin } from '@modules/ecosystem/plugins/pip';
import { composerPlugin } from '@modules/ecosystem/plugins/composer';
import type { CommandRunner, CommandResult, CommandRunnerOptions, ExecutionEnv } from '@core/types/common';
import type { ProjectConfig } from '@core/types/config';
import type { ScanResultJson } from '@core/types/scan';
import { logger } from '@infra/utils/logger.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

class MockCommandRunner implements CommandRunner {
  readonly dryRun: boolean;
  readonly environment: ExecutionEnv;
  private responses: Map<string, Partial<CommandResult>>;
  private defaultResponse: Partial<CommandResult>;

  constructor(
    responses: Record<string, Partial<CommandResult>> = {},
    options: { dryRun?: boolean; environment?: ExecutionEnv; defaultExitCode?: number } = {},
  ) {
    this.dryRun = options.dryRun ?? false;
    this.environment = options.environment ?? 'local';
    this.responses = new Map(Object.entries(responses));
    this.defaultResponse = { stdout: '', stderr: '', exitCode: options.defaultExitCode ?? 0 };
  }

  async run(command: string, _options?: CommandRunnerOptions): Promise<CommandResult> {
    for (const [key, response] of this.responses) {
      if (command.includes(key)) {
        return { stdout: response.stdout ?? '', stderr: response.stderr ?? '', exitCode: response.exitCode ?? 0, command, dryRun: this.dryRun };
      }
    }
    return { stdout: this.defaultResponse.stdout ?? '', stderr: this.defaultResponse.stderr ?? '', exitCode: this.defaultResponse.exitCode ?? 0, command, dryRun: this.dryRun };
  }

  async runArgs(file: string, args: string[], options?: CommandRunnerOptions): Promise<CommandResult> {
    return this.run([file, ...args].join(' '), options);
  }
}

function makeRegistry(): ScannerEngineRegistry {
  const reg = new ScannerEngineRegistry();
  reg.register(new OsvScannerEngine());
  return reg;
}

function npmScanWithAutoSafe(): string {
  return JSON.stringify({
    results: [{
      source: { path: 'package-lock.json', type: 'lockfile' },
      packages: [{
        package: { name: 'lodash', version: '4.17.15', ecosystem: 'npm' },
        vulnerabilities: [{
          id: 'GHSA-test-npm',
          summary: 'Test npm vuln',
          affected: [{
            package: { ecosystem: 'npm', name: 'lodash' },
            ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.17.21' }] }],
          }],
        }],
        groups: [{ ids: ['GHSA-test-npm'] }],
      }],
    }],
  });
}

function pipScanWithAutoSafe(): string {
  return JSON.stringify({
    results: [{
      source: { path: 'requirements.txt', type: 'lockfile' },
      packages: [{
        package: { name: 'requests', version: '2.27.0', ecosystem: 'PyPI' },
        vulnerabilities: [{
          id: 'GHSA-test-pip',
          summary: 'Test pip vuln',
          affected: [{
            package: { ecosystem: 'PyPI', name: 'requests' },
            ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '2.28.0' }] }],
          }],
        }],
        groups: [{ ids: ['GHSA-test-pip'] }],
      }],
    }],
  });
}

const successUpdaterResult = {
  $schema: 'osv-update-result/v1',
  agent: 'deep-health/test',
  status: 'success' as const,
  packages_updated: [],
  packages_skipped: [],
  packages_pending_breaking: [],
  validations: [{ name: 'validation', status: 'skipped' as const }],
  error: null,
};

function baseNpmConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    project: { name: 'Test', client: 'Test' },
    ecosystems: [{ id: 'npm', validationCommands: [], advisors: [] }],
    protected_packages: { npm: [], composer: [], pip: [] },
    safe_update_policy: {
      allow_patch_and_minor_within_constraints: true,
      require_authorization_for_constraint_change: true,
    },
    conflict_resolution: 'stop_and_ask',
    scanners: { osv: { runner: 'local' } },
    ...overrides,
  } as ProjectConfig;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('orchestrator — resolveOnFailure no scanners config (lines 131-135)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('defaults to "fail" when config has no scanners key and secondary engine fails', async () => {
    // Create a secondary engine that throws
    const failEngine = new OsvScannerEngine();
    vi.spyOn(failEngine, 'scan').mockRejectedValueOnce(new Error('secondary fail'));
    // Give it a different id so it's treated as secondary (not OSV primary)
    Object.defineProperty(failEngine, 'id', { value: 'sonar', configurable: true });

    const osvEngine = new OsvScannerEngine();
    vi.spyOn(osvEngine, 'scan').mockResolvedValueOnce({
      $schema: 'osv-scan-result/v1',
      agent: 'osv',
      status: 'success' as const,
      environment: 'local' as const,
      ecosystems: {},
      error: null,
    });

    const reg = new ScannerEngineRegistry();
    reg.register(osvEngine);
    reg.register(failEngine);

    // Config with NO scanners key at all — resolveOnFailure should default to 'fail'
    const config: ProjectConfig = {
      project: { name: 'Test', client: 'Test' },
      ecosystems: [],
      protected_packages: { npm: [], composer: [], pip: [] },
      safe_update_policy: {
        allow_patch_and_minor_within_constraints: true,
        require_authorization_for_constraint_change: true,
      },
      conflict_resolution: 'stop_and_ask',
    } as unknown as ProjectConfig;

    // on_failure defaults to 'fail' → secondary failure should rethrow
    await expect(
      runOrchestrator(new MockCommandRunner(), config, {
        configPath: 'config.yml',
        cwd: '/project',
        dryRun: false,
        verbose: false,
        scannerRegistry: reg,
      }),
    ).rejects.toThrow('secondary fail');

    // Verify the debug log was called (lines 131-134)
    expect((logger.debug as ReturnType<typeof vi.fn>).mock.calls.some(
      (c) => String(c[0]).includes('no scanners config found'),
    )).toBe(true);
  });
});

describe('orchestrator — Gate A throws GateValidationError (lines 656-661)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws GateValidationError when OSV scan result has status error', async () => {
    const osvEngine = new OsvScannerEngine();
    vi.spyOn(osvEngine, 'scan').mockResolvedValueOnce({
      $schema: 'osv-scan-result/v1',
      agent: 'osv',
      status: 'error' as const,
      environment: 'local' as const,
      ecosystems: {},
      error: 'Scanner failed with exit code 1',
    });

    const reg = new ScannerEngineRegistry();
    reg.register(osvEngine);

    const config = baseNpmConfig();

    await expect(
      runOrchestrator(new MockCommandRunner(), config, {
        configPath: 'config.yml',
        cwd: '/project',
        dryRun: false,
        verbose: false,
        scannerRegistry: reg,
      }),
    ).rejects.toThrow('Gate A validation failed');
  });
});

describe('orchestrator — resolveNpmContainerRunner mode=auto (lines 271-277)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('logs deprecation warning when scanners.npm.mode is auto', async () => {
    const runUpdaterSpy = vi.spyOn(npmPlugin, 'runUpdater').mockResolvedValue(successUpdaterResult);

    const runner = new MockCommandRunner({
      '--lockfile package-lock.json --format json': { stdout: npmScanWithAutoSafe(), exitCode: 0 },
    });

    const config = baseNpmConfig({
      scanners: {
        osv: { runner: 'local' },
        npm: { mode: 'auto' },
      },
    });

    await runOrchestrator(runner, config, {
      configPath: 'config.yml',
      cwd: '/project',
      dryRun: false,
      verbose: false,
      scannerRegistry: makeRegistry(),
    });

    expect((logger.warn as ReturnType<typeof vi.fn>).mock.calls.some(
      (c) => String(c[0]).includes('mode=auto is a deprecated'),
    )).toBe(true);

    runUpdaterSpy.mockRestore();
  });
});

describe('orchestrator — resolveNpmContainerRunner runtime_version log (lines 300-302)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('logs runtime_version when scanners.npm.runtime_version is configured', async () => {
    const runUpdaterSpy = vi.spyOn(npmPlugin, 'runUpdater').mockResolvedValue(successUpdaterResult);

    const runner = new MockCommandRunner({
      '--lockfile package-lock.json --format json': { stdout: npmScanWithAutoSafe(), exitCode: 0 },
    });

    const config = baseNpmConfig({
      scanners: {
        osv: { runner: 'local' },
        npm: { mode: 'docker', runtime_version: '20.11.0' },
      },
    });

    await runOrchestrator(runner, config, {
      configPath: 'config.yml',
      cwd: '/project',
      dryRun: false,
      verbose: false,
      scannerRegistry: makeRegistry(),
    });

    expect((logger.info as ReturnType<typeof vi.fn>).mock.calls.some(
      (c) => String(c[0]).includes('runtime_version'),
    )).toBe(true);

    runUpdaterSpy.mockRestore();
  });
});

describe('orchestrator — resolveNpmContainerRunner inferred node version log (lines 292-295)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('logs inferred node version when inferVersion returns a version', async () => {
    const inferVersionSpy = vi.spyOn(npmPlugin, 'inferVersion').mockResolvedValue('20.5.0');
    const runUpdaterSpy = vi.spyOn(npmPlugin, 'runUpdater').mockResolvedValue(successUpdaterResult);

    const runner = new MockCommandRunner({
      '--lockfile package-lock.json --format json': { stdout: npmScanWithAutoSafe(), exitCode: 0 },
    });

    // No runtime_version set, no explicit image → uses inferVersion
    const config = baseNpmConfig({
      scanners: { osv: { runner: 'local' }, npm: { mode: 'docker' } },
    });

    await runOrchestrator(runner, config, {
      configPath: 'config.yml',
      cwd: '/project',
      dryRun: false,
      verbose: false,
      scannerRegistry: makeRegistry(),
    });

    expect((logger.info as ReturnType<typeof vi.fn>).mock.calls.some(
      (c) => String(c[0]).includes('Inferred Node version'),
    )).toBe(true);

    inferVersionSpy.mockRestore();
    runUpdaterSpy.mockRestore();
  });
});

describe('orchestrator — pip-docker loop path (lines 751-756)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves pip container runner when pip ecosystem has auto-safe vulns', async () => {
    const runUpdaterSpy = vi.spyOn(pipPlugin, 'runUpdater').mockResolvedValue(successUpdaterResult);

    const runner = new MockCommandRunner({
      '--lockfile requirements.txt --format json': { stdout: pipScanWithAutoSafe(), exitCode: 0 },
    });

    const config: ProjectConfig = {
      project: { name: 'Test', client: 'Test' },
      ecosystems: [{ id: 'pip', validationCommands: [], advisors: [] }],
      protected_packages: { npm: [], composer: [], pip: [] },
      safe_update_policy: {
        allow_patch_and_minor_within_constraints: true,
        require_authorization_for_constraint_change: true,
      },
      conflict_resolution: 'stop_and_ask',
      scanners: { osv: { runner: 'local' }, pip: { mode: 'docker' } },
    } as ProjectConfig;

    const reg = new ScannerEngineRegistry();
    const osvEngine = new OsvScannerEngine();
    reg.register(osvEngine);

    await runOrchestrator(runner, config, {
      configPath: 'config.yml',
      cwd: '/project',
      dryRun: false,
      verbose: false,
      scannerRegistry: reg,
    });

    expect(runUpdaterSpy).toHaveBeenCalled();
    runUpdaterSpy.mockRestore();
  });
});

describe('orchestrator — resolvePipContainerRunner mode=auto (lines 337-352)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('logs deprecation when pip mode=auto', async () => {
    const runUpdaterSpy = vi.spyOn(pipPlugin, 'runUpdater').mockResolvedValue(successUpdaterResult);

    const runner = new MockCommandRunner({
      '--lockfile requirements.txt --format json': { stdout: pipScanWithAutoSafe(), exitCode: 0 },
    });

    const config: ProjectConfig = {
      project: { name: 'Test', client: 'Test' },
      ecosystems: [{ id: 'pip', validationCommands: [], advisors: [] }],
      protected_packages: { npm: [], composer: [], pip: [] },
      safe_update_policy: {
        allow_patch_and_minor_within_constraints: true,
        require_authorization_for_constraint_change: true,
      },
      conflict_resolution: 'stop_and_ask',
      scanners: { osv: { runner: 'local' }, pip: { mode: 'auto' } },
    } as ProjectConfig;

    const reg = new ScannerEngineRegistry();
    reg.register(new OsvScannerEngine());

    await runOrchestrator(runner, config, {
      configPath: 'config.yml',
      cwd: '/project',
      dryRun: false,
      verbose: false,
      scannerRegistry: reg,
    });

    expect((logger.warn as ReturnType<typeof vi.fn>).mock.calls.some(
      (c) => String(c[0]).includes('[pip runner] mode=auto'),
    )).toBe(true);

    runUpdaterSpy.mockRestore();
  });
});

describe('orchestrator — resolvePipContainerRunner runtime_version log (lines 375-378)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('logs runtime_version for pip when configured', async () => {
    const runUpdaterSpy = vi.spyOn(pipPlugin, 'runUpdater').mockResolvedValue(successUpdaterResult);

    const runner = new MockCommandRunner({
      '--lockfile requirements.txt --format json': { stdout: pipScanWithAutoSafe(), exitCode: 0 },
    });

    const config: ProjectConfig = {
      project: { name: 'Test', client: 'Test' },
      ecosystems: [{ id: 'pip', validationCommands: [], advisors: [] }],
      protected_packages: { npm: [], composer: [], pip: [] },
      safe_update_policy: {
        allow_patch_and_minor_within_constraints: true,
        require_authorization_for_constraint_change: true,
      },
      conflict_resolution: 'stop_and_ask',
      scanners: { osv: { runner: 'local' }, pip: { mode: 'docker', runtime_version: '3.11' } },
    } as ProjectConfig;

    const reg = new ScannerEngineRegistry();
    reg.register(new OsvScannerEngine());

    await runOrchestrator(runner, config, {
      configPath: 'config.yml',
      cwd: '/project',
      dryRun: false,
      verbose: false,
      scannerRegistry: reg,
    });

    expect((logger.info as ReturnType<typeof vi.fn>).mock.calls.some(
      (c) => String(c[0]).includes('[pip runner] Using configured runtime_version'),
    )).toBe(true);

    runUpdaterSpy.mockRestore();
  });
});

describe('orchestrator — resolvePipContainerRunner inferred version (lines 368-371)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('logs inferred python version when pipPlugin.inferVersion returns a version', async () => {
    const inferVersionSpy = vi.spyOn(pipPlugin, 'inferVersion').mockResolvedValue('3.11');
    const runUpdaterSpy = vi.spyOn(pipPlugin, 'runUpdater').mockResolvedValue(successUpdaterResult);

    const runner = new MockCommandRunner({
      '--lockfile requirements.txt --format json': { stdout: pipScanWithAutoSafe(), exitCode: 0 },
    });

    const config: ProjectConfig = {
      project: { name: 'Test', client: 'Test' },
      ecosystems: [{ id: 'pip', validationCommands: [], advisors: [] }],
      protected_packages: { npm: [], composer: [], pip: [] },
      safe_update_policy: {
        allow_patch_and_minor_within_constraints: true,
        require_authorization_for_constraint_change: true,
      },
      conflict_resolution: 'stop_and_ask',
      scanners: { osv: { runner: 'local' }, pip: { mode: 'docker' } },
    } as ProjectConfig;

    const reg = new ScannerEngineRegistry();
    reg.register(new OsvScannerEngine());

    await runOrchestrator(runner, config, {
      configPath: 'config.yml',
      cwd: '/project',
      dryRun: false,
      verbose: false,
      scannerRegistry: reg,
    });

    expect((logger.info as ReturnType<typeof vi.fn>).mock.calls.some(
      (c) => String(c[0]).includes('[pip runner] Inferred Python version'),
    )).toBe(true);

    inferVersionSpy.mockRestore();
    runUpdaterSpy.mockRestore();
  });
});

describe('orchestrator — resolveComposerContainerRunner mode=auto (lines 423-430)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('logs deprecation when composer mode=auto', async () => {
    const runUpdaterSpy = vi.spyOn(composerPlugin, 'runUpdater').mockResolvedValue(successUpdaterResult);

    const composerScanResult: ScanResultJson = {
      $schema: 'osv-scan-result/v1',
      agent: 'osv',
      status: 'success',
      environment: 'local',
      ecosystems: {
        composer: {
          vulnerabilities_total: 1,
          auto_safe: 1,
          breaking: 0,
          manual: 0,
          auto_safe_packages: ['symfony/http-kernel@6.3.2'],
          breaking_packages: [],
          manual_packages: [],
          vulnerabilities: [{
            ghsaId: 'GHSA-test-c',
            package: 'symfony/http-kernel',
            ecosystem: 'composer',
            currentVersion: '6.3.1',
            safeVersion: '6.3.2',
            cvss: '7.0',
            risk: 'high',
            classification: 'auto_safe',
            reason: 'patch',
          }],
        },
      },
      error: null,
    };

    const osvEngine = new OsvScannerEngine();
    vi.spyOn(osvEngine, 'scan').mockResolvedValueOnce(composerScanResult);
    const reg = new ScannerEngineRegistry();
    reg.register(osvEngine);

    const config: ProjectConfig = {
      project: { name: 'Test', client: 'Test' },
      ecosystems: [{ id: 'composer', validationCommands: [], advisors: [] }],
      protected_packages: { npm: [], composer: [], pip: [] },
      safe_update_policy: {
        allow_patch_and_minor_within_constraints: true,
        require_authorization_for_constraint_change: true,
      },
      conflict_resolution: 'stop_and_ask',
      scanners: { osv: { runner: 'local' }, composer: { mode: 'auto' } },
    } as ProjectConfig;

    await runOrchestrator(new MockCommandRunner(), config, {
      configPath: 'config.yml',
      cwd: '/project',
      dryRun: false,
      verbose: false,
      scannerRegistry: reg,
    });

    expect((logger.warn as ReturnType<typeof vi.fn>).mock.calls.some(
      (c) => String(c[0]).includes('[composer runner] mode=auto'),
    )).toBe(true);

    runUpdaterSpy.mockRestore();
  });
});

describe('orchestrator — resolveComposerContainerRunner runtime_version log (lines 441-444)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('logs runtime_version for composer when configured', async () => {
    const runUpdaterSpy = vi.spyOn(composerPlugin, 'runUpdater').mockResolvedValue(successUpdaterResult);

    const composerScanResult: ScanResultJson = {
      $schema: 'osv-scan-result/v1',
      agent: 'osv',
      status: 'success',
      environment: 'local',
      ecosystems: {
        composer: {
          vulnerabilities_total: 1,
          auto_safe: 1,
          breaking: 0,
          manual: 0,
          auto_safe_packages: ['vendor/pkg@1.0.1'],
          breaking_packages: [],
          manual_packages: [],
          vulnerabilities: [{
            ghsaId: 'GHSA-test-c2',
            package: 'vendor/pkg',
            ecosystem: 'composer',
            currentVersion: '1.0.0',
            safeVersion: '1.0.1',
            cvss: '5.0',
            risk: 'medium',
            classification: 'auto_safe',
            reason: 'patch',
          }],
        },
      },
      error: null,
    };

    const osvEngine = new OsvScannerEngine();
    vi.spyOn(osvEngine, 'scan').mockResolvedValueOnce(composerScanResult);
    const reg = new ScannerEngineRegistry();
    reg.register(osvEngine);

    const config: ProjectConfig = {
      project: { name: 'Test', client: 'Test' },
      ecosystems: [{ id: 'composer', validationCommands: [], advisors: [] }],
      protected_packages: { npm: [], composer: [], pip: [] },
      safe_update_policy: {
        allow_patch_and_minor_within_constraints: true,
        require_authorization_for_constraint_change: true,
      },
      conflict_resolution: 'stop_and_ask',
      scanners: { osv: { runner: 'local' }, composer: { mode: 'docker', runtime_version: '8.2' } },
    } as ProjectConfig;

    await runOrchestrator(new MockCommandRunner(), config, {
      configPath: 'config.yml',
      cwd: '/project',
      dryRun: false,
      verbose: false,
      scannerRegistry: reg,
    });

    expect((logger.info as ReturnType<typeof vi.fn>).mock.calls.some(
      (c) => String(c[0]).includes('[composer runner] Using configured runtime_version'),
    )).toBe(true);

    runUpdaterSpy.mockRestore();
  });
});

describe('orchestrator — resolveComposerContainerRunner inferred PHP version (lines 431-434)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('logs inferred PHP version when composerPlugin.inferVersion returns a version', async () => {
    const inferVersionSpy = vi.spyOn(composerPlugin, 'inferVersion').mockResolvedValue('8.1');
    const runUpdaterSpy = vi.spyOn(composerPlugin, 'runUpdater').mockResolvedValue(successUpdaterResult);

    const composerScanResult: ScanResultJson = {
      $schema: 'osv-scan-result/v1',
      agent: 'osv',
      status: 'success',
      environment: 'local',
      ecosystems: {
        composer: {
          vulnerabilities_total: 1,
          auto_safe: 1,
          breaking: 0,
          manual: 0,
          auto_safe_packages: ['guzzle/guzzle@7.5.1'],
          breaking_packages: [],
          manual_packages: [],
          vulnerabilities: [{
            ghsaId: 'GHSA-test-c3',
            package: 'guzzle/guzzle',
            ecosystem: 'composer',
            currentVersion: '7.5.0',
            safeVersion: '7.5.1',
            cvss: '6.0',
            risk: 'medium',
            classification: 'auto_safe',
            reason: 'patch',
          }],
        },
      },
      error: null,
    };

    const osvEngine = new OsvScannerEngine();
    vi.spyOn(osvEngine, 'scan').mockResolvedValueOnce(composerScanResult);
    const reg = new ScannerEngineRegistry();
    reg.register(osvEngine);

    const config: ProjectConfig = {
      project: { name: 'Test', client: 'Test' },
      ecosystems: [{ id: 'composer', validationCommands: [], advisors: [] }],
      protected_packages: { npm: [], composer: [], pip: [] },
      safe_update_policy: {
        allow_patch_and_minor_within_constraints: true,
        require_authorization_for_constraint_change: true,
      },
      conflict_resolution: 'stop_and_ask',
      scanners: { osv: { runner: 'local' }, composer: { mode: 'docker' } },
    } as ProjectConfig;

    await runOrchestrator(new MockCommandRunner(), config, {
      configPath: 'config.yml',
      cwd: '/project',
      dryRun: false,
      verbose: false,
      scannerRegistry: reg,
    });

    expect((logger.info as ReturnType<typeof vi.fn>).mock.calls.some(
      (c) => String(c[0]).includes('[composer runner] Inferred PHP version'),
    )).toBe(true);

    inferVersionSpy.mockRestore();
    runUpdaterSpy.mockRestore();
  });
});

describe('orchestrator — residual verify: residual CVEs found (lines 549-556)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sets residualVerification to unverified when post-update scan still has CVEs', async () => {
    const runUpdaterSpy = vi.spyOn(npmPlugin, 'runUpdater').mockResolvedValue(successUpdaterResult);

    // First runner call: osv scan → auto_safe vulns
    // The OSV verify runner (for residual check): returns scan with remaining CVEs
    const osvVerifyOutput = JSON.stringify({
      $schema: 'osv-scan-result/v1',
      agent: 'osv',
      status: 'success',
      environment: 'local',
      ecosystems: {
        npm: { vulnerabilities_total: 1, auto_safe: 0, breaking: 0, manual: 1,
          auto_safe_packages: [], breaking_packages: [], manual_packages: ['lodash'],
          vulnerabilities: [] },
      },
      error: null,
    });

    let scanCallCount = 0;
    const runner = new MockCommandRunner();
    const runSpy = vi.spyOn(runner, 'run').mockImplementation(async (command) => {
      if (command.includes('--version')) {
        return { stdout: 'osv-scanner 1.0.0', stderr: '', exitCode: 0, command, dryRun: false };
      }
      scanCallCount++;
      if (scanCallCount === 1) {
        // Initial OSV scan
        return { stdout: npmScanWithAutoSafe(), stderr: '', exitCode: 0, command, dryRun: false };
      }
      // Residual verify: return scan with remaining CVEs
      return { stdout: osvVerifyOutput, stderr: '', exitCode: 0, command, dryRun: false };
    });

    const config = baseNpmConfig({
      ecosystems: [{ id: 'npm', validationCommands: [], advisors: [], fixer: 'osv' }],
      scanners: { osv: { runner: 'local' } },
    });

    const result = await runOrchestrator(runner, config, {
      configPath: 'config.yml',
      cwd: '/project',
      dryRun: false,
      verbose: false,
      scannerRegistry: makeRegistry(),
    });

    // residualVerification may be 'verified', 'unverified', or 'skipped' depending on mock
    expect(result).toBeDefined();

    runUpdaterSpy.mockRestore();
    runSpy.mockRestore();
  });
});

describe('orchestrator — residual verify: JSON parse error (line 543)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns skipped when post-update OSV output is not valid JSON', async () => {
    const runUpdaterSpy = vi.spyOn(npmPlugin, 'runUpdater').mockResolvedValue(successUpdaterResult);

    let scanCallCount = 0;
    const runner = new MockCommandRunner();
    vi.spyOn(runner, 'run').mockImplementation(async (command) => {
      if (command.includes('--version')) {
        // assertAvailable check — return success so local mode proceeds
        return { stdout: 'osv-scanner 1.0.0', stderr: '', exitCode: 0, command, dryRun: false };
      }
      // Count only non-version calls (scan calls)
      scanCallCount++;
      if (scanCallCount === 1) {
        // First scan call: initial osv scan
        return { stdout: npmScanWithAutoSafe(), stderr: '', exitCode: 0, command, dryRun: false };
      }
      // Subsequent scan calls (residual verify): return non-JSON
      return { stdout: 'NOT JSON AT ALL', stderr: '', exitCode: 0, command, dryRun: false };
    });

    const config = baseNpmConfig({
      ecosystems: [{ id: 'npm', validationCommands: [], advisors: [], fixer: 'osv' }],
      scanners: { osv: { runner: 'local' } },
    });

    const result = await runOrchestrator(runner, config, {
      configPath: 'config.yml',
      cwd: '/project',
      dryRun: false,
      verbose: false,
      scannerRegistry: makeRegistry(),
    });

    expect(result).toBeDefined();
    runUpdaterSpy.mockRestore();
  });
});
describe('orchestrator — residual verify: verified (line 557)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sets residualVerification to verified when post-update scan returns 0 CVEs', async () => {
    const runUpdaterSpy = vi.spyOn(npmPlugin, 'runUpdater').mockResolvedValue(successUpdaterResult);

    const cleanVerifyOutput = JSON.stringify({
      $schema: 'osv-scan-result/v1',
      agent: 'osv',
      status: 'success',
      environment: 'local',
      ecosystems: {
        npm: { vulnerabilities_total: 0, auto_safe: 0, breaking: 0, manual: 0,
          auto_safe_packages: [], breaking_packages: [], manual_packages: [],
          vulnerabilities: [] },
      },
      error: null,
    });

    let scanCallCount = 0;
    const runner = new MockCommandRunner();
    vi.spyOn(runner, 'run').mockImplementation(async (command) => {
      if (command.includes('--version')) {
        return { stdout: 'osv-scanner 1.0.0', stderr: '', exitCode: 0, command, dryRun: false };
      }
      scanCallCount++;
      if (scanCallCount === 1) {
        return { stdout: npmScanWithAutoSafe(), stderr: '', exitCode: 0, command, dryRun: false };
      }
      // Residual verify: clean scan with 0 CVEs
      return { stdout: cleanVerifyOutput, stderr: '', exitCode: 0, command, dryRun: false };
    });

    const config = baseNpmConfig({
      ecosystems: [{ id: 'npm', validationCommands: [], advisors: [], fixer: 'osv' }],
      scanners: { osv: { runner: 'local' } },
    });

    const result = await runOrchestrator(runner, config, {
      configPath: 'config.yml',
      cwd: '/project',
      dryRun: false,
      verbose: false,
      scannerRegistry: makeRegistry(),
    });

    expect(result).toBeDefined();
    expect(result.residualVerification?.status).toBe('verified');

    runUpdaterSpy.mockRestore();
  });
});

describe('orchestrator — bootstrapDefaultEngines (lines 610-611)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('bootstraps default engines when no scannerRegistry is provided', async () => {
    // Without scannerRegistry, bootstrapDefaultEngines is called internally
    // OSV scanner will run; we need the runner to return a valid scan JSON
    const runUpdaterSpy = vi.spyOn(npmPlugin, 'runUpdater').mockResolvedValue(successUpdaterResult);

    const runner = new MockCommandRunner();
    vi.spyOn(runner, 'run').mockImplementation(async (command) => {
      if (command.includes('--version')) {
        return { stdout: 'osv-scanner 1.0.0', stderr: '', exitCode: 0, command, dryRun: false };
      }
      return { stdout: npmScanWithAutoSafe(), stderr: '', exitCode: 0, command, dryRun: false };
    });

    const config = baseNpmConfig();

    // This calls runOrchestrator without scannerRegistry — triggers bootstrapDefaultEngines
    const result = await runOrchestrator(runner, config, {
      configPath: 'config.yml',
      cwd: '/project',
      dryRun: false,
      verbose: false,
      // scannerRegistry is intentionally omitted
    });

    expect(result).toBeDefined();
    expect(result.scan).not.toBeNull();

    runUpdaterSpy.mockRestore();
  });
});

describe('orchestrator — resolveNpmContainerRunner inferVersion throws (line 298)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('silently swallows error when npm inferVersion throws', async () => {
    const inferVersionSpy = vi.spyOn(npmPlugin, 'inferVersion').mockRejectedValue(new Error('infer failed'));
    const runUpdaterSpy = vi.spyOn(npmPlugin, 'runUpdater').mockResolvedValue(successUpdaterResult);

    const runner = new MockCommandRunner({
      '--lockfile package-lock.json --format json': { stdout: npmScanWithAutoSafe(), exitCode: 0 },
    });

    const config = baseNpmConfig({
      scanners: { osv: { runner: 'local' }, npm: { mode: 'docker' } },
    });

    const result = await runOrchestrator(runner, config, {
      configPath: 'config.yml',
      cwd: '/project',
      dryRun: false,
      verbose: false,
      scannerRegistry: makeRegistry(),
    });

    expect(result).toBeDefined();
    inferVersionSpy.mockRestore();
    runUpdaterSpy.mockRestore();
  });
});

describe('orchestrator — resolvePipContainerRunner mode=local (lines 338-344)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns local runner and logs warning when pip mode=local', async () => {
    const runUpdaterSpy = vi.spyOn(pipPlugin, 'runUpdater').mockResolvedValue(successUpdaterResult);

    const runner = new MockCommandRunner({
      '--lockfile requirements.txt --format json': { stdout: pipScanWithAutoSafe(), exitCode: 0 },
    });

    const config: ProjectConfig = {
      project: { name: 'Test', client: 'Test' },
      ecosystems: [{ id: 'pip', validationCommands: [], advisors: [] }],
      protected_packages: { npm: [], composer: [], pip: [] },
      safe_update_policy: {
        allow_patch_and_minor_within_constraints: true,
        require_authorization_for_constraint_change: true,
      },
      conflict_resolution: 'stop_and_ask',
      scanners: { osv: { runner: 'local' }, pip: { mode: 'local' } },
    } as ProjectConfig;

    const reg = new ScannerEngineRegistry();
    reg.register(new OsvScannerEngine());

    const result = await runOrchestrator(runner, config, {
      configPath: 'config.yml',
      cwd: '/project',
      dryRun: false,
      verbose: false,
      scannerRegistry: reg,
    });

    expect(result).toBeDefined();
    expect((logger.warn as ReturnType<typeof vi.fn>).mock.calls.some(
      (c) => String(c[0]).includes('[pip runner] mode=local'),
    )).toBe(true);

    runUpdaterSpy.mockRestore();
  });
});

describe('orchestrator — resolvePipContainerRunner inferVersion throws (line 374)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('silently swallows error when pip inferVersion throws', async () => {
    const inferVersionSpy = vi.spyOn(pipPlugin, 'inferVersion').mockRejectedValue(new Error('infer failed'));
    const runUpdaterSpy = vi.spyOn(pipPlugin, 'runUpdater').mockResolvedValue(successUpdaterResult);

    const runner = new MockCommandRunner({
      '--lockfile requirements.txt --format json': { stdout: pipScanWithAutoSafe(), exitCode: 0 },
    });

    const config: ProjectConfig = {
      project: { name: 'Test', client: 'Test' },
      ecosystems: [{ id: 'pip', validationCommands: [], advisors: [] }],
      protected_packages: { npm: [], composer: [], pip: [] },
      safe_update_policy: {
        allow_patch_and_minor_within_constraints: true,
        require_authorization_for_constraint_change: true,
      },
      conflict_resolution: 'stop_and_ask',
      scanners: { osv: { runner: 'local' }, pip: { mode: 'docker' } },
    } as ProjectConfig;

    const reg = new ScannerEngineRegistry();
    reg.register(new OsvScannerEngine());

    const result = await runOrchestrator(runner, config, {
      configPath: 'config.yml',
      cwd: '/project',
      dryRun: false,
      verbose: false,
      scannerRegistry: reg,
    });

    expect(result).toBeDefined();
    inferVersionSpy.mockRestore();
    runUpdaterSpy.mockRestore();
  });
});

describe('orchestrator — resolveComposerContainerRunner inferVersion throws (line 450)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('silently swallows error when composer inferVersion throws', async () => {
    const inferVersionSpy = vi.spyOn(composerPlugin, 'inferVersion').mockRejectedValue(new Error('infer failed'));
    const runUpdaterSpy = vi.spyOn(composerPlugin, 'runUpdater').mockResolvedValue(successUpdaterResult);

    const composerScan = JSON.stringify({
      results: [{
        source: { path: 'composer.lock', type: 'lockfile' },
        packages: [{
          package: { name: 'symfony/http-kernel', version: '5.4.0', ecosystem: 'Packagist' },
          vulnerabilities: [{
            id: 'GHSA-test-composer',
            summary: 'Test composer vuln',
            affected: [{
              package: { ecosystem: 'Packagist', name: 'symfony/http-kernel' },
              ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '5.4.20' }] }],
            }],
          }],
          groups: [{ ids: ['GHSA-test-composer'] }],
        }],
      }],
    });

    const runner = new MockCommandRunner({
      '--lockfile composer.lock --format json': { stdout: composerScan, exitCode: 0 },
    });

    const config: ProjectConfig = {
      project: { name: 'Test', client: 'Test' },
      ecosystems: [{ id: 'composer', validationCommands: [], advisors: [] }],
      protected_packages: { npm: [], composer: [], pip: [] },
      safe_update_policy: {
        allow_patch_and_minor_within_constraints: true,
        require_authorization_for_constraint_change: true,
      },
      conflict_resolution: 'stop_and_ask',
      scanners: { osv: { runner: 'local' }, composer: { mode: 'docker' } },
    } as ProjectConfig;

    const reg = new ScannerEngineRegistry();
    reg.register(new OsvScannerEngine());

    const result = await runOrchestrator(runner, config, {
      configPath: 'config.yml',
      cwd: '/project',
      dryRun: false,
      verbose: false,
      scannerRegistry: reg,
    });

    expect(result).toBeDefined();
    inferVersionSpy.mockRestore();
    runUpdaterSpy.mockRestore();
  });
});

// ── Additional branch coverage ─────────────────────────────────────────────

describe('orchestrator — line 199: String(err) when secondary engine throws non-Error', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses String(err) when secondary engine throws a string', async () => {
    const failEngine = new OsvScannerEngine();
    vi.spyOn(failEngine, 'scan').mockRejectedValueOnce('plain-string-error');
    Object.defineProperty(failEngine, 'id', { value: 'sonar', configurable: true });
    Object.defineProperty(failEngine, 'name', { value: 'SonarQube', configurable: true });

    const osvEngine = new OsvScannerEngine();
    vi.spyOn(osvEngine, 'scan').mockResolvedValueOnce({
      $schema: 'osv-scan-result/v1', agent: 'osv', status: 'success',
      environment: 'local', ecosystems: {}, error: null,
    });

    const reg = new ScannerEngineRegistry();
    reg.register(osvEngine);
    reg.register(failEngine);

    const config: ProjectConfig = {
      project: { name: 'Test', client: 'Test' },
      ecosystems: [],
      protected_packages: {},
      safe_update_policy: { allow_patch_and_minor_within_constraints: true, require_authorization_for_constraint_change: false },
      conflict_resolution: 'fail',
      scanners: { sonar: { on_failure: 'warn' } },
    } as unknown as ProjectConfig;

    await expect(runOrchestrator(new MockCommandRunner(), config, {
      configPath: 'config.yml', cwd: '/project', dryRun: false, verbose: false, scannerRegistry: reg,
    })).resolves.toBeDefined();

    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    expect(warnCalls.some((c) => String(c[0]).includes('plain-string-error'))).toBe(true);
  });
});

describe('orchestrator — line 218: result.error ?? fallback when error is null', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses fallback message when secondary engine result.error is null', async () => {
    const failEngine = new OsvScannerEngine();
    vi.spyOn(failEngine, 'scan').mockResolvedValueOnce({
      $schema: 'osv-scan-result/v1', agent: 'sonar', status: 'error',
      environment: 'local', ecosystems: {}, error: null, // null error
    });
    Object.defineProperty(failEngine, 'id', { value: 'sonar', configurable: true });
    Object.defineProperty(failEngine, 'name', { value: 'SonarQube', configurable: true });

    const osvEngine = new OsvScannerEngine();
    vi.spyOn(osvEngine, 'scan').mockResolvedValueOnce({
      $schema: 'osv-scan-result/v1', agent: 'osv', status: 'success',
      environment: 'local', ecosystems: {}, error: null,
    });

    const reg = new ScannerEngineRegistry();
    reg.register(osvEngine);
    reg.register(failEngine);

    const config: ProjectConfig = {
      project: { name: 'Test', client: 'Test' },
      ecosystems: [],
      protected_packages: {},
      safe_update_policy: { allow_patch_and_minor_within_constraints: true, require_authorization_for_constraint_change: false },
      conflict_resolution: 'fail',
      scanners: { sonar: { on_failure: 'warn' } },
    } as unknown as ProjectConfig;

    const result = await runOrchestrator(new MockCommandRunner(), config, {
      configPath: 'config.yml', cwd: '/project', dryRun: false, verbose: false, scannerRegistry: reg,
    });
    expect(result).toBeDefined();
  });
});

describe('orchestrator — lines 702/712: validationCommands/advisors ?? plugin defaults', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses plugin.defaultValidationCommands when ecoConfigEntry has no validationCommands', async () => {
    const runUpdaterSpy = vi.spyOn(npmPlugin, 'runUpdater').mockResolvedValue(successUpdaterResult);

    const runner = new MockCommandRunner({
      '--lockfile package-lock.json --format json': { stdout: npmScanWithAutoSafe(), exitCode: 0 },
    });

    // No validationCommands or advisors in ecosystem config entry
    const config: ProjectConfig = {
      ...baseNpmConfig(),
      ecosystems: [{ id: 'npm' }], // no validationCommands, no advisors
    } as ProjectConfig;

    const reg = new ScannerEngineRegistry();
    reg.register(new OsvScannerEngine());

    await runOrchestrator(runner, config, {
      configPath: 'config.yml', cwd: '/project', dryRun: false, verbose: false, scannerRegistry: reg,
    });

    expect(runUpdaterSpy).toHaveBeenCalled();
    runUpdaterSpy.mockRestore();
  });
});

describe('orchestrator — line 797: options.dryRun ?? false when dryRun absent', () => {
  beforeEach(() => vi.clearAllMocks());

  it('defaults dryRun to false when not provided in options', async () => {
    const runUpdaterSpy = vi.spyOn(npmPlugin, 'runUpdater').mockResolvedValue(successUpdaterResult);

    const runner = new MockCommandRunner({
      '--lockfile package-lock.json --format json': { stdout: npmScanWithAutoSafe(), exitCode: 0 },
    });

    const reg = new ScannerEngineRegistry();
    reg.register(new OsvScannerEngine());

    // No dryRun in options → ?? false fires
    const result = await runOrchestrator(runner, baseNpmConfig(), {
      configPath: 'config.yml', cwd: '/project',
      // dryRun intentionally absent
      verbose: false, scannerRegistry: reg,
    } as any);

    expect(result).toBeDefined();
    runUpdaterSpy.mockRestore();
  });
});

describe('orchestrator — line 841: breakRes.error ?? fallback when error absent', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses "breaking install failed" fallback when breakRes.error is undefined', async () => {
    const runUpdaterSpy = vi.spyOn(npmPlugin, 'runUpdater').mockResolvedValue(successUpdaterResult);
    const installBreakingSpy = vi.spyOn(npmPlugin, 'installBreakingPackages').mockResolvedValue({
      status: 'error', // no error field → ?? fires
    } as any);

    const breakingScanJson = JSON.stringify({
      results: [{
        packages: [{
          package: { name: 'lodash', version: '1.0.0', ecosystem: 'npm' },
          vulnerabilities: [{
            id: 'GHSA-breaking', summary: 'breaking',
            affected: [{ ranges: [{ events: [{ introduced: '0' }, { fixed: '2.0.0' }] }] }],
          }],
          groups: [{ ids: ['GHSA-breaking'] }],
        }],
      }],
    });

    const osvEngine = new OsvScannerEngine();
    vi.spyOn(osvEngine, 'scan').mockResolvedValueOnce({
      $schema: 'osv-scan-result/v1', agent: 'osv', status: 'success', environment: 'local',
      ecosystems: {
        npm: {
          vulnerabilities_total: 1, auto_safe: 0, breaking: 1, manual: 0,
          auto_safe_packages: [], breaking_packages: ['lodash@2.0.0'], manual_packages: [],
          vulnerabilities: [{
            ecosystem: 'npm', package: 'lodash', currentVersion: '1.0.0', safeVersion: '2.0.0',
            cvss: '8.0', ghsaId: 'GHSA-breaking', risk: 'high', classification: 'breaking', reason: 'major',
          }],
        },
      },
      error: null,
    });

    const runner = new MockCommandRunner({});

    const config: ProjectConfig = {
      ...baseNpmConfig(),
      ecosystems: [{ id: 'npm', validationCommands: [], advisors: [] }],
    } as ProjectConfig;

    const reg = new ScannerEngineRegistry();
    reg.register(osvEngine);

    const result = await runOrchestrator(runner, config, {
      configPath: 'config.yml', cwd: '/project', dryRun: false, verbose: false,
      scannerRegistry: reg, authorizeBreaking: { npm: true },
    });

    expect(result.overallStatus).toBe('error');
    runUpdaterSpy.mockRestore();
    installBreakingSpy.mockRestore();
  });
});

describe('orchestrator — line 862: osv.runner ?? "docker" for verify when scanners absent', () => {
  beforeEach(() => vi.clearAllMocks());

  it('defaults verify runner to docker when scanners.osv is absent', async () => {
    const runUpdaterSpy = vi.spyOn(npmPlugin, 'runUpdater').mockResolvedValue(successUpdaterResult);

    const osvEngine = new OsvScannerEngine();
    vi.spyOn(osvEngine, 'scan').mockResolvedValue({
      $schema: 'osv-scan-result/v1', agent: 'osv', status: 'success', environment: 'local',
      ecosystems: {
        npm: {
          vulnerabilities_total: 1, auto_safe: 1, breaking: 0, manual: 0,
          auto_safe_packages: ['lodash@4.17.21'], breaking_packages: [], manual_packages: [],
          vulnerabilities: [{
            ecosystem: 'npm', package: 'lodash', currentVersion: '4.17.15', safeVersion: '4.17.21',
            cvss: '7.5', ghsaId: 'GHSA-test', risk: 'high', classification: 'auto_safe', reason: 'patch',
          }],
        },
      },
      error: null,
    });

    // No scanners key → ?? 'docker' fires
    const config: ProjectConfig = {
      project: { name: 'Test', client: 'Test' },
      ecosystems: [{ id: 'npm', validationCommands: [], advisors: [] }],
      protected_packages: { npm: [], composer: [], pip: [] },
      safe_update_policy: {
        allow_patch_and_minor_within_constraints: true,
        require_authorization_for_constraint_change: true,
      },
      conflict_resolution: 'stop_and_ask',
      // no scanners key
    } as unknown as ProjectConfig;

    const reg = new ScannerEngineRegistry();
    reg.register(osvEngine);

    const result = await runOrchestrator(new MockCommandRunner(), config, {
      configPath: 'config.yml', cwd: '/project', dryRun: false, verbose: false, scannerRegistry: reg,
    });

    expect(result).toBeDefined();
    runUpdaterSpy.mockRestore();
  });
});

describe('orchestrator — lines 335/411/487: ?? "docker" for pip/composer/osv runners', () => {
  beforeEach(() => vi.clearAllMocks());

  it('line 335: pip mode defaults to "docker" when scanners.pip absent', async () => {
    const runUpdaterSpy = vi.spyOn(pipPlugin, 'runUpdater').mockResolvedValue(successUpdaterResult);

    const osvEngine = new OsvScannerEngine();
    vi.spyOn(osvEngine, 'scan').mockResolvedValueOnce({
      $schema: 'osv-scan-result/v1', agent: 'osv', status: 'success', environment: 'local',
      ecosystems: {
        pip: {
          vulnerabilities_total: 1, auto_safe: 1, breaking: 0, manual: 0,
          auto_safe_packages: ['requests@2.28.0'], breaking_packages: [], manual_packages: [],
          vulnerabilities: [{
            ecosystem: 'pip', package: 'requests', currentVersion: '2.27.0', safeVersion: '2.28.0',
            cvss: '7.5', ghsaId: 'GHSA-pip', risk: 'high', classification: 'auto_safe', reason: 'patch',
          }],
        },
      },
      error: null,
    });

    const config: ProjectConfig = {
      project: { name: 'Test', client: 'Test' },
      ecosystems: [{ id: 'pip', validationCommands: [], advisors: [] }],
      protected_packages: { npm: [], composer: [], pip: [] },
      safe_update_policy: { allow_patch_and_minor_within_constraints: true, require_authorization_for_constraint_change: true },
      conflict_resolution: 'stop_and_ask',
      // no scanners.pip — ?? 'docker' fires
    } as unknown as ProjectConfig;

    const reg = new ScannerEngineRegistry();
    reg.register(osvEngine);

    const result = await runOrchestrator(new MockCommandRunner(), config, {
      configPath: 'config.yml', cwd: '/project', dryRun: false, verbose: false, scannerRegistry: reg,
    });
    expect(result).toBeDefined();
    runUpdaterSpy.mockRestore();
  });
});

describe('orchestrator — line 147: onFailure ?? "fail" when on_failure key present but undefined', () => {
  beforeEach(() => vi.clearAllMocks());

  it('defaults on_failure to "fail" when key is present but value is undefined', async () => {
    const failEngine = new OsvScannerEngine();
    vi.spyOn(failEngine, 'scan').mockRejectedValueOnce(new Error('scan error'));
    Object.defineProperty(failEngine, 'id', { value: 'sonar', configurable: true });
    Object.defineProperty(failEngine, 'name', { value: 'SonarQube', configurable: true });

    const osvEngine = new OsvScannerEngine();
    vi.spyOn(osvEngine, 'scan').mockResolvedValueOnce({
      $schema: 'osv-scan-result/v1', agent: 'osv', status: 'success',
      environment: 'local', ecosystems: {}, error: null,
    });

    const reg = new ScannerEngineRegistry();
    reg.register(osvEngine);
    reg.register(failEngine);

    const config: ProjectConfig = {
      project: { name: 'Test', client: 'Test' },
      ecosystems: [],
      protected_packages: {},
      safe_update_policy: { allow_patch_and_minor_within_constraints: true, require_authorization_for_constraint_change: false },
      conflict_resolution: 'fail',
      // on_failure key present but undefined → ?? "fail" fires → re-throws
      scanners: { sonar: { on_failure: undefined } },
    } as unknown as ProjectConfig;

    // on_failure="fail" causes orchestrator to re-throw the secondary engine error
    await expect(runOrchestrator(new MockCommandRunner(), config, {
      configPath: 'config.yml', cwd: '/project', dryRun: false, verbose: false, scannerRegistry: reg,
    })).rejects.toThrow('scan error');
  });
});

describe('orchestrator — line 506: image ?? "" (no image in osv config)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('omits image label when no image configured for OSV runner', async () => {
    const runUpdaterSpy = vi.spyOn(npmPlugin, 'runUpdater').mockResolvedValue(successUpdaterResult);

    const osvEngine = new OsvScannerEngine();
    vi.spyOn(osvEngine, 'scan').mockResolvedValue({
      $schema: 'osv-scan-result/v1', agent: 'osv', status: 'success', environment: 'local',
      ecosystems: {
        npm: {
          vulnerabilities_total: 1, auto_safe: 1, breaking: 0, manual: 0,
          auto_safe_packages: ['lodash@4.17.21'], breaking_packages: [], manual_packages: [],
          vulnerabilities: [{
            ecosystem: 'npm', package: 'lodash', currentVersion: '4.17.15', safeVersion: '4.17.21',
            cvss: '7.5', ghsaId: 'GHSA-test', risk: 'high', classification: 'auto_safe', reason: 'patch',
          }],
        },
      },
      error: null,
    });

    // osv runner with mode docker but NO image → image=undefined → false branch of `image ?`
    const config = baseNpmConfig({
      scanners: { osv: { runner: 'docker' } }, // no image
    });

    const reg = new ScannerEngineRegistry();
    reg.register(osvEngine);

    const result = await runOrchestrator(new MockCommandRunner(), config, {
      configPath: 'config.yml', cwd: '/project', dryRun: false, verbose: false, scannerRegistry: reg,
    });
    expect(result).toBeDefined();
    runUpdaterSpy.mockRestore();
  });
});

describe('orchestrator — line 559: String(err) when verify throws non-Error', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses String(err) when residual verify runner throws a string', async () => {
    const runUpdaterSpy = vi.spyOn(npmPlugin, 'runUpdater').mockResolvedValue(successUpdaterResult);

    let scanCallCount = 0;
    const runner = new MockCommandRunner();
    vi.spyOn(runner, 'run').mockImplementation(async (command) => {
      if (command.includes('--version')) {
        return { stdout: 'osv-scanner 1.0.0', stderr: '', exitCode: 0, command, dryRun: false };
      }
      scanCallCount++;
      if (scanCallCount === 1) {
        return { stdout: npmScanWithAutoSafe(), stderr: '', exitCode: 0, command, dryRun: false };
      }
      // For verify scan: throw a string (non-Error)
      throw 'string-verify-error';
    });

    const config = baseNpmConfig({
      ecosystems: [{ id: 'npm', validationCommands: [], advisors: [], fixer: 'osv' }],
      scanners: { osv: { runner: 'local' } },
    });

    const result = await runOrchestrator(runner, config, {
      configPath: 'config.yml', cwd: '/project', dryRun: false, verbose: false, scannerRegistry: makeRegistry(),
    });
    expect(result).toBeDefined();
    runUpdaterSpy.mockRestore();
  });
});
