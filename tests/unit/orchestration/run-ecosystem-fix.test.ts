/**
 * Unit tests for runEcosystemFix — the per-plugin fix flow extracted from
 * the orchestrator loop.
 *
 * Strategy: drive the function with a fake EcosystemPlugin and a controllable
 * MockCommandRunner. External seams (Docker, OSV staging, gate validator,
 * ecosystem runtime) are mocked at module level.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@infra/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), phase: vi.fn(), skip: vi.fn(), header: vi.fn(), tagged: vi.fn() },
  setProgressSink: vi.fn(), makeProgressSink: vi.fn(),
}));

// Identity passthrough — the host runner is what runUpdater receives.
// resolveOsvRuntime also returns the host runner (matches the local-mode path used in makeConfig).
vi.mock('@infra/ecosystem-runtime', () => ({
  resolveEcosystemRuntime: vi.fn(async (_plugin: unknown, hostRunner: unknown) => hostRunner),
  resolveOsvRuntime: vi.fn((_config: unknown, _cwd: unknown, hostRunner: unknown) => hostRunner),
}));

vi.mock('@orchestration/osv-fix-applier', () => ({
  applyOsvFixViaStaging: vi.fn(),
}));

// Default to valid:true so individual tests can override per case.
vi.mock('@core/gates/validator', () => ({
  validateEcosystemGate: vi.fn().mockReturnValue({ valid: true, gate: 'npm', errors: [] }),
}));

import { runEcosystemFix } from '@orchestration/run-ecosystem-fix';
import { applyOsvFixViaStaging } from '@orchestration/osv-fix-applier';
import { validateEcosystemGate } from '@core/gates/validator';
import { GateValidationError } from '@core/errors';
import type { EcosystemPlugin } from '@modules/ecosystem/types';
import type { CommandRunner, CommandResult, CommandRunnerOptions } from '@core/types/common';
import type { ProjectConfig } from '@core/types/config';
import type { ScanResultJson } from '@core/types/scan';
import type { UpdateResultJson } from '@core/types/update';

class MockRunner implements CommandRunner {
  readonly dryRun = false;
  readonly environment = 'local' as const;
  readonly calls: string[] = [];
  constructor(private stdoutByMatch: Record<string, string> = {}) {}
  async run(command: string, _opts?: CommandRunnerOptions): Promise<CommandResult> {
    this.calls.push(command);
    for (const [k, v] of Object.entries(this.stdoutByMatch)) {
      if (command.includes(k)) {
        return { stdout: v, stderr: '', exitCode: 0, command, dryRun: false };
      }
    }
    return { stdout: '', stderr: '', exitCode: 0, command, dryRun: false };
  }
  async runArgs(file: string, args: string[]): Promise<CommandResult> {
    return this.run([file, ...args].join(' '));
  }
}

function makeUpdateResult(
  overrides: Partial<UpdateResultJson> = {},
): UpdateResultJson {
  return {
    $schema: 'osv-update-result/v1',
    agent: 'deep-health/test',
    status: 'success',
    packages_updated: [],
    packages_skipped: [],
    packages_pending_breaking: [],
    validations: [{ name: 'tests', status: 'pass' }],
    error: null,
    ...overrides,
  };
}

function makePlugin(overrides: Partial<EcosystemPlugin> = {}): EcosystemPlugin {
  const runUpdater = vi.fn(async (): Promise<UpdateResultJson> => makeUpdateResult());
  return {
    id: 'npm',
    name: 'npm',
    lockfiles: ['package-lock.json'],
    osvEcosystems: ['npm'],
    reportLabel: 'npm',
    supportedFixers: ['osv', 'npm-audit'],
    defaultValidationCommands: [],
    defaultAdvisors: [],
    buildScanArgs: () => ['--lockfile', 'package-lock.json'],
    getProtectedPackages: () => [],
    runUpdater,
    postUpdateOsvVerify: 'never',
    ...overrides,
  } as EcosystemPlugin;
}

function makeConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
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

function makeScan(overrides: { auto_safe?: number; breaking?: number } = {}): ScanResultJson {
  return {
    $schema: 'osv-scan-result/v1',
    status: 'success',
    ecosystems: {
      npm: {
        vulnerabilities_total: (overrides.auto_safe ?? 1) + (overrides.breaking ?? 0),
        auto_safe: overrides.auto_safe ?? 1,
        breaking: overrides.breaking ?? 0,
        manual: 0,
        vulnerabilities: [],
      },
    },
  } as ScanResultJson;
}

describe('runEcosystemFix', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateEcosystemGate).mockReturnValue({ valid: true, gate: 'npm', errors: [] });
    vi.mocked(applyOsvFixViaStaging).mockResolvedValue({
      applied: false,
      packagesUpdated: [],
      backups: new Map(),
      rawFixStdout: '',
      rawFixStderr: '',
    });
  });

  it('skips when no auto-safe vulnerabilities and no authorized breaking', async () => {
    const plugin = makePlugin();
    const outcome = await runEcosystemFix({
      plugin,
      hostRunner: new MockRunner(),
      config: makeConfig(),
      scanResult: makeScan({ auto_safe: 0, breaking: 0 }),
      cwd: '/project',
      dryRun: false,
      authorizeBreaking: false,
      preRunSnapshots: undefined,
    });

    expect(outcome).toEqual({ status: 'skipped', reason: 'no-updates' });
    expect(plugin.runUpdater).not.toHaveBeenCalled();
  });

  it('runs OSV staging-fix and propagates osvFixOutcome to runUpdater when fixer=osv', async () => {
    vi.mocked(applyOsvFixViaStaging).mockResolvedValue({
      applied: true,
      packagesUpdated: [{ name: 'lodash', versionFrom: '4.17.20', versionTo: '4.17.21' }],
      backups: new Map([['package-lock.json', '{"lockfileVersion":3}']]),
      rawFixStdout: '',
      rawFixStderr: '',
    });

    const plugin = makePlugin({
      osvFixSpec: { fixLockfile: 'package-lock.json', backupFiles: ['package-lock.json'] },
    });

    await runEcosystemFix({
      plugin,
      hostRunner: new MockRunner(),
      config: makeConfig({
        ecosystems: [{ id: 'npm', fixer: 'osv', validationCommands: [], advisors: [] }],
      }),
      scanResult: makeScan(),
      cwd: '/project',
      dryRun: false,
      authorizeBreaking: false,
      preRunSnapshots: undefined,
    });

    expect(applyOsvFixViaStaging).toHaveBeenCalledOnce();
    const updaterCall = vi.mocked(plugin.runUpdater).mock.calls[0][0];
    expect(updaterCall.fixerStrategy).toBe('osv');
    expect(updaterCall.osvFixOutcome).toEqual({
      applied: true,
      packagesUpdated: [{ name: 'lodash', versionFrom: '4.17.20', versionTo: '4.17.21' }],
    });
    expect(updaterCall.preFixBackups).toBeDefined();
  });

  it('skips OSV staging-fix when fixer=npm-audit', async () => {
    const plugin = makePlugin({
      osvFixSpec: { fixLockfile: 'package-lock.json', backupFiles: ['package-lock.json'] },
    });
    await runEcosystemFix({
      plugin,
      hostRunner: new MockRunner(),
      config: makeConfig({
        ecosystems: [{ id: 'npm', fixer: 'npm-audit', validationCommands: [], advisors: [] }],
      }),
      scanResult: makeScan(),
      cwd: '/project',
      dryRun: false,
      authorizeBreaking: false,
      preRunSnapshots: undefined,
    });

    expect(applyOsvFixViaStaging).not.toHaveBeenCalled();
    const updaterCall = vi.mocked(plugin.runUpdater).mock.calls[0][0];
    expect(updaterCall.fixerStrategy).toBe('npm-audit');
    expect(updaterCall.osvFixOutcome).toBeUndefined();
  });

  it('returns "error" outcome (with merged error) when breaking-install fails — and skips residual verify and gate', async () => {
    const installBreakingPackages = vi.fn().mockResolvedValue({
      status: 'error',
      error: 'install -g @scope/breaking failed',
    });

    const plugin = makePlugin({
      installBreakingPackages,
      postUpdateOsvVerify: 'always', // would normally run, but should be skipped on this path
    });

    const outcome = await runEcosystemFix({
      plugin,
      hostRunner: new MockRunner(),
      config: makeConfig(),
      scanResult: makeScan({ auto_safe: 1, breaking: 2 }),
      cwd: '/project',
      dryRun: false,
      authorizeBreaking: true,
      preRunSnapshots: undefined,
    });

    expect(outcome.status).toBe('error');
    if (outcome.status === 'error') {
      expect(outcome.updateResult.status).toBe('error');
      expect(outcome.updateResult.error).toBe('install -g @scope/breaking failed');
    }
    expect(installBreakingPackages).toHaveBeenCalledOnce();
    // gate validation must be skipped on this branch (breaking-install error short-circuits)
    expect(validateEcosystemGate).not.toHaveBeenCalled();
  });

  it('throws GateValidationError when ecosystem gate fails', async () => {
    vi.mocked(validateEcosystemGate).mockReturnValue({
      valid: false,
      gate: 'npm',
      errors: ['validations[0].status must be one of: pass, fail, skipped'],
    });

    const plugin = makePlugin();

    await expect(
      runEcosystemFix({
        plugin,
        hostRunner: new MockRunner(),
        config: makeConfig(),
        scanResult: makeScan(),
        cwd: '/project',
        dryRun: false,
        authorizeBreaking: false,
        preRunSnapshots: undefined,
      }),
    ).rejects.toBeInstanceOf(GateValidationError);
  });

  it('returns "success" with residualVerification when postUpdateOsvVerify=always and residual scan yields unverified', async () => {
    const residualScanJson = JSON.stringify({
      ecosystems: {
        npm: { vulnerabilities_total: 1 },
        composer: { vulnerabilities_total: 0 },
      },
    });

    const hostRunner = new MockRunner({ 'osv-scanner --lockfile package-lock.json --format json': residualScanJson });

    const plugin = makePlugin({ postUpdateOsvVerify: 'always' });

    const outcome = await runEcosystemFix({
      plugin,
      hostRunner,
      config: makeConfig(),
      scanResult: makeScan(),
      cwd: '/project',
      dryRun: false,
      authorizeBreaking: false,
      preRunSnapshots: undefined,
    });

    expect(outcome.status).toBe('success');
    if (outcome.status === 'success') {
      expect(outcome.residualVerification).toEqual({
        status: 'unverified',
        summary: { npm: 1, composer: 0 },
      });
    }
  });

  // ─── lockfileVersion 1 auto-demotion (via resolveEffectiveFixer hook) ────────

  it('auto-demotes fixer osv→npm-audit when plugin.resolveEffectiveFixer returns npm-audit, skips applyOsvFixViaStaging', async () => {
    const plugin = makePlugin({
      osvFixSpec: { fixLockfile: 'package-lock.json', backupFiles: ['package-lock.json'] },
      resolveEffectiveFixer: vi.fn().mockResolvedValue('npm-audit'),
    });

    await runEcosystemFix({
      plugin,
      hostRunner: new MockRunner(),
      config: makeConfig({
        ecosystems: [{ id: 'npm', fixer: 'osv', validationCommands: [], advisors: [] }],
      }),
      scanResult: makeScan(),
      cwd: '/project',
      dryRun: false,
      authorizeBreaking: false,
      preRunSnapshots: undefined,
    });

    // resolveEffectiveFixer must have been called
    expect(plugin.resolveEffectiveFixer).toHaveBeenCalledOnce();
    // OSV staging must be skipped — strategy was demoted
    expect(applyOsvFixViaStaging).not.toHaveBeenCalled();
    // runUpdater must receive the demoted strategy
    const updaterCall = vi.mocked(plugin.runUpdater).mock.calls[0][0];
    expect(updaterCall.fixerStrategy).toBe('npm-audit');
  });

  it('auto-demotes fixer osv-then-audit→npm-audit when plugin.resolveEffectiveFixer returns npm-audit', async () => {
    const plugin = makePlugin({
      osvFixSpec: { fixLockfile: 'package-lock.json', backupFiles: ['package-lock.json'] },
      resolveEffectiveFixer: vi.fn().mockResolvedValue('npm-audit'),
    });

    await runEcosystemFix({
      plugin,
      hostRunner: new MockRunner(),
      config: makeConfig({
        ecosystems: [{ id: 'npm', fixer: 'osv-then-audit', validationCommands: [], advisors: [] }],
      }),
      scanResult: makeScan(),
      cwd: '/project',
      dryRun: false,
      authorizeBreaking: false,
      preRunSnapshots: undefined,
    });

    expect(applyOsvFixViaStaging).not.toHaveBeenCalled();
    const updaterCall = vi.mocked(plugin.runUpdater).mock.calls[0][0];
    expect(updaterCall.fixerStrategy).toBe('npm-audit');
  });

  it('does NOT demote when resolveEffectiveFixer returns osv (lockfileVersion=2)', async () => {
    const plugin = makePlugin({
      osvFixSpec: { fixLockfile: 'package-lock.json', backupFiles: ['package-lock.json'] },
      resolveEffectiveFixer: vi.fn().mockResolvedValue('osv'),
    });

    await runEcosystemFix({
      plugin,
      hostRunner: new MockRunner(),
      config: makeConfig({
        ecosystems: [{ id: 'npm', fixer: 'osv', validationCommands: [], advisors: [] }],
      }),
      scanResult: makeScan(),
      cwd: '/project',
      dryRun: false,
      authorizeBreaking: false,
      preRunSnapshots: undefined,
    });

    // applyOsvFixViaStaging should have been called (strategy stays osv)
    expect(applyOsvFixViaStaging).toHaveBeenCalledOnce();
    const updaterCall = vi.mocked(plugin.runUpdater).mock.calls[0][0];
    expect(updaterCall.fixerStrategy).toBe('osv');
  });

  it('uses inline fallback resolution when plugin has no resolveEffectiveFixer hook', async () => {
    // Plugin without the hook — runEcosystemFix falls back to inline resolution
    const plugin = makePlugin();
    // No resolveEffectiveFixer on the plugin

    await runEcosystemFix({
      plugin,
      hostRunner: new MockRunner(),
      config: makeConfig({
        ecosystems: [{ id: 'npm', fixer: 'npm-audit', validationCommands: [], advisors: [] }],
      }),
      scanResult: makeScan(),
      cwd: '/project',
      dryRun: false,
      authorizeBreaking: false,
      preRunSnapshots: undefined,
    });

    // Should use the config-specified fixer directly
    const updaterCall = vi.mocked(plugin.runUpdater).mock.calls[0][0];
    expect(updaterCall.fixerStrategy).toBe('npm-audit');
    // No hook was present — OSV staging was also skipped (plugin has no osvFixSpec)
    expect(applyOsvFixViaStaging).not.toHaveBeenCalled();
  });

  it('skips residual verification after demotion (osv-strategy-only does not fire for npm-audit)', async () => {
    const hostRunner = new MockRunner();
    const plugin = makePlugin({
      postUpdateOsvVerify: 'osv-strategy-only',
      resolveEffectiveFixer: vi.fn().mockResolvedValue('npm-audit'),
    });

    const outcome = await runEcosystemFix({
      plugin,
      hostRunner,
      config: makeConfig({
        ecosystems: [{ id: 'npm', fixer: 'osv', validationCommands: [], advisors: [] }],
      }),
      scanResult: makeScan(),
      cwd: '/project',
      dryRun: false,
      authorizeBreaking: false,
      preRunSnapshots: undefined,
    });

    expect(outcome.status).toBe('success');
    if (outcome.status === 'success') {
      // Demoted to npm-audit → osv-strategy-only residual verify must be skipped
      expect(outcome.residualVerification).toBeUndefined();
    }
  });

  it('skips residual verification when postUpdateOsvVerify=osv-strategy-only and fixer is not osv', async () => {
    const hostRunner = new MockRunner();
    const plugin = makePlugin({ postUpdateOsvVerify: 'osv-strategy-only' });

    const outcome = await runEcosystemFix({
      plugin,
      hostRunner,
      config: makeConfig({
        ecosystems: [{ id: 'npm', fixer: 'npm-audit', validationCommands: [], advisors: [] }],
      }),
      scanResult: makeScan(),
      cwd: '/project',
      dryRun: false,
      authorizeBreaking: false,
      preRunSnapshots: undefined,
    });

    expect(outcome.status).toBe('success');
    if (outcome.status === 'success') {
      expect(outcome.residualVerification).toBeUndefined();
    }
    // No osv-scanner residual verify command should have been issued
    expect(hostRunner.calls.some((c) => c.startsWith('osv-scanner'))).toBe(false);
  });
});
