import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CommandRunner, CommandResult } from '@core/types/common';
import type { UpdateResultJson, ValidationEntry } from '@core/types/update';
import type { ScanResultJson } from '@core/types/scan';
import { PhaseError } from '@core/errors';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@infra/utils/fs-backup', () => ({
  backupFiles: vi.fn(),
  restoreFiles: vi.fn(),
}));

vi.mock('@infra/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    phase: vi.fn(),
    skip: vi.fn(),
    header: vi.fn(),
    tagged: vi.fn(),
  },
}));

import { backupFiles, restoreFiles } from '@infra/utils/fs-backup';
import { runUpdaterLifecycle } from '@modules/ecosystem/utils/updater-lifecycle';
import type { UpdaterRecipe, LifecycleCtx } from '@modules/ecosystem/utils/updater-lifecycle';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const mockBackupFiles = vi.mocked(backupFiles);
const mockRestoreFiles = vi.mocked(restoreFiles);

const FAKE_BACKUPS = new Map([['requirements.txt', 'original content']]);

function ok(stdout = '', stderr = ''): CommandResult {
  return { stdout, stderr, exitCode: 0, command: 'test-cmd', dryRun: false };
}

function fail(stderr = 'command failed'): CommandResult {
  return { stdout: '', stderr, exitCode: 1, command: 'test-cmd', dryRun: false };
}

function makeRunner(overrides: { dryRun?: boolean; run?: ReturnType<typeof vi.fn>; runArgs?: ReturnType<typeof vi.fn> } = {}): CommandRunner {
  const { dryRun = false, run, runArgs } = overrides;
  return {
    run: run ?? vi.fn().mockResolvedValue(ok()),
    runArgs: runArgs ?? vi.fn().mockResolvedValue(ok()),
    dryRun,
    environment: 'local',
  } as unknown as CommandRunner;
}

function makeScan(ecosystemKey = 'test', autoSafePackages: string[] = ['pkg@1.0']): ScanResultJson {
  return {
    $schema: 'osv-scan-result/v1',
    agent: 'osv',
    status: 'success',
    environment: 'local',
    ecosystems: {
      [ecosystemKey]: {
        vulnerabilities_total: 1,
        auto_safe: 1,
        breaking: 0,
        manual: 0,
        auto_safe_packages: autoSafePackages,
        breaking_packages: [],
        manual_packages: [],
        vulnerabilities: [],
      },
    },
    error: null,
  };
}

function makeCtx(runner: CommandRunner, overrides: Partial<LifecycleCtx> = {}): LifecycleCtx {
  return {
    runner,
    cwd: '/tmp/project',
    scanResult: makeScan(),
    ecosystemId: 'test',
    validationCommands: [],
    authorizeBreaking: false,
    ...overrides,
  };
}

function makeRecipe(overrides: Partial<UpdaterRecipe<string>> = {}): UpdaterRecipe<string> {
  return {
    agentName: 'test-agent',
    ecosystemKey: 'test',
    backupPaths: ['test.lock'],
    bootstrapSpec: { binary: 'test-bootstrap', args: ['install'], label: 'test-bootstrap (revert)' },
    applyFix: vi.fn().mockResolvedValue({ ok: true, value: 'fix-result' }),
    ...overrides,
  };
}

const BASE_SUCCESS_SHAPE: Partial<UpdateResultJson> = {
  $schema: 'osv-update-result/v1',
  agent: 'test-agent',
  status: 'success',
  packages_skipped: [],
  error: null,
};

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockBackupFiles.mockResolvedValue(FAKE_BACKUPS);
  mockRestoreFiles.mockResolvedValue(undefined);
});

// ─── (a) dry-run returns base result with skipped validations ─────────────────

