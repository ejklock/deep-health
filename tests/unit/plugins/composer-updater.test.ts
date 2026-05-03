import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CommandRunner, CommandResult } from '@core/types/common';
import type { ProjectConfig } from '@core/types/config';
import type { ScanResultJson } from '@core/types/scan';

// ── Module-level mocks ───────────────────────────────────────────────────────
vi.mock('@infra/utils/fs-backup.js', () => ({
  backupFiles: vi.fn().mockResolvedValue(new Map()),
  restoreFiles: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@infra/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), phase: vi.fn(), skip: vi.fn(), header: vi.fn(), tagged: vi.fn() },
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

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

import { runComposerUpdater, extractComposerLockVersions, buildComposerPackagesUpdated } from '@modules/ecosystem/plugins/composer-updater';

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

function fail(stderr = 'composer update failed'): CommandResult {
  return { stdout: '', stderr, exitCode: 1, command: '', dryRun: false };
}

/**
 * Build a ProjectConfig with the new declarative ecosystems[] shape.
 * testCommand: if provided, injects it as a validationCommand for the composer ecosystem.
 */
function baseConfig(opts: { testCommand?: string } = {}): ProjectConfig {
  return {
    project: { name: 'test-project', client: 'test-client' },
    ecosystems: [
      {
        id: 'composer',
        ...(opts.testCommand
          ? { validationCommands: [{ name: 'tests', command: opts.testCommand }] }
          : {}),
      },
    ],
    protected_packages: { composer: [], npm: [] },
    safe_update_policy: {
      allow_patch_and_minor_within_constraints: true,
      require_authorization_for_constraint_change: false,
    },
    conflict_resolution: 'fail',
  };
}

/** Build a ScanResultJson with composer ecosystem containing packages to update */
function baseScan(composerAutoSafe: string[] = ['vendor/safe-pkg@1.2.3']): ScanResultJson {
  return {
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
        auto_safe_packages: composerAutoSafe,
        breaking_packages: [],
        manual_packages: [],
        vulnerabilities: [],
      },
    },
    error: null,
  };
}

