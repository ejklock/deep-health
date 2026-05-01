import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UpdateResultJson, ValidationEntry } from '@core/types/update';
import type { CommandRunner, CommandResult } from '@core/types/common';

// ─── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@infra/utils/git', () => ({
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

// node:fs/promises — only readFile is needed for dirty-tree check
const { mockReadFile } = vi.hoisted(() => ({ mockReadFile: vi.fn() }));
vi.mock('node:fs/promises', () => ({ readFile: mockReadFile }));

import { backupFiles, restoreFiles } from '@infra/utils/git';
import { logger } from '@infra/utils/logger';
import { beginUpdaterTransaction } from '@modules/ecosystem/utils/updater-transaction';
import type { BootstrapSpec } from '@modules/ecosystem/utils/updater-transaction';

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const mockBackupFiles = vi.mocked(backupFiles);
const mockRestoreFiles = vi.mocked(restoreFiles);

const BASE: UpdateResultJson = {
  $schema: 'osv-update-result/v1',
  agent: 'test-agent',
  status: 'success',
  packages_updated: [],
  packages_skipped: [],
  packages_pending_breaking: [],
  validations: [{ name: 'validation', status: 'skipped', detail: 'none' }],
  error: null,
};

const SKIPPED_ENTRIES: ValidationEntry[] = [
  { name: 'validation', status: 'skipped', detail: 'none' },
];

const PASS_ENTRIES: ValidationEntry[] = [
  { name: 'lint', status: 'pass', detail: 'passed' },
];

const FAIL_ENTRIES: ValidationEntry[] = [
  { name: 'lint', status: 'fail', detail: 'failed' },
];

const FAKE_BACKUPS = new Map([['requirements.txt', 'original content']]);

function ok(stdout = '', stderr = ''): CommandResult {
  return { stdout, stderr, exitCode: 0, command: 'test-cmd', dryRun: false };
}

function fail(stderr = 'bootstrap failed'): CommandResult {
  return { stdout: '', stderr, exitCode: 1, command: 'test-cmd', dryRun: false };
}

function makeRunner(overrides: Partial<{ runArgs: ReturnType<typeof vi.fn> }> = {}): CommandRunner {
  return {
    run: vi.fn().mockResolvedValue(ok()),
    runArgs: overrides.runArgs ?? vi.fn().mockResolvedValue(ok()),
    dryRun: false,
    environment: 'local',
  } as unknown as CommandRunner;
}