describe('runUpdaterLifecycle — dry-run gate', () => {
  it('dry-run returns base result with skipped validations', async () => {
    const runner = makeRunner({ dryRun: true });
    const recipe = makeRecipe();
    const ctx = makeCtx(runner, {
      validationCommands: [{ name: 'tests', command: 'run tests' }],
    });

    const result = await runUpdaterLifecycle(recipe, ctx);

    expect(result.status).toBe('success');
    expect(result.agent).toBe('test-agent');
    expect(result.validations).toHaveLength(1);
    expect(result.validations[0]!.status).toBe('skipped');
    expect(result.validations[0]!.detail).toContain('Dry-run');
    expect(recipe.applyFix).not.toHaveBeenCalled();
    expect(mockBackupFiles).not.toHaveBeenCalled();
  });

  it('dry-run without validationCommands returns no-validation-configured entry', async () => {
    const runner = makeRunner({ dryRun: true });
    const recipe = makeRecipe();
    const ctx = makeCtx(runner, { validationCommands: [] });

    const result = await runUpdaterLifecycle(recipe, ctx);

    expect(result.validations[0]!.status).toBe('skipped');
    expect(result.validations[0]!.detail).toMatch(/no validation commands configured/i);
  });

  it('dry-run returns ecosystem breaking_packages in packages_pending_breaking', async () => {
    const runner = makeRunner({ dryRun: true });
    const scan = makeScan('test', ['pkg@1.0']);
    scan.ecosystems['test']!.breaking_packages = ['break-pkg@2.0'];
    const recipe = makeRecipe({ ecosystemKey: 'test' });
    const ctx = makeCtx(runner, { scanResult: scan });

    const result = await runUpdaterLifecycle(recipe, ctx);

    expect(result.packages_pending_breaking).toEqual(['break-pkg@2.0']);
  });
});

// ─── (b) probe non-null causes early return ────────────────────────────────────

describe('runUpdaterLifecycle — probe hook', () => {
  it('probe non-null causes early return with the probe result', async () => {
    const runner = makeRunner();
    const probeResult: UpdateResultJson = {
      $schema: 'osv-update-result/v1',
      agent: 'test-agent',
      status: 'error',
      packages_updated: [],
      packages_skipped: [],
      packages_pending_breaking: [],
      validations: [{ name: 'validation', status: 'skipped', detail: 'env check failed' }],
      error: 'env check failed',
    };
    const recipe = makeRecipe({
      probe: vi.fn().mockResolvedValue(probeResult),
    });

    const result = await runUpdaterLifecycle(recipe, makeCtx(runner));

    expect(result).toBe(probeResult);
    expect(recipe.applyFix).not.toHaveBeenCalled();
    expect(mockBackupFiles).not.toHaveBeenCalled();
  });

  it('probe returning null continues to main lifecycle', async () => {
    const runner = makeRunner();
    const recipe = makeRecipe({
      probe: vi.fn().mockResolvedValue(null),
    });

    const result = await runUpdaterLifecycle(recipe, makeCtx(runner));

    expect(result.status).toBe('success');
    expect(recipe.applyFix).toHaveBeenCalledOnce();
  });
});

// ─── (c) applyFix ok:false triggers tx.abortWithError ─────────────────────────

describe('runUpdaterLifecycle — applyFix failure', () => {
  it('applyFix ok:false returns status error and calls revert', async () => {
    const runArgsMock = vi.fn().mockResolvedValue(ok()); // bootstrap revert
    const runner = makeRunner({ runArgs: runArgsMock });
    const recipe = makeRecipe({
      applyFix: vi.fn().mockResolvedValue({ ok: false, error: 'fix failed: some error' }),
    });

    const result = await runUpdaterLifecycle(recipe, makeCtx(runner));

    expect(result.status).toBe('error');
    expect(result.error).toBe('fix failed: some error');
    // restoreFiles called (part of revert protocol)
    expect(mockRestoreFiles).toHaveBeenCalled();
  });

  it('applyFix ok:false with no validationStatus uses skipped', async () => {
    const runner = makeRunner();
    const recipe = makeRecipe({
      applyFix: vi.fn().mockResolvedValue({ ok: false, error: 'update failed' }),
    });

    const result = await runUpdaterLifecycle(recipe, makeCtx(runner));

    expect(result.validations[0]!.status).toBe('skipped');
  });

  it('applyFix ok:false with validationStatus:fail uses fail', async () => {
    const runner = makeRunner();
    const recipe = makeRecipe({
      applyFix: vi.fn().mockResolvedValue({ ok: false, error: 'breaking install error', validationStatus: 'fail' }),
    });

    const result = await runUpdaterLifecycle(recipe, makeCtx(runner));

    expect(result.validations[0]!.status).toBe('fail');
  });
});