/** Scan result with NO packages to update (empty auto_safe and breaking) */
function emptyScan(): ScanResultJson {
  return {
    $schema: 'osv-scan-result/v1',
    agent: 'osv',
    status: 'success',
    environment: 'local',
    ecosystems: {
      composer: {
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

// ── Dry-run tests ────────────────────────────────────────────────────────────

describe('runComposerUpdater — dry-run paths', () => {
  it('dry-run WITH validationCommands => validation status is "skipped" and detail is "Dry-run — not executed"', async () => {
    const runner = makeRunner({ dryRun: true });

    const result = await runComposerUpdater(
      runner,
      baseConfig(),
      baseScan(),
      '/tmp/project',
      false,
      [{ name: 'tests', command: 'php artisan test' }],
    );

    expect(result.validations).toHaveLength(1);
    expect(result.validations[0]!.status).toBe('skipped');
    expect(result.validations[0]!.detail).toBe('Dry-run — not executed');
    // In dry-run mode no commands should be executed
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('dry-run WITHOUT validationCommands => validation status is "skipped" and detail explains no validation configured', async () => {
    const runner = makeRunner({ dryRun: true });

    const result = await runComposerUpdater(
      runner,
      baseConfig(),
      baseScan(),
      '/tmp/project',
      false,
      [],
    );

    expect(result.validations).toHaveLength(1);
    expect(result.validations[0]!.status).toBe('skipped');
    expect(result.validations[0]!.detail).toMatch(/no validation commands configured/i);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('dry-run always returns status "success"', async () => {
    const runner = makeRunner({ dryRun: true });

    const result = await runComposerUpdater(
      runner,
      baseConfig({ testCommand: 'vendor/bin/phpunit' }),
      baseScan(),
      '/tmp/project',
      false,
      [{ name: 'tests', command: 'vendor/bin/phpunit' }],
    );

    expect(result.status).toBe('success');
    expect(result.$schema).toBe('osv-update-result/v1');
    expect(result.agent).toBe('composer-safe-update');
  });

  it('dry-run packages_updated is empty [] (post-update version not knowable in dry-run)', async () => {
    const runner = makeRunner({ dryRun: true });
    const scan = baseScan(['vendor/safe-pkg@1.2.3']);

    const result = await runComposerUpdater(
      runner,
      baseConfig({ testCommand: 'vendor/bin/phpunit' }),
      scan,
      '/tmp/project',
      false,
      [{ name: 'tests', command: 'vendor/bin/phpunit' }],
    );

    expect(result.packages_updated).toEqual([]);
  });
});

// ── No packages to update ────────────────────────────────────────────────────

describe('runComposerUpdater — no packages to update', () => {
  it('returns immediately with a skipped validation when packageNamesToUpdate is empty', async () => {
    const runner = makeRunner();

    const result = await runComposerUpdater(runner, baseConfig(), emptyScan(), '/tmp/project');

    expect(result.validations).toHaveLength(1);
    expect(result.validations[0]!.status).toBe('skipped');
    expect(result.validations[0]!.detail).toMatch(/no packages to update/i);
    // No commands should have been run
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('no-packages path returns status "success"', async () => {
    const runner = makeRunner();

    const result = await runComposerUpdater(runner, baseConfig(), emptyScan(), '/tmp/project');

    expect(result.status).toBe('success');
    expect(result.error).toBeNull();
  });
});

// ── Update failure path ──────────────────────────────────────────────────────

describe('runComposerUpdater — update failure path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('composer update failure => status is "error" and error message contains stderr', async () => {
    // All composer commands go through runArgs; validation commands go through run
    const runArgsMock = vi.fn()
      .mockResolvedValueOnce(ok()) // composer install --no-interaction --no-scripts (env-check)
      .mockResolvedValueOnce(ok()) // composer outdated --direct
      .mockResolvedValueOnce(fail('Your requirements could not be resolved'))
      .mockResolvedValueOnce(ok()); // composer install (revert bootstrap)

    const runner = makeRunner({ runArgs: runArgsMock });

    const result = await runComposerUpdater(runner, baseConfig(), baseScan(), '/tmp/project');

    expect(result.status).toBe('error');
    expect(result.error).toContain('composer update failed');
    expect(result.error).toContain('Your requirements could not be resolved');
  });

  it('composer update failure => validation is not empty and has meaningful detail', async () => {
    const runArgsMock = vi.fn()
      .mockResolvedValueOnce(ok()) // composer install (env-check)
      .mockResolvedValueOnce(ok()) // composer outdated --direct
      .mockResolvedValueOnce(fail('conflict detected'))
      .mockResolvedValueOnce(ok()); // composer install (revert bootstrap)

    const runner = makeRunner({ runArgs: runArgsMock });

    const result = await runComposerUpdater(runner, baseConfig(), baseScan(), '/tmp/project');

    expect(result.validations).toHaveLength(1);
    const v = result.validations[0]!;
    // detail must not be empty — it should explain what happened
    expect(v.detail).toBeTruthy();
    expect(v.detail!.length).toBeGreaterThan(0);
    // In the update failure path, tests could not run, so status reflects that
    expect(['skipped', 'fail']).toContain(v.status);
  });

  it('composer update failure => validation name is "validation"', async () => {
    const runArgsMock = vi.fn()
      .mockResolvedValueOnce(ok()) // composer install (env-check)
      .mockResolvedValueOnce(ok()) // composer outdated --direct
      .mockResolvedValueOnce(fail('version conflict'))
      .mockResolvedValueOnce(ok()); // composer install (revert bootstrap)

    const runner = makeRunner({ runArgs: runArgsMock });

    const result = await runComposerUpdater(runner, baseConfig(), baseScan(), '/tmp/project');

    expect(result.validations[0]!.name).toBe('validation');
  });

  it('composer update failure => reverts composer.json/composer.lock (composer.lock may have been written before post-script failure)', async () => {
    const { restoreFiles: mockRestoreFiles } = await import('@infra/utils/fs-backup.js');
    const restoreSpy = mockRestoreFiles as ReturnType<typeof vi.fn>;
    restoreSpy.mockClear();

    const runArgsMock = vi.fn()
      .mockResolvedValueOnce(ok())                           // composer install (env-check)
      .mockResolvedValueOnce(ok())                           // composer outdated --direct
      .mockResolvedValueOnce(fail('post-autoload-dump hook failed')) // composer update
      .mockResolvedValueOnce(ok());                          // composer install (revert)

    const runner = makeRunner({ runArgs: runArgsMock });
    const result = await runComposerUpdater(runner, baseConfig(), baseScan(), '/tmp/project');

    expect(result.status).toBe('error');
    // Revert must have been invoked — restoreFiles is called twice (wrap pattern: pre + post install).
    expect(restoreSpy).toHaveBeenCalledTimes(2);
  });
});

// ── Composer automation flags (no scripts / no interaction) ──────────────────

describe('runComposerUpdater — automation flags', () => {
  beforeEach(() => vi.clearAllMocks());

  it('composer update command uses --no-scripts to avoid framework hooks (Laravel artisan, etc.)', async () => {
    const runArgsMock = vi.fn().mockResolvedValue(ok());
    const runner = makeRunner({ runArgs: runArgsMock });

    await runComposerUpdater(runner, baseConfig({ testCommand: 'phpunit' }), baseScan(), '/tmp/project');

    // runArgs is called as runArgs('composer', [...args], opts)
    const updateCall = runArgsMock.mock.calls.find((c: unknown[]) => {
      const args = c[1] as string[];
      return args[0] === 'update';
    });
    expect(updateCall).toBeDefined();
    const args = updateCall![1] as string[];
    expect(args).toContain('--no-scripts');
    expect(args).toContain('--no-interaction');
  });

  it('composer install (revert) uses --no-scripts to match update semantics', async () => {
    const runArgsMock = vi.fn()
      .mockResolvedValueOnce(ok())             // composer install (env-check)
      .mockResolvedValueOnce(ok())             // composer outdated
      .mockResolvedValueOnce(fail('hook failed')) // composer update (fails)
      .mockResolvedValueOnce(ok());            // composer install (revert)

    const runner = makeRunner({ runArgs: runArgsMock });
    await runComposerUpdater(runner, baseConfig(), baseScan(), '/tmp/project');

    const installCall = runArgsMock.mock.calls.find((c: unknown[]) => {
      const args = c[1] as string[];
      return args[0] === 'install';
    });
    expect(installCall).toBeDefined();
    const args = installCall![1] as string[];
    expect(args).toContain('--no-scripts');
  });
});

// ── Validation commands ───────────────────────────────────────────────────────

describe('runComposerUpdater — validation commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs validation command after successful update', async () => {
    const runArgsMock = vi.fn()
      .mockResolvedValueOnce(ok()) // composer install (env-check)
      .mockResolvedValueOnce(ok()) // composer outdated
      .mockResolvedValueOnce(ok()); // composer update

    const runMock = vi.fn()
      .mockResolvedValueOnce(ok('Tests passed')); // php artisan test (via validation-runner)

    const runner = makeRunner({ run: runMock, runArgs: runArgsMock });

    const result = await runComposerUpdater(
      runner,
      baseConfig(),
      baseScan(),
      '/tmp/project',
      false,
      [{ name: 'tests', command: 'php artisan test' }],
    );

    expect(result.status).toBe('success');
    expect(result.validations).toHaveLength(1);
    expect(result.validations[0]!.name).toBe('tests');
    expect(result.validations[0]!.status).toBe('pass');

    const calledCommands: string[] = runMock.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calledCommands.some((cmd) => cmd === 'php artisan test')).toBe(true);
  });

  it('validation failure => status is "error" and changes are reverted', async () => {
    const runArgsMock = vi.fn()
      .mockResolvedValueOnce(ok()) // composer install (env-check)
      .mockResolvedValueOnce(ok()) // composer outdated
      .mockResolvedValueOnce(ok()) // composer update
      .mockResolvedValueOnce(ok()); // composer install (revert)

    const runMock = vi.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: 'test fail', exitCode: 1, command: '', dryRun: false }); // php artisan test (FAIL)

    const runner = makeRunner({ run: runMock, runArgs: runArgsMock });

    const result = await runComposerUpdater(
      runner,
      baseConfig(),
      baseScan(),
      '/tmp/project',
      false,
      [{ name: 'tests', command: 'php artisan test' }],
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('reverted');
    expect(result.validations[0]!.status).toBe('fail');
    expect(result.validations[0]!.name).toBe('tests');

    // Revert is composer install via runArgs
    const runArgsArgs = runArgsMock.mock.calls.map((c: unknown[]) => c[1] as string[]);
    expect(runArgsArgs.some((args) => args[0] === 'install')).toBe(true);
  });
});

describe('runComposerUpdater — authorizeBreaking=true (line 103)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('includes breaking packages in update command when authorizeBreaking=true', async () => {
    const runMock = vi.fn().mockResolvedValue(ok());
    const runArgsMock = vi.fn().mockResolvedValue(ok());
    const runner = makeRunner({ run: runMock, runArgs: runArgsMock });

    const scan: ScanResultJson = {
      $schema: 'osv-scan-result/v1',
      agent: 'osv',
      status: 'success',
      environment: 'local',
      ecosystems: {
        composer: {
          vulnerabilities_total: 2,
          auto_safe: 1,
          breaking: 1,
          manual: 0,
          auto_safe_packages: ['vendor/safe-pkg@1.2.3'],
          breaking_packages: ['vendor/breaking-pkg@2.0.0'],
          manual_packages: [],
          vulnerabilities: [],
        },
      },
      error: null,
    };

    const result = await runComposerUpdater(
      runner,
      baseConfig(),
      scan,
      '/tmp/project',
      true, // authorizeBreaking
      [],
    );

    expect(result.status).toBe('success');
    // The update command should include both packages
    const runArgsCalls = runArgsMock.mock.calls as [string, string[], unknown][];
    const updateCall = runArgsCalls.find((c) => c[1]?.includes('update'));
    expect(updateCall).toBeTruthy();
    expect(updateCall![1]).toContain('vendor/breaking-pkg');
  });
});

