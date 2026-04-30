import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CommandRunner, CommandResult } from '@core/types/common';
import type { ProjectConfig } from '@core/types/config';
import type { ScanResultJson } from '@core/types/scan';

// ── Module-level mocks ───────────────────────────────────────────────────────
vi.mock('@infra/utils/git.js', () => ({
  backupFiles: vi.fn().mockResolvedValue(new Map()),
  restoreFiles: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@infra/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), phase: vi.fn(), skip: vi.fn(), header: vi.fn() },
}));

vi.mock('@core/types/scan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/types/scan.js')>();
  return {
    ...actual,
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
  };
});

import { runPipUpdater, stripPipVersion } from '@modules/ecosystem/plugins/pip-updater';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRunner(overrides: { dryRun?: boolean; run?: ReturnType<typeof vi.fn>; runArgs?: ReturnType<typeof vi.fn> } = {}): CommandRunner {
  const { dryRun = false, run, runArgs } = overrides;
  return {
    run: run ?? vi.fn().mockResolvedValue(ok()),
    runArgs: runArgs ?? vi.fn().mockResolvedValue(ok()),
    dryRun,
    environment: 'local',
  } as unknown as CommandRunner;
}

function ok(stdout = '', stderr = ''): CommandResult {
  return { stdout, stderr, exitCode: 0, command: '', dryRun: false };
}

function fail(stderr = 'pip install failed'): CommandResult {
  return { stdout: '', stderr, exitCode: 1, command: '', dryRun: false };
}

function baseConfig(): ProjectConfig {
  return {
    project: { name: 'test-project', client: 'test-client' },
    ecosystems: [{ id: 'pip' }],
    protected_packages: { pip: [], npm: [], composer: [] },
    safe_update_policy: {
      allow_patch_and_minor_within_constraints: true,
      require_authorization_for_constraint_change: false,
    },
    conflict_resolution: 'fail',
  };
}

function baseScan(pipAutoSafe: string[] = ['requests@2.31']): ScanResultJson {
  return {
    $schema: 'osv-scan-result/v1',
    agent: 'osv',
    status: 'success',
    environment: 'local',
    ecosystems: {
      pip: {
        vulnerabilities_total: 1,
        auto_safe: 1,
        breaking: 0,
        manual: 0,
        auto_safe_packages: pipAutoSafe,
        breaking_packages: [],
        manual_packages: [],
        vulnerabilities: [],
      },
    },
    error: null,
  };
}

function emptyScan(): ScanResultJson {
  return {
    $schema: 'osv-scan-result/v1',
    agent: 'osv',
    status: 'success',
    environment: 'local',
    ecosystems: {
      pip: {
        vulnerabilities_total: 0,
        auto_safe: 0,
        breaking: 0,
        manual: 0,
        auto_safe_packages: [],
        breaking_packages: [],
        manual_packages: [],
        vulnerabilities: [],
      },
    },
    error: null,
  };
}

function scanWithBreaking(breaking: string[] = ['django@4.0']): ScanResultJson {
  return {
    $schema: 'osv-scan-result/v1',
    agent: 'osv',
    status: 'success',
    environment: 'local',
    ecosystems: {
      pip: {
        vulnerabilities_total: 2,
        auto_safe: 1,
        breaking: 1,
        manual: 0,
        auto_safe_packages: ['requests@2.31'],
        breaking_packages: breaking,
        manual_packages: [],
        vulnerabilities: [],
      },
    },
    error: null,
  };
}

// ── (a) No packages to update ────────────────────────────────────────────────