// ─── (d) preValidation throw triggers tx.abortWithError ───────────────────────

describe('runUpdaterLifecycle — preValidation failure', () => {
  it('preValidation throw triggers abortWithError with fail status', async () => {
    const runArgsMock = vi.fn().mockResolvedValue(ok()); // bootstrap revert
    const runner = makeRunner({ runArgs: runArgsMock });
    const recipe = makeRecipe({
      preValidation: vi.fn().mockRejectedValue(new Error('pre-validation failed: missing deps')),
    });

    const result = await runUpdaterLifecycle(recipe, makeCtx(runner, {
      validationCommands: [{ name: 'tests', command: 'run tests' }],
    }));

    expect(result.status).toBe('error');
    expect(result.error).toBe('pre-validation failed: missing deps');
    expect(result.validations[0]!.status).toBe('fail');
  });

  it('preValidation throw does not run validation commands', async () => {
    const runMock = vi.fn();
    const runner = makeRunner({ run: runMock });
    const recipe = makeRecipe({
      preValidation: vi.fn().mockRejectedValue(new Error('pre-val failed')),
    });

    await runUpdaterLifecycle(recipe, makeCtx(runner, {
      validationCommands: [{ name: 'tests', command: 'run tests' }],
    }));

    expect(runMock).not.toHaveBeenCalled();
  });
});

// ─── (e) validation failure without partialRevert → tx.abortWithError ─────────

describe('runUpdaterLifecycle — validation failure, no partialRevert', () => {
  it('validation failure without partialRevert triggers abortWithError', async () => {
    const runMock = vi.fn().mockResolvedValue(fail('tests failed'));
    const runArgsMock = vi.fn().mockResolvedValue(ok()); // bootstrap revert
    const runner = makeRunner({ run: runMock, runArgs: runArgsMock });
    const recipe = makeRecipe();
    // No partialRevert hook

    const result = await runUpdaterLifecycle(recipe, makeCtx(runner, {
      validationCommands: [{ name: 'tests', command: 'run tests' }],
    }));

    expect(result.status).toBe('error');
    expect(result.error).toContain('Validation failed');
    expect(mockRestoreFiles).toHaveBeenCalled();
  });

  it('validation failure result includes failing validation entry', async () => {
    const runMock = vi.fn().mockResolvedValue(fail('test output'));
    const runner = makeRunner({ run: runMock });
    const recipe = makeRecipe();

    const result = await runUpdaterLifecycle(recipe, makeCtx(runner, {
      validationCommands: [{ name: 'suite', command: 'run suite' }],
    }));

    expect(result.validations[0]!.name).toBe('suite');
    expect(result.validations[0]!.status).toBe('fail');
  });
});

// ─── (f) partialRevert re-validates successfully → success with partial packages ─