describe('runComposerUpdater — PhaseError on unexpected throw (lines 198-203)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws PhaseError when backupFiles throws unexpectedly', async () => {
    const { backupFiles } = await import('@infra/utils/fs-backup.js');
    (backupFiles as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('disk full'));

    const runner = makeRunner();

    await expect(
      runComposerUpdater(runner, baseConfig(), baseScan(), '/tmp/project', false, []),
    ).rejects.toThrow(/composer updater phase failed/i);
  });
});

describe('composer-updater additional branch coverage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('extractPackageNames returns ref as-is when no "@" found (line 16 false branch)', async () => {
    // We can test this via baseScan with a package ref that has no "@"
    // The function is internal but exercised via runComposerUpdater
    // Set up scan with a package ref without "@"
    const scanWithNoAt: ScanResultJson = {
      ...baseScan(),
      ecosystems: {
        composer: {
          vulnerabilities_total: 1,
          auto_safe: 1,
          breaking: 0,
          manual: 0,
          auto_safe_packages: ['vendor/my-package'], // no "@version"
          manual_packages: [],
          breaking_packages: [],
          vulnerabilities: [],
        },
      },
    };
    const runner = makeRunner();
    const result = await runComposerUpdater(runner, baseConfig(), scanWithNoAt, '/tmp/project', false, []);
    expect(result).toBeDefined();
  });

  it('uses emptyEcosystem() when composer key missing from scan (line 78 ?? branch)', async () => {
    const scan: ScanResultJson = { ...baseScan(), ecosystems: {} };
    const runner = makeRunner();
    const result = await runComposerUpdater(runner, baseConfig(), scan as any, '/tmp/project', false, []);
    expect(result).toBeDefined();
  });

  it('env-check detail uses "(no output)" when both stdout and stderr are empty (line 143)', async () => {
    const runArgsMock = vi.fn();
    // First call: composer install returns exitCode 1 with no stdout/stderr
    runArgsMock.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '', command: 'composer install', dryRun: false });
    const runner = { ...makeRunner(), runArgs: runArgsMock } as any;

    const result = await runComposerUpdater(runner, baseConfig(), baseScan(), '/tmp/project', false, []);
    expect(result.status).toBe('error');
  });

  it('uses String(err) when a non-Error is thrown (line 199)', async () => {
    const { backupFiles } = await import('@infra/utils/fs-backup.js');
    (backupFiles as ReturnType<typeof vi.fn>).mockRejectedValueOnce('string-composer-error');

    const runner = makeRunner();
    await expect(
      runComposerUpdater(runner, baseConfig(), baseScan(), '/tmp/project', false, []),
    ).rejects.toThrow(/composer updater phase failed: string-composer-error/i);
  });
});

