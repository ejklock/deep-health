import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CommandRunner, CommandResult } from '@core/types/common.js';
import type { ProjectConfig } from '@core/types/config.js';
import type { ScanResultJson } from '@core/types/scan.js';

// ── Module-level mocks ───────────────────────────────────────────────────────
// Hoisted so the factory runs before the module under test is imported.
vi.mock('@infra/utils/git.js', () => ({
  backupFiles: vi.fn().mockResolvedValue(new Map()),
  restoreFiles: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@infra/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// scanner.emptyEcosystem is used when 'npm' key is absent from scanResult
vi.mock('@modules/scanner/index.js', () => ({
  emptyEcosystem: vi.fn(() => ({
    vulnerabilities_total: 0,
    auto_safe: 0,
    breaking: 0,
    manual: 0,
    auto_safe_packages: [],
    breaking_packages: [],
    manual_packages: [],
    vulnerabilities: [],
  })),
}));

import { runNpmUpdater } from '@modules/ecosystem/plugins/npm-updater.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRunner(overrides: Partial<CommandRunner> & { dryRun?: boolean } = {}): CommandRunner {
  const { dryRun = false, ...rest } = overrides;
  return {
    run: vi.fn().mockResolvedValue(ok()),
    dryRun,
    environment: 'local',
    ...rest,
  } as unknown as CommandRunner;
}

function ok(stdout = '', stderr = ''): CommandResult {
  return { stdout, stderr, exitCode: 0, command: '', dryRun: false };
}

function fail(stderr = 'something failed'): CommandResult {
  return { stdout: '', stderr, exitCode: 1, command: '', dryRun: false };
}

function baseConfig(overrides: Partial<ProjectConfig['runtime']> = {}): ProjectConfig {
  return {
    project: { name: 'test-project', client: 'test-client' },
    runtime: {
      execution: 'local',
      docker_service: '',
      ...overrides,
    },
    protected_packages: { composer: [], npm: [] },
    safe_update_policy: {
      allow_patch_and_minor_within_constraints: true,
      require_authorization_for_constraint_change: false,
      authorization_format: '',
    },
    conflict_resolution: 'fail',
  };
}

function baseScan(npmPackages: string[] = ['lodash@4.17.21']): ScanResultJson {
  return {
    $schema: 'osv-scan-result/v1',
    agent: 'osv-scanner',
    status: 'success',
    environment: 'local',
    ecosystems: {
      npm: {
        vulnerabilities_total: 1,
        auto_safe: 1,
        breaking: 0,
        manual: 0,
        auto_safe_packages: npmPackages,
        breaking_packages: [],
        manual_packages: [],
        vulnerabilities: [],
      },
    },
    error: null,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('runNpmUpdater — dry-run paths', () => {
  it('dry-run WITH build_commands => validation status is "skipped" and detail is "Dry-run — not executed"', async () => {
    const runner = makeRunner({ dryRun: true });
    const config = baseConfig({
      build_commands: { frontend: 'npm run build:fe', backend: 'npm run build:be' },
    });

    const result = await runNpmUpdater(runner, config, baseScan(), '/tmp/project');

    expect(result.validations).toHaveLength(1);
    expect(result.validations[0].status).toBe('skipped');
    expect(result.validations[0].detail).toBe('Dry-run — not executed');
    // Runner should not have been called (dry-run skips all commands)
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('dry-run WITHOUT build_commands => validation status is "skipped" and detail explains no build_commands configured', async () => {
    const runner = makeRunner({ dryRun: true });
    const config = baseConfig(); // no build_commands

    const result = await runNpmUpdater(runner, config, baseScan(), '/tmp/project');

    expect(result.validations).toHaveLength(1);
    expect(result.validations[0].status).toBe('skipped');
    expect(result.validations[0].detail).toMatch(/no build_commands configured/i);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('dry-run always returns status "success" (no real commands run)', async () => {
    const runner = makeRunner({ dryRun: true });
    const config = baseConfig();

    const result = await runNpmUpdater(runner, config, baseScan(), '/tmp/project');

    expect(result.status).toBe('success');
    expect(result.$schema).toBe('osv-update-result/v1');
    expect(result.agent).toBe('npm-safe-update');
  });
});

describe('runNpmUpdater — update failure path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('npm update failure => status is "error" and validation detail contains the stderr', async () => {
    // Sequence: npm outdated (ok), npm audit (ok), osv fix (ok), npm update (FAIL)
    const runner = makeRunner();
    const runMock = runner.run as ReturnType<typeof vi.fn>;
    runMock
      .mockResolvedValueOnce(ok()) // npm outdated
      .mockResolvedValueOnce(ok()) // npm audit
      .mockResolvedValueOnce(ok()) // osv-scanner fix
      .mockResolvedValueOnce(fail('ERESOLVE unable to resolve dependency tree')); // npm update

    const config = baseConfig();

    const result = await runNpmUpdater(runner, config, baseScan(), '/tmp/project');

    expect(result.status).toBe('error');
    expect(result.error).toContain('npm update failed');
    expect(result.validations).toHaveLength(1);
    const v = result.validations[0];
    expect(v.status).toBe('fail');
    expect(v.detail).toContain('npm update failed');
    expect(v.detail).toContain('ERESOLVE unable to resolve dependency tree');
  });

  it('npm update failure => validation name is "build"', async () => {
    const runner = makeRunner();
    const runMock = runner.run as ReturnType<typeof vi.fn>;
    runMock
      .mockResolvedValueOnce(ok()) // npm outdated
      .mockResolvedValueOnce(ok()) // npm audit
      .mockResolvedValueOnce(ok()) // osv-scanner fix
      .mockResolvedValueOnce(fail('network error')); // npm update

    const result = await runNpmUpdater(runner, baseConfig(), baseScan(), '/tmp/project');

    expect(result.validations[0].name).toBe('build');
  });
});