describe('runUpdaterLifecycle — partial revert success path', () => {
  it('validation failure with partialRevert that re-validates successfully returns success', async () => {
    // First validation call: fails. After partial revert, re-validation: passes.
    const runMock = vi.fn()
      .mockResolvedValueOnce(fail('first run failed'))  // initial validation
      .mockResolvedValueOnce(ok('tests passed'));        // re-validation after partial revert

    const runArgsMock = vi.fn().mockResolvedValue(ok()); // any runArgs (bootstrap etc.)
    const runner = makeRunner({ run: runMock, runArgs: runArgsMock });
    const recipe = makeRecipe({
      partialRevert: vi.fn().mockResolvedValue({ packagesUpdated: ['pkg@1.0-osv-only'] }),
    });

    const result = await runUpdaterLifecycle(recipe, makeCtx(runner, {
      validationCommands: [{ name: 'tests', command: 'run tests' }],
    }));

    expect(result.status).toBe('success');
    expect(result.packages_updated).toEqual(['pkg@1.0-osv-only']);
    expect(result.validations[0]!.status).toBe('pass');
  });

  it('partial revert path does NOT call tx.abortWithError (no full revert)', async () => {
    const runMock = vi.fn()
      .mockResolvedValueOnce(fail('first fail'))
      .mockResolvedValueOnce(ok('pass'));

    const runArgsMock = vi.fn().mockResolvedValue(ok());
    const runner = makeRunner({ run: runMock, runArgs: runArgsMock });
    const recipe = makeRecipe({
      partialRevert: vi.fn().mockResolvedValue({ packagesUpdated: [] }),
    });

    await runUpdaterLifecycle(recipe, makeCtx(runner, {
      validationCommands: [{ name: 'tests', command: 'run tests' }],
    }));

    // The revert (restoreFiles) should NOT have been called since partial revert succeeded
    expect(mockRestoreFiles).not.toHaveBeenCalled();
  });
});

// ─── (g) partialRevert re-validates unsuccessfully → full revert ───────────────

describe('runUpdaterLifecycle — partial revert then full revert', () => {
  it('validation failure, partialRevert, re-validation also fails → full revert', async () => {
    const runMock = vi.fn()
      .mockResolvedValueOnce(fail('first fail'))    // initial validation
      .mockResolvedValueOnce(fail('still failing')); // re-validation after partial revert

    const runArgsMock = vi.fn().mockResolvedValue(ok()); // bootstrap revert
    const runner = makeRunner({ run: runMock, runArgs: runArgsMock });
    const recipe = makeRecipe({
      partialRevert: vi.fn().mockResolvedValue({ packagesUpdated: ['osv-pkg@1.0'] }),
    });

    const result = await runUpdaterLifecycle(recipe, makeCtx(runner, {
      validationCommands: [{ name: 'tests', command: 'run tests' }],
    }));

    expect(result.status).toBe('error');
    expect(result.error).toContain('Validation failed');
    // Full revert (restoreFiles) is called
    expect(mockRestoreFiles).toHaveBeenCalled();
  });
});

// ─── (h) partialRevert returning null falls through to full revert ─────────────

describe('runUpdaterLifecycle — partialRevert returning null', () => {
  it('partialRevert returning null signals no partial revert available — falls through to full revert', async () => {
    const runMock = vi.fn().mockResolvedValue(fail('validation failed'));
    const runArgsMock = vi.fn().mockResolvedValue(ok()); // bootstrap revert
    const runner = makeRunner({ run: runMock, runArgs: runArgsMock });
    const recipe = makeRecipe({
      partialRevert: vi.fn().mockResolvedValue(null),
    });

    const result = await runUpdaterLifecycle(recipe, makeCtx(runner, {
      validationCommands: [{ name: 'tests', command: 'run tests' }],
    }));

    // Full revert should happen (restoreFiles called)
    expect(result.status).toBe('error');
    expect(mockRestoreFiles).toHaveBeenCalled();
    // Re-validation should NOT have run (runMock called once for first validation only)
    expect(runMock).toHaveBeenCalledOnce();
  });
});

// ─── (h alt) partialRevert throw falls through to PhaseError ──────────────────