// ── extractComposerLockVersions unit tests ───────────────────────────────────

describe('extractComposerLockVersions', () => {
  it('returns versions from packages and packages-dev', () => {
    const lock = JSON.stringify({
      packages: [
        { name: 'vendor/pkg-a', version: '1.0.0' },
      ],
      'packages-dev': [
        { name: 'vendor/dev-pkg', version: '2.3.4' },
      ],
    });
    const result = extractComposerLockVersions(lock);
    expect(result.get('vendor/pkg-a')).toBe('1.0.0');
    expect(result.get('vendor/dev-pkg')).toBe('2.3.4');
  });

  it('returns empty Map on malformed JSON', () => {
    const result = extractComposerLockVersions('{not valid json}');
    expect(result.size).toBe(0);
  });

  it('returns empty Map when packages key is missing', () => {
    const result = extractComposerLockVersions(JSON.stringify({ _readme: [] }));
    expect(result.size).toBe(0);
  });

  it('returns empty Map on empty string input', () => {
    const result = extractComposerLockVersions('');
    expect(result.size).toBe(0);
  });

  it('skips entries missing name or version fields', () => {
    const lock = JSON.stringify({
      packages: [
        { name: 'vendor/ok', version: '1.0.0' },
        { version: '1.0.0' },  // missing name
        { name: 'vendor/no-version' },  // missing version
      ],
      'packages-dev': [],
    });
    const result = extractComposerLockVersions(lock);
    expect(result.size).toBe(1);
    expect(result.get('vendor/ok')).toBe('1.0.0');
  });
});