describe('runPipUpdater — no packages to update', () => {
  it('returns immediately with a skipped validation when packageNamesToUpdate is empty', async () => {
    const runner = makeRunner();
    const result = await runPipUpdater(runner, baseConfig(), emptyScan(), '/tmp/project');
    expect(result.validations).toHaveLength(1);
    expect(result.validations[0]!.status).toBe('skipped');
    expect(result.validations[0]!.detail).toMatch(/no packages to update/i);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('no-packages path returns status "success"', async () => {
    const runner = makeRunner();
    const result = await runPipUpdater(runner, baseConfig(), emptyScan(), '/tmp/project');
    expect(result.status).toBe('success');
    expect(result.error).toBeNull();
  });
});

// ── (b) Dry-run ───────────────────────────────────────────────────────────────

describe('runPipUpdater — dry-run paths', () => {
  it('dry-run WITH validationCommands => validation status is "skipped" and detail is "Dry-run — not executed"', async () => {
    const runner = makeRunner({ dryRun: true });
    const result = await runPipUpdater(
      runner,
      baseConfig(),
      baseScan(),
      '/tmp/project',
      false,
      [{ name: 'check', command: 'pip check' }],
    );
    expect(result.validations).toHaveLength(1);
    expect(result.validations[0]!.status).toBe('skipped');
    expect(result.validations[0]!.detail).toBe('Dry-run — not executed');
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('dry-run WITHOUT validationCommands => validation status is "skipped" with no-validation detail', async () => {
    const runner = makeRunner({ dryRun: true });
    const result = await runPipUpdater(runner, baseConfig(), baseScan(), '/tmp/project', false, []);
    expect(result.validations[0]!.status).toBe('skipped');
    expect(result.validations[0]!.detail).toMatch(/no validation commands configured/i);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('dry-run always returns status "success" and agent "pip-safe-update"', async () => {
    const runner = makeRunner({ dryRun: true });
    const result = await runPipUpdater(runner, baseConfig(), baseScan(), '/tmp/project');
    expect(result.status).toBe('success');
    expect(result.agent).toBe('pip-safe-update');
    expect(result.$schema).toBe('osv-update-result/v1');
  });

  it('dry-run packages_updated reflects auto_safe_packages from scan', async () => {
    const runner = makeRunner({ dryRun: true });
    const scan = baseScan(['requests@2.31']);
    const result = await runPipUpdater(runner, baseConfig(), scan, '/tmp/project', false, [{ name: 'check', command: 'pip check' }]);
    expect(result.packages_updated).toEqual(['requests@2.31']);
  });
});

// ── (c) Happy path ────────────────────────────────────────────────────────────

describe('runPipUpdater — happy path', () => {
  beforeEach(() => vi.clearAllMocks());

  it('runs validation command after successful update and returns status "success"', async () => {
    const runMock = vi.fn()
      .mockResolvedValueOnce(ok('No broken packages')); // pip check (validation)

    const runArgsMock = vi.fn()
      .mockResolvedValueOnce(ok()) // pip list --outdated
      .mockResolvedValueOnce(ok('Successfully installed')); // pip install -U

    const runner = makeRunner({ run: runMock, runArgs: runArgsMock });

    const result = await runPipUpdater(
      runner,
      baseConfig(),
      baseScan(),
      '/tmp/project',
      false,
      [{ name: 'check', command: 'pip check' }],
    );

    expect(result.status).toBe('success');
    expect(result.validations).toHaveLength(1);
    expect(result.validations[0]!.name).toBe('check');
    expect(result.validations[0]!.status).toBe('pass');
  });
});

// ── (d) pip install -U fails ─────────────────────────────────────────────────

describe('runPipUpdater — update failure path', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pip install -U failure => status is "error" and error message contains stderr', async () => {
    const runMock = vi.fn(); // no pip list --outdated here

    const runArgsMock = vi.fn()
      .mockResolvedValueOnce(ok()) // pip list --outdated
      .mockResolvedValueOnce(fail('Could not find a version that satisfies the requirement')) // pip install -U
      .mockResolvedValueOnce(ok()); // pip install -r requirements.txt (revert)

    const runner = makeRunner({ run: runMock, runArgs: runArgsMock });
    const result = await runPipUpdater(runner, baseConfig(), baseScan(), '/tmp/project');

    expect(result.status).toBe('error');
    expect(result.error).toContain('pip install -U failed');
    expect(result.error).toContain('Could not find a version that satisfies');
  });

  it('pip install -U failure => validations are skipped', async () => {
    const runMock = vi.fn(); // no pip list --outdated

    const runArgsMock = vi.fn()
      .mockResolvedValueOnce(ok()) // pip list --outdated
      .mockResolvedValueOnce(fail('conflict')) // pip install -U
      .mockResolvedValueOnce(ok()); // pip install -r requirements.txt (revert)

    const runner = makeRunner({ run: runMock, runArgs: runArgsMock });
    const result = await runPipUpdater(runner, baseConfig(), baseScan(), '/tmp/project');

    expect(result.validations[0]!.status).toBe('skipped');
  });

  it('pip install -U failure => reverts requirements.txt (revert wraps pip install with restore-twice)', async () => {
    const { restoreFiles: mockRestoreFiles } = await import('@infra/utils/git.js');
    const restoreSpy = mockRestoreFiles as ReturnType<typeof vi.fn>;
    restoreSpy.mockClear();

    const runMock = vi.fn(); // no pip list --outdated

    const runArgsMock = vi.fn()
      .mockResolvedValueOnce(ok()) // pip list --outdated
      .mockResolvedValueOnce(fail('resolver error'))      // pip install -U
      .mockResolvedValueOnce(ok());                       // pip install -r requirements.txt (revert)

    const runner = makeRunner({ run: runMock, runArgs: runArgsMock });
    const result = await runPipUpdater(runner, baseConfig(), baseScan(), '/tmp/project');

    expect(result.status).toBe('error');
    // Revert path runs restoreFiles twice (wrap pattern: pre + post pip install).
    expect(restoreSpy).toHaveBeenCalledTimes(2);
  });
});

// ── (e) Validation fails ──────────────────────────────────────────────────────

describe('runPipUpdater — validation failure path', () => {
  beforeEach(() => vi.clearAllMocks());

  it('validation failure => status is "error", changes reverted, pip install -r requirements.txt called', async () => {
    const runMock = vi.fn()
      .mockResolvedValueOnce(fail('pip check failed')); // pip check (FAIL via validation-runner)

    const runArgsMock = vi.fn()
      .mockResolvedValueOnce(ok()) // pip list --outdated
      .mockResolvedValueOnce(ok()) // pip install -U
      .mockResolvedValueOnce(ok()); // pip install -r requirements.txt (revert)

    const runner = makeRunner({ run: runMock, runArgs: runArgsMock });

    const result = await runPipUpdater(
      runner,
      baseConfig(),
      baseScan(),
      '/tmp/project',
      false,
      [{ name: 'check', command: 'pip check' }],
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('reverted');
    expect(result.validations[0]!.status).toBe('fail');
    expect(result.validations[0]!.name).toBe('check');

    // Revert pip install -r requirements.txt is called via runArgs
    const runArgsCommands = runArgsMock.mock.calls.map((c: unknown[]) => [String(c[0]), ...(c[1] as string[])].join(' '));
    expect(runArgsCommands.some((cmd) => cmd.includes('pip install -r requirements.txt'))).toBe(true);
  });
});

// ── (f) authorizeBreaking=true ────────────────────────────────────────────────

describe('runPipUpdater — authorizeBreaking=true', () => {
  beforeEach(() => vi.clearAllMocks());

  it('includes both auto_safe and breaking packages in update command', async () => {
    const runMock = vi.fn()
      .mockResolvedValueOnce(ok()); // pip check (validation)

    const runArgsMock = vi.fn()
      .mockResolvedValueOnce(ok()) // pip list --outdated
      .mockResolvedValueOnce(ok()); // pip install -U

    const runner = makeRunner({ run: runMock, runArgs: runArgsMock });

    await runPipUpdater(
      runner,
      baseConfig(),
      scanWithBreaking(['django@4.0']),
      '/tmp/project',
      true,
      [{ name: 'check', command: 'pip check' }],
    );

    // runArgs is called as runArgs('pip', ['install', '-U', ...pkgs], ...)
    // call[0] is pip list --outdated, call[1] is pip install -U
    const runArgsArgs = runArgsMock.mock.calls[1] as [string, string[], unknown];
    expect(runArgsArgs[0]).toBe('pip');
    expect(runArgsArgs[1]).toContain('install');
    expect(runArgsArgs[1]).toContain('-U');
    expect(runArgsArgs[1]).toContain('requests');
    expect(runArgsArgs[1]).toContain('django');
  });
});

// ── (g) stripPipVersion unit tests ────────────────────────────────────────────

describe('stripPipVersion', () => {
  it('strips ==version specifier', () => {
    expect(stripPipVersion('requests==2.31')).toBe('requests');
  });

  it('strips >=version specifier', () => {
    expect(stripPipVersion('requests>=2.0')).toBe('requests');
  });

  it('strips ~=version specifier', () => {
    expect(stripPipVersion('requests~=2.0')).toBe('requests');
  });

  it('strips !=version specifier', () => {
    expect(stripPipVersion('requests!=1.0')).toBe('requests');
  });

  it('strips <version specifier', () => {
    expect(stripPipVersion('requests<3')).toBe('requests');
  });

  it('strips extras and ==version', () => {
    expect(stripPipVersion('requests[security]==2.31')).toBe('requests');
  });

  it('strips @version specifier', () => {
    expect(stripPipVersion('requests@1.0')).toBe('requests');
  });

  it('returns bare package name unchanged', () => {
    expect(stripPipVersion('requests')).toBe('requests');
  });

  it('strips multi-extra brackets and >=version', () => {
    expect(stripPipVersion('pkg[a,b]>=1')).toBe('pkg');
  });
});

describe('runPipUpdater — revert pip install fails (lines 55-66)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('logs error when pip install -r requirements.txt during revert exits non-zero', async () => {
    const runMock = vi.fn()
      .mockResolvedValueOnce(fail('pip check failed'));

    const runArgsMock = vi.fn()
      .mockResolvedValueOnce(ok())              // pip list --outdated
      .mockResolvedValueOnce(ok())              // pip install -U
      .mockResolvedValueOnce(fail('revert err', 1)); // pip install -r requirements.txt (revert FAILS)

    const runner = makeRunner({ run: runMock, runArgs: runArgsMock });

    const result = await runPipUpdater(
      runner,
      baseConfig(),
      baseScan(),
      '/tmp/project',
      false,
      [{ name: 'check', command: 'pip check' }],
    );

    // The updater should still return an error result (validation failed)
    expect(result.status).toBe('error');
    const { logger: mockLogger } = await import('@infra/utils/logger.js');
    const errorCalls = (mockLogger.error as ReturnType<typeof vi.fn>).mock.calls;
    expect(errorCalls.some((c) => String(c[0]).includes('requirements.txt (revert) failed!'))).toBe(true);
  });
});

describe('runPipUpdater — unexpected error triggers PhaseError (lines 186-191)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws PhaseError when backupFiles throws unexpectedly', async () => {
    const { backupFiles } = await import('@infra/utils/git.js');
    (backupFiles as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('disk full'));

    const runner = makeRunner();

    await expect(
      runPipUpdater(
        runner,
        baseConfig(),
        baseScan(),
        '/tmp/project',
        false,
        [],
      ),
    ).rejects.toThrow('pip updater phase failed');
  });
});

describe('pip-updater additional branch coverage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pip ecosystem uses emptyEcosystem() when pip key missing from scan (line 84 ?? branch)', async () => {
    const runner = makeRunner();
    // Use a scan with no pip ecosystem
    const scan: ScanResultJson = {
      ...baseScan(),
      ecosystems: {}, // no 'pip' key
    };
    // Should not throw — just returns no-op result with no updates
    const result = await runPipUpdater(runner, baseConfig(), scan as any, '/tmp/project', false, []);
    expect(result).toBeDefined();
  });

  it('uses String(err) when a non-Error is thrown during pip updater (line 187)', async () => {
    const { backupFiles } = await import('@infra/utils/git.js');
    (backupFiles as ReturnType<typeof vi.fn>).mockRejectedValueOnce('string-error');

    const runner = makeRunner();
    await expect(
      runPipUpdater(runner, baseConfig(), baseScan(), '/tmp/project', false, []),
    ).rejects.toThrow('pip updater phase failed: string-error');
  });
});