describe('runUpdaterLifecycle — partialRevert throw', () => {
  it('partialRevert throw propagates as PhaseError with phase partial-revert-bootstrap', async () => {
    const runMock = vi.fn().mockResolvedValue(fail('validation failed'));
    const runner = makeRunner({ run: runMock });
    const recipe = makeRecipe({
      partialRevert: vi.fn().mockRejectedValue(new Error('bootstrap died')),
    });

    await expect(
      runUpdaterLifecycle(recipe, makeCtx(runner, {
        validationCommands: [{ name: 'tests', command: 'run tests' }],
      })),
    ).rejects.toThrow(/partial-revert/i);
  });

  it('PhaseError from partialRevert has phase=partial-revert-bootstrap', async () => {
    const runMock = vi.fn().mockResolvedValue(fail('fail'));
    const runner = makeRunner({ run: runMock });
    const recipe = makeRecipe({
      partialRevert: vi.fn().mockRejectedValue(new Error('bootstrap connection reset')),
    });

    try {
      await runUpdaterLifecycle(recipe, makeCtx(runner, {
        validationCommands: [{ name: 'tests', command: 'run tests' }],
      }));
      expect.fail('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PhaseError);
      expect((err as PhaseError).phase).toBe('partial-revert-bootstrap');
    }
  });
});

// ─── (i) success path ─────────────────────────────────────────────────────────

describe('runUpdaterLifecycle — success path', () => {
  it('success path returns tx.success result with derivePackagesUpdated result', async () => {
    const runMock = vi.fn().mockResolvedValue(ok('tests passed'));
    const runner = makeRunner({ run: runMock });
    const recipe = makeRecipe({
      derivePackagesUpdated: vi.fn().mockResolvedValue(['pkg@1.1', 'other@2.0']),
    });

    const result = await runUpdaterLifecycle(recipe, makeCtx(runner, {
      validationCommands: [{ name: 'tests', command: 'run tests' }],
    }));

    expect(result.status).toBe('success');
    expect(result.packages_updated).toEqual(['pkg@1.1', 'other@2.0']);
    expect(result.validations[0]!.status).toBe('pass');
    expect(result.error).toBeNull();
  });

  it('success path returns empty packages_updated when derivePackagesUpdated is absent', async () => {
    const runMock = vi.fn().mockResolvedValue(ok());
    const runner = makeRunner({ run: runMock });
    const recipe = makeRecipe();
    // No derivePackagesUpdated hook

    const result = await runUpdaterLifecycle(recipe, makeCtx(runner, {
      validationCommands: [{ name: 'tests', command: 'run tests' }],
    }));

    expect(result.status).toBe('success');
    expect(result.packages_updated).toEqual([]);
  });

  it('success with no validation commands returns skipped entry', async () => {
    const runner = makeRunner();
    const recipe = makeRecipe();

    const result = await runUpdaterLifecycle(recipe, makeCtx(runner, {
      validationCommands: [],
    }));

    expect(result.status).toBe('success');
    expect(result.validations[0]!.status).toBe('skipped');
  });

  it('success path uses $schema osv-update-result/v1 and correct agent', async () => {
    const runner = makeRunner();
    const recipe = makeRecipe({ agentName: 'my-agent' });

    const result = await runUpdaterLifecycle(recipe, makeCtx(runner));

    expect(result.$schema).toBe('osv-update-result/v1');
    expect(result.agent).toBe('my-agent');
  });
});

// ─── (j) unhandled throw wrapped as PhaseError ────────────────────────────────

describe('runUpdaterLifecycle — PhaseError wrapping', () => {
  it('unexpected throw inside applyFix is wrapped as PhaseError', async () => {
    const runner = makeRunner();
    const recipe = makeRecipe({
      applyFix: vi.fn().mockRejectedValue(new Error('disk full')),
    });

    await expect(
      runUpdaterLifecycle(recipe, makeCtx(runner)),
    ).rejects.toThrow(PhaseError);
  });

  it('PhaseError message includes ecosystemKey and original error message', async () => {
    const runner = makeRunner();
    const recipe = makeRecipe({
      ecosystemKey: 'test-eco',
      applyFix: vi.fn().mockRejectedValue(new Error('disk full')),
    });

    try {
      await runUpdaterLifecycle(recipe, makeCtx(runner));
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PhaseError);
      expect((err as PhaseError).message).toContain('test-eco');
      expect((err as PhaseError).message).toContain('disk full');
    }
  });

  it('non-Error thrown is converted via String(err) in PhaseError message', async () => {
    const runner = makeRunner();
    const recipe = makeRecipe({
      applyFix: vi.fn().mockRejectedValue('string-error'),
    });

    await expect(
      runUpdaterLifecycle(recipe, makeCtx(runner)),
    ).rejects.toThrow(/string-error/);
  });

  it('PhaseError thrown from partialRevert does NOT get double-wrapped', async () => {
    const runMock = vi.fn().mockResolvedValue(fail('fail'));
    const runner = makeRunner({ run: runMock });
    const innerPhaseError = new PhaseError('inner phase failed', 'inner-phase');
    const recipe = makeRecipe({
      partialRevert: vi.fn().mockRejectedValue(innerPhaseError),
    });

    try {
      await runUpdaterLifecycle(recipe, makeCtx(runner, {
        validationCommands: [{ name: 'tests', command: 'run tests' }],
      }));
      expect.fail('expected throw');
    } catch (err) {
      // Lifecycle wraps it as PhaseError('partial-revert-bootstrap')
      expect(err).toBeInstanceOf(PhaseError);
      expect((err as PhaseError).phase).toBe('partial-revert-bootstrap');
    }
  });
});