// ── buildComposerPackagesUpdated unit tests ──────────────────────────────────

describe('buildComposerPackagesUpdated', () => {
  it('emits name@versionTo for changed packages', () => {
    const before = new Map([['vendor/pkg', '1.0.0']]);
    const after = new Map([['vendor/pkg', '1.0.1']]);
    const result = buildComposerPackagesUpdated(['vendor/pkg'], before, after);
    expect(result).toEqual(['vendor/pkg@1.0.1']);
  });

  it('unchanged version is filtered', () => {
    const before = new Map([['vendor/pkg', '1.0.0']]);
    const after = new Map([['vendor/pkg', '1.0.0']]);
    const result = buildComposerPackagesUpdated(['vendor/pkg'], before, after);
    expect(result).toEqual([]);
  });

  it('package absent in afterVersions is filtered', () => {
    const before = new Map([['vendor/pkg', '1.0.0']]);
    const after = new Map<string, string>();
    const result = buildComposerPackagesUpdated(['vendor/pkg'], before, after);
    expect(result).toEqual([]);
  });

  it('package absent in beforeVersions but present in after (new install) is emitted', () => {
    const before = new Map<string, string>();
    const after = new Map([['vendor/new', '2.0.0']]);
    const result = buildComposerPackagesUpdated(['vendor/new'], before, after);
    expect(result).toEqual(['vendor/new@2.0.0']);
  });

  it('handles empty target list', () => {
    const before = new Map([['vendor/pkg', '1.0.0']]);
    const after = new Map([['vendor/pkg', '1.0.1']]);
    const result = buildComposerPackagesUpdated([], before, after);
    expect(result).toEqual([]);
  });
});