const BOOTSTRAP_SPEC: BootstrapSpec = {
  binary: 'npm',
  args: ['ci'],
  label: 'npm ci (revert)',
};

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('beginUpdaterTransaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBackupFiles.mockResolvedValue(FAKE_BACKUPS);
    mockRestoreFiles.mockResolvedValue(undefined);
  });

  it('calls backupFiles with files + cwd when no preExistingBackups', async () => {
    const runner = makeRunner();
    const tx = await beginUpdaterTransaction({
      files: ['requirements.txt'],
      base: BASE,
      cwd: '/project',
      runner,
      bootstrapSpec: BOOTSTRAP_SPEC,
    });

    expect(mockBackupFiles).toHaveBeenCalledOnce();
    expect(mockBackupFiles).toHaveBeenCalledWith(['requirements.txt'], '/project');
    expect(tx.backups).toBe(FAKE_BACKUPS);
  });

  it('adopts preExistingBackups without calling backupFiles', async () => {
    const preExisting = new Map([['package-lock.json', 'lock content']]);
    const runner = makeRunner();

    const tx = await beginUpdaterTransaction({
      files: ['package.json'],
      base: BASE,
      cwd: '/project',
      runner,
      bootstrapSpec: BOOTSTRAP_SPEC,
      preExistingBackups: preExisting,
    });

    expect(mockBackupFiles).not.toHaveBeenCalled();
    expect(tx.backups).toBe(preExisting);
  });

  describe('success()', () => {
    it('returns base spread with packages_updated and validations', async () => {
      const runner = makeRunner();
      const tx = await beginUpdaterTransaction({
        files: [],
        base: BASE,
        cwd: '/project',
        runner,
        bootstrapSpec: BOOTSTRAP_SPEC,
      });

      const result = tx.success({
        packages_updated: ['requests==2.32.0'],
        validations: PASS_ENTRIES,
      });

      expect(result).toEqual({
        ...BASE,
        packages_updated: ['requests==2.32.0'],
        validations: PASS_ENTRIES,
      });
    });

    it('does not mutate the base object', async () => {
      const base: UpdateResultJson = { ...BASE };
      const runner = makeRunner();
      const tx = await beginUpdaterTransaction({
        files: [],
        base,
        cwd: '/project',
        runner,
        bootstrapSpec: BOOTSTRAP_SPEC,
      });

      tx.success({ packages_updated: ['pkg'], validations: PASS_ENTRIES });

      expect(base.packages_updated).toEqual([]);
      expect(base.validations).toEqual(BASE.validations);
    });
  });

  describe('abortWithError()', () => {
    // ── AC2: bootstrap is run via runner.runArgs with stream:true ──────────────

    it('abortWithError runs bootstrap via runner.runArgs with stream:true', async () => {
      const runArgsMock = vi.fn().mockResolvedValue(ok());
      const runner = makeRunner({ runArgs: runArgsMock });

      const tx = await beginUpdaterTransaction({
        files: [],
        base: BASE,
        cwd: '/project',
        runner,
        bootstrapSpec: BOOTSTRAP_SPEC,
      });

      await tx.abortWithError({ error: 'something broke', validations: FAIL_ENTRIES });

      const ciCalls = runArgsMock.mock.calls.filter(
        ([binary, args]: [string, string[]]) => binary === 'npm' && args[0] === 'ci',
      );
      expect(ciCalls).toHaveLength(1);
      expect(ciCalls[0]![2]).toMatchObject({ stream: true });
    });

    it('abortWithError passes bootstrapSpec binary and args to runner.runArgs', async () => {
      const spec: BootstrapSpec = {
        binary: 'composer',
        args: ['install', '--no-interaction', '--no-scripts'],
        label: 'composer install (revert)',
      };
      const runArgsMock = vi.fn().mockResolvedValue(ok());
      const runner = makeRunner({ runArgs: runArgsMock });

      const tx = await beginUpdaterTransaction({
        files: [],
        base: BASE,
        cwd: '/project',
        runner,
        bootstrapSpec: spec,
      });

      await tx.abortWithError({ error: 'err', validations: FAIL_ENTRIES });

      const composerCalls = runArgsMock.mock.calls.filter(
        ([binary]: [string]) => binary === 'composer',
      );
      expect(composerCalls).toHaveLength(1);
      expect(composerCalls[0]![1]).toEqual(['install', '--no-interaction', '--no-scripts']);
    });

    // ── AC3: restoreFiles called twice around bootstrap ────────────────────────

    it('abortWithError calls restoreFiles twice around bootstrap (byte-identical guarantee)', async () => {
      const restoreOrder: string[] = [];
      const runArgsMock = vi.fn().mockImplementation(async () => {
        restoreOrder.push('bootstrap');
        return ok();
      });
      mockRestoreFiles.mockImplementation(async () => {
        restoreOrder.push('restore');
      });

      const runner = makeRunner({ runArgs: runArgsMock });

      const tx = await beginUpdaterTransaction({
        files: [],
        base: BASE,
        cwd: '/project',
        runner,
        bootstrapSpec: BOOTSTRAP_SPEC,
      });

      await tx.abortWithError({ error: 'err', validations: FAIL_ENTRIES });

      expect(mockRestoreFiles).toHaveBeenCalledTimes(2);
      expect(restoreOrder).toEqual(['restore', 'bootstrap', 'restore']);
    });

    it('restoreFiles is called with the transaction backups and cwd on both invocations', async () => {
      const preExisting = new Map([['package.json', '{}']]);
      const runArgsMock = vi.fn().mockResolvedValue(ok());
      const runner = makeRunner({ runArgs: runArgsMock });

      const tx = await beginUpdaterTransaction({
        files: [],
        base: BASE,
        cwd: '/my/project',
        runner,
        bootstrapSpec: BOOTSTRAP_SPEC,
        preExistingBackups: preExisting,
      });

      await tx.abortWithError({ error: 'err', validations: FAIL_ENTRIES });

      expect(mockRestoreFiles).toHaveBeenNthCalledWith(1, preExisting, '/my/project');
      expect(mockRestoreFiles).toHaveBeenNthCalledWith(2, preExisting, '/my/project');
    });

    // ── AC4: bootstrap exit != 0 throws ───────────────────────────────────────

    it('abortWithError throws when bootstrap exits non-zero', async () => {
      const runArgsMock = vi.fn().mockResolvedValue(fail('peer dep conflict'));
      const runner = makeRunner({ runArgs: runArgsMock });

      const tx = await beginUpdaterTransaction({
        files: [],
        base: BASE,
        cwd: '/project',
        runner,
        bootstrapSpec: BOOTSTRAP_SPEC,
      });

      await expect(
        tx.abortWithError({ error: 'something broke', validations: FAIL_ENTRIES }),
      ).rejects.toThrow(/npm ci \(revert\)/i);
    });

    it('abortWithError throw message includes the bootstrap label', async () => {
      const spec: BootstrapSpec = {
        binary: 'pip',
        args: ['install', '-r', 'requirements.txt'],
        label: 'pip install -r requirements.txt (revert)',
      };
      const runArgsMock = vi.fn().mockResolvedValue(fail('no space left'));
      const runner = makeRunner({ runArgs: runArgsMock });

      const tx = await beginUpdaterTransaction({
        files: [],
        base: BASE,
        cwd: '/project',
        runner,
        bootstrapSpec: spec,
      });

      await expect(
        tx.abortWithError({ error: 'err', validations: FAIL_ENTRIES }),
      ).rejects.toThrow(/pip install -r requirements\.txt \(revert\)/i);
    });

    it('abortWithError throw message includes the exit code', async () => {
      const runArgsMock = vi.fn().mockResolvedValue({ ...fail(), exitCode: 42 });
      const runner = makeRunner({ runArgs: runArgsMock });

      const tx = await beginUpdaterTransaction({
        files: [],
        base: BASE,
        cwd: '/project',
        runner,
        bootstrapSpec: BOOTSTRAP_SPEC,
      });

      await expect(
        tx.abortWithError({ error: 'err', validations: FAIL_ENTRIES }),
      ).rejects.toThrow(/exit 42/i);
    });

    it('logger.error is called with diagnostics before throwing on bootstrap failure', async () => {
      const mockLogger = vi.mocked(logger);
      const runArgsMock = vi.fn().mockResolvedValue({
        stdout: 'some npm output',
        stderr: 'revert failed details',
        exitCode: 1,
        command: 'npm ci',
        dryRun: false,
      });
      const runner = makeRunner({ runArgs: runArgsMock });

      const tx = await beginUpdaterTransaction({
        files: [],
        base: BASE,
        cwd: '/project',
        runner,
        bootstrapSpec: BOOTSTRAP_SPEC,
      });

      await expect(
        tx.abortWithError({ error: 'err', validations: FAIL_ENTRIES }),
      ).rejects.toThrow();

      const errorCalls: string[] = (mockLogger.error as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: unknown[]) => String(c[0]),
      );
      expect(
        errorCalls.some(
          (msg) => msg.includes('npm ci (revert) failed') && msg.includes('revert failed details'),
        ),
      ).toBe(true);
    });

    it('second restoreFiles still runs in finally when bootstrap throws (preserves byte-identical invariant)', async () => {
      // runner.runArgs throws (e.g. container disconnected) rather than returning non-zero
      const runArgsMock = vi.fn().mockRejectedValue(new Error('container died'));
      const runner = makeRunner({ runArgs: runArgsMock });

      const tx = await beginUpdaterTransaction({
        files: [],
        base: BASE,
        cwd: '/project',
        runner,
        bootstrapSpec: BOOTSTRAP_SPEC,
      });

      await expect(
        tx.abortWithError({ error: 'err', validations: FAIL_ENTRIES }),
      ).rejects.toThrow('container died');

      // Both restores must have been called despite the throw
      expect(mockRestoreFiles).toHaveBeenCalledTimes(2);
    });

    // ── AC5: dirty-tree warn-only check ───────────────────────────────────────

    it('dirty-tree check warns per-file when on-disk content differs from preRunSnapshots', async () => {
      const mockLogger = vi.mocked(logger);
      const runArgsMock = vi.fn().mockResolvedValue(ok());
      const runner = makeRunner({ runArgs: runArgsMock });

      // Snapshot says "original"; on-disk has "changed"
      mockReadFile.mockResolvedValue('changed content');

      const tx = await beginUpdaterTransaction({
        files: [],
        base: BASE,
        cwd: '/project',
        runner,
        bootstrapSpec: BOOTSTRAP_SPEC,
        preRunSnapshots: new Map([
          ['package.json', 'original content'],
          ['package-lock.json', 'original lock'],
        ]),
      });

      await tx.abortWithError({ error: 'err', validations: FAIL_ENTRIES });

      const warnCalls: string[] = (mockLogger.warn as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: unknown[]) => String(c[0]),
      );
      expect(warnCalls.some((msg) => msg.includes('[revert]') && msg.includes('package.json'))).toBe(true);
      expect(warnCalls.some((msg) => msg.includes('[revert]') && msg.includes('package-lock.json'))).toBe(true);
    });

    it('dirty-tree check does NOT warn when on-disk content matches preRunSnapshots', async () => {
      const mockLogger = vi.mocked(logger);
      const runArgsMock = vi.fn().mockResolvedValue(ok());
      const runner = makeRunner({ runArgs: runArgsMock });

      mockReadFile.mockResolvedValue('same content');

      const tx = await beginUpdaterTransaction({
        files: [],
        base: BASE,
        cwd: '/project',
        runner,
        bootstrapSpec: BOOTSTRAP_SPEC,
        preRunSnapshots: new Map([['package.json', 'same content']]),
      });

      await tx.abortWithError({ error: 'err', validations: FAIL_ENTRIES });

      const warnCalls: string[] = (mockLogger.warn as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: unknown[]) => String(c[0]),
      );
      expect(warnCalls.some((msg) => msg.includes('[revert]'))).toBe(false);
    });

    it('dirty-tree check is silently skipped when preRunSnapshots is absent', async () => {
      const mockLogger = vi.mocked(logger);
      const runArgsMock = vi.fn().mockResolvedValue(ok());
      const runner = makeRunner({ runArgs: runArgsMock });

      const tx = await beginUpdaterTransaction({
        files: [],
        base: BASE,
        cwd: '/project',
        runner,
        bootstrapSpec: BOOTSTRAP_SPEC,
        // no preRunSnapshots
      });

      await tx.abortWithError({ error: 'err', validations: FAIL_ENTRIES });

      expect(mockReadFile).not.toHaveBeenCalled();
      const warnCalls: string[] = (mockLogger.warn as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: unknown[]) => String(c[0]),
      );
      expect(warnCalls.some((msg) => msg.includes('[revert]'))).toBe(false);
    });

    it('dirty-tree check is silently skipped when preRunSnapshots is empty', async () => {
      const mockLogger = vi.mocked(logger);
      const runArgsMock = vi.fn().mockResolvedValue(ok());
      const runner = makeRunner({ runArgs: runArgsMock });

      const tx = await beginUpdaterTransaction({
        files: [],
        base: BASE,
        cwd: '/project',
        runner,
        bootstrapSpec: BOOTSTRAP_SPEC,
        preRunSnapshots: new Map(), // empty
      });

      await tx.abortWithError({ error: 'err', validations: FAIL_ENTRIES });

      expect(mockReadFile).not.toHaveBeenCalled();
    });

    it('dirty-tree file read failure is silently skipped (file not readable)', async () => {
      const mockLogger = vi.mocked(logger);
      const runArgsMock = vi.fn().mockResolvedValue(ok());
      const runner = makeRunner({ runArgs: runArgsMock });

      mockReadFile.mockRejectedValue(new Error('ENOENT'));

      const tx = await beginUpdaterTransaction({
        files: [],
        base: BASE,
        cwd: '/project',
        runner,
        bootstrapSpec: BOOTSTRAP_SPEC,
        preRunSnapshots: new Map([['package.json', 'original']]),
      });

      // Should not throw — file-read failure is silently skipped
      await expect(
        tx.abortWithError({ error: 'err', validations: FAIL_ENTRIES }),
      ).resolves.toBeDefined();

      const warnCalls: string[] = (mockLogger.warn as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: unknown[]) => String(c[0]),
      );
      expect(warnCalls.some((msg) => msg.includes('[revert]'))).toBe(false);
    });

    // ── Error result shape ─────────────────────────────────────────────────────

    it('returns status=error with the provided error string and validations', async () => {
      const runArgsMock = vi.fn().mockResolvedValue(ok());
      const runner = makeRunner({ runArgs: runArgsMock });

      const tx = await beginUpdaterTransaction({
        files: [],
        base: BASE,
        cwd: '/project',
        runner,
        bootstrapSpec: BOOTSTRAP_SPEC,
      });

      const result = await tx.abortWithError({
        error: 'something broke',
        validations: FAIL_ENTRIES,
      });

      expect(result.status).toBe('error');
      expect(result.error).toBe('something broke');
      expect(result.validations).toEqual(FAIL_ENTRIES);
    });

    it('returns base fields (agent, schema, etc.) merged into error result', async () => {
      const runArgsMock = vi.fn().mockResolvedValue(ok());
      const runner = makeRunner({ runArgs: runArgsMock });

      const tx = await beginUpdaterTransaction({
        files: [],
        base: BASE,
        cwd: '/project',
        runner,
        bootstrapSpec: BOOTSTRAP_SPEC,
      });

      const result = await tx.abortWithError({
        error: 'update failed',
        validations: SKIPPED_ENTRIES,
      });

      expect(result.$schema).toBe(BASE.$schema);
      expect(result.agent).toBe(BASE.agent);
      expect(result.packages_updated).toEqual([]);
    });

    it('abortWithError propagates bootstrap errors to the caller', async () => {
      const runArgsMock = vi.fn().mockResolvedValue(fail('revert failed catastrophically'));
      const runner = makeRunner({ runArgs: runArgsMock });

      const tx = await beginUpdaterTransaction({
        files: [],
        base: BASE,
        cwd: '/project',
        runner,
        bootstrapSpec: BOOTSTRAP_SPEC,
      });

      await expect(
        tx.abortWithError({
          error: 'mutation failed',
          validations: [{ name: 'v', status: 'fail' }],
        }),
      ).rejects.toThrow(/npm ci \(revert\).*failed/i);
    });
  });
});