// ─── Scaffold correctness ─────────────────────────────────────────────────────

describe('runUpdaterLifecycle — scaffold', () => {
  it('calls backupFiles with recipe.backupPaths when no preFixBackups provided', async () => {
    const runner = makeRunner();
    const recipe = makeRecipe({ backupPaths: ['custom.lock', 'custom.json'] });

    await runUpdaterLifecycle(recipe, makeCtx(runner));

    expect(mockBackupFiles).toHaveBeenCalledWith(['custom.lock', 'custom.json'], '/tmp/project');
  });

  it('adopts preFixBackups without calling backupFiles when opts.preFixBackups provided', async () => {
    const runner = makeRunner();
    const recipe = makeRecipe();
    const preFixBackups = new Map([['custom.lock', 'content']]);

    await runUpdaterLifecycle(recipe, makeCtx(runner), { preFixBackups });

    expect(mockBackupFiles).not.toHaveBeenCalled();
  });

  it('passes ecosystemKey breaking_packages to base packages_pending_breaking', async () => {
    const runner = makeRunner();
    const scan = makeScan('test');
    scan.ecosystems['test']!.breaking_packages = ['vuln-pkg@1.0', 'vuln-pkg2@3.0'];
    const recipe = makeRecipe({ ecosystemKey: 'test' });

    const result = await runUpdaterLifecycle(recipe, makeCtx(runner, { scanResult: scan }));

    expect(result.packages_pending_breaking).toEqual(['vuln-pkg@1.0', 'vuln-pkg2@3.0']);
  });

  it('uses emptyEcosystem() when ecosystemKey not in scanResult', async () => {
    const runner = makeRunner();
    const scanWithoutKey: ScanResultJson = {
      $schema: 'osv-scan-result/v1',
      agent: 'osv',
      status: 'success',
      environment: 'local',
      ecosystems: {},
      error: null,
    };
    const recipe = makeRecipe({ ecosystemKey: 'missing-eco' });

    const result = await runUpdaterLifecycle(recipe, makeCtx(runner, { scanResult: scanWithoutKey }));

    // Should not throw; base has empty packages_pending_breaking
    expect(result.packages_pending_breaking).toEqual([]);
  });
});

// ─── failIfAllSkipped option ──────────────────────────────────────────────────

describe('runUpdaterLifecycle — failIfAllSkipped option', () => {
  it('failIfAllSkipped:true causes validation failure when no validationCommands configured', async () => {
    const runArgsMock = vi.fn().mockResolvedValue(ok()); // bootstrap revert
    const runner = makeRunner({ runArgs: runArgsMock });
    const recipe = makeRecipe();

    const result = await runUpdaterLifecycle(
      recipe,
      makeCtx(runner, { validationCommands: [] }),
      { failIfAllSkipped: true },
    );

    expect(result.status).toBe('error');
    expect(result.validations[0]!.status).toBe('skipped');
  });

  it('failIfAllSkipped:false (default) allows empty validationCommands to succeed', async () => {
    const runner = makeRunner();
    const recipe = makeRecipe();

    const result = await runUpdaterLifecycle(
      recipe,
      makeCtx(runner, { validationCommands: [] }),
      { failIfAllSkipped: false },
    );

    expect(result.status).toBe('success');
  });
});