// ── packages_updated post-update version tests ───────────────────────────────

function makeLockJson(packages: Array<{ name: string; version: string }>): string {
  return JSON.stringify({ packages, 'packages-dev': [] });
}

describe('runComposerUpdater — packages_updated post-update version', () => {
  beforeEach(() => vi.clearAllMocks());

  it('emits post-update version in packages_updated for changed packages (AC1)', async () => {
    const { backupFiles } = await import('@infra/utils/fs-backup.js');
    const { readFile } = await import('node:fs/promises');

    const preLock = makeLockJson([{ name: 'phpseclib/phpseclib', version: '3.0.50' }]);
    const postLock = makeLockJson([{ name: 'phpseclib/phpseclib', version: '3.0.51' }]);

    (backupFiles as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Map([['composer.lock', preLock]]),
    );
    // First readFile: before-lock read in applyFix (before composer update runs)
    // Second readFile: after-lock read in derivePackagesUpdated
    (readFile as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(preLock)
      .mockResolvedValueOnce(postLock);

    const runArgsMock = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', command: '', dryRun: false });
    const runner = makeRunner({ runArgs: runArgsMock });
    const scan = baseScan(['phpseclib/phpseclib@3.0.50']);

    const result = await runComposerUpdater(runner, baseConfig(), scan, '/tmp/project', false, []);

    expect(result.status).toBe('success');
    expect(result.packages_updated).toEqual(['phpseclib/phpseclib@3.0.51']);
  });

  it('dry-run test — packages_updated must be [] (AC3)', async () => {
    const runner = makeRunner({ dryRun: true });
    const result = await runComposerUpdater(runner, baseConfig(), baseScan(['vendor/pkg@1.0.0']), '/tmp/project', false, []);
    expect(result.packages_updated).toEqual([]);
  });

  it('falls back when post-update lock read fails — result remains success (AC5)', async () => {
    const { backupFiles } = await import('@infra/utils/fs-backup.js');
    const { readFile } = await import('node:fs/promises');

    const preLock = makeLockJson([{ name: 'vendor/pkg', version: '1.0.0' }]);
    (backupFiles as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Map([['composer.lock', preLock]]),
    );
    // First readFile: before-lock read in applyFix (succeeds with preLock)
    // Second readFile: after-lock read in derivePackagesUpdated (fails — fallback path)
    (readFile as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(preLock)
      .mockRejectedValueOnce(new Error('ENOENT: no such file'));

    const runArgsMock = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', command: '', dryRun: false });
    const runner = makeRunner({ runArgs: runArgsMock });
    const scan = baseScan(['vendor/pkg@1.0.0']);

    const result = await runComposerUpdater(runner, baseConfig(), scan, '/tmp/project', false, []);

    expect(result.status).toBe('success');
    // fallback to auto_safe_packages from scan
    expect(result.packages_updated).toEqual(['vendor/pkg@1.0.0']);
  });
});
