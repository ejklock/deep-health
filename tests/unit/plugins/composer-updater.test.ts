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
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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

import { runComposerUpdater } from '@modules/ecosystem/plugins/composer-updater';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRunner(overrides: { dryRun?: boolean; run?: ReturnType<typeof vi.fn> } = {}): CommandRunner {
  const { dryRun = false, run } = overrides;
  return {
    run: run ?? vi.fn().mockResolvedValue(ok()),
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

  it('dry-run packages_updated reflects auto_safe_packages from scan', async () => {
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

    expect(result.packages_updated).toEqual(['vendor/safe-pkg@1.2.3']);
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
    // Sequence: composer outdated (ok), composer update (FAIL)
    const runMock = vi.fn()
      .mockResolvedValueOnce(ok()) // composer outdated --direct
      .mockResolvedValueOnce(fail('Your requirements could not be resolved'));

    const runner = makeRunner({ run: runMock });

    const result = await runComposerUpdater(runner, baseConfig(), baseScan(), '/tmp/project');

    expect(result.status).toBe('error');
    expect(result.error).toContain('composer update failed');
    expect(result.error).toContain('Your requirements could not be resolved');
  });

  it('composer update failure => validation is not empty and has meaningful detail', async () => {
    const runMock = vi.fn()
      .mockResolvedValueOnce(ok()) // composer outdated --direct
      .mockResolvedValueOnce(fail('conflict detected'));

    const runner = makeRunner({ run: runMock });

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
    const runMock = vi.fn()
      .mockResolvedValueOnce(ok()) // composer outdated --direct
      .mockResolvedValueOnce(fail('version conflict'));

    const runner = makeRunner({ run: runMock });

    const result = await runComposerUpdater(runner, baseConfig(), baseScan(), '/tmp/project');

    expect(result.validations[0]!.name).toBe('validation');
  });

  it('composer update failure => reverts composer.json/composer.lock (composer.lock may have been written before post-script failure)', async () => {
    const { restoreFiles: mockRestoreFiles } = await import('@infra/utils/git.js');
    const restoreSpy = mockRestoreFiles as ReturnType<typeof vi.fn>;
    restoreSpy.mockClear();

    const runMock = vi.fn()
      .mockResolvedValueOnce(ok())                           // composer outdated --direct
      .mockResolvedValueOnce(fail('post-autoload-dump hook failed')) // composer update
      .mockResolvedValueOnce(ok());                          // composer install (revert)

    const runner = makeRunner({ run: runMock });
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
    const runMock = vi.fn().mockResolvedValue(ok());
    const runner = makeRunner({ run: runMock });

    await runComposerUpdater(runner, baseConfig({ testCommand: 'phpunit' }), baseScan(), '/tmp/project');

    const updateCall = runMock.mock.calls.find((c: unknown[]) => String(c[0]).startsWith('composer update'));
    expect(updateCall).toBeDefined();
    expect(String(updateCall![0])).toContain('--no-scripts');
    expect(String(updateCall![0])).toContain('--no-interaction');
  });

  it('composer install (revert) uses --no-scripts to match update semantics', async () => {
    const runMock = vi.fn()
      .mockResolvedValueOnce(ok())                          // composer outdated
      .mockResolvedValueOnce(fail('hook failed'))           // composer update (fails)
      .mockResolvedValueOnce(ok());                         // composer install (revert)

    const runner = makeRunner({ run: runMock });
    await runComposerUpdater(runner, baseConfig(), baseScan(), '/tmp/project');

    const installCall = runMock.mock.calls.find((c: unknown[]) => String(c[0]).startsWith('composer install'));
    expect(installCall).toBeDefined();
    expect(String(installCall![0])).toContain('--no-scripts');
  });
});

// ── Validation commands ───────────────────────────────────────────────────────

describe('runComposerUpdater — validation commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs validation command after successful update', async () => {
    const runMock = vi.fn()
      .mockResolvedValueOnce(ok()) // composer outdated
      .mockResolvedValueOnce(ok()) // composer update
      .mockResolvedValueOnce(ok('Tests passed')); // php artisan test

    const runner = makeRunner({ run: runMock });

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
    const runMock = vi.fn()
      .mockResolvedValueOnce(ok()) // composer outdated
      .mockResolvedValueOnce(ok()) // composer update
      .mockResolvedValueOnce({ stdout: '', stderr: 'test fail', exitCode: 1, command: '', dryRun: false }) // php artisan test (FAIL)
      .mockResolvedValueOnce(ok()); // composer install (revert)

    const runner = makeRunner({ run: runMock });

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

    const calledCommands: string[] = runMock.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calledCommands.some((cmd) => cmd.includes('composer install'))).toBe(true);
  });
});
