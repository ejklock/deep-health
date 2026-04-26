import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UpdateResultJson, ValidationEntry } from '@core/types/update';

// ─── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@infra/utils/git', () => ({
  backupFiles: vi.fn(),
}));

import { backupFiles } from '@infra/utils/git';
import { beginUpdaterTransaction } from '@modules/ecosystem/utils/updater-transaction';

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const mockBackupFiles = vi.mocked(backupFiles);

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

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('beginUpdaterTransaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBackupFiles.mockResolvedValue(FAKE_BACKUPS);
  });

  it('calls backupFiles with files + cwd when no preExistingBackups', async () => {
    const tx = await beginUpdaterTransaction({
      files: ['requirements.txt'],
      base: BASE,
      cwd: '/project',
    });

    expect(mockBackupFiles).toHaveBeenCalledOnce();
    expect(mockBackupFiles).toHaveBeenCalledWith(['requirements.txt'], '/project');
    expect(tx.backups).toBe(FAKE_BACKUPS);
  });

  it('adopts preExistingBackups without calling backupFiles', async () => {
    const preExisting = new Map([['package-lock.json', 'lock content']]);

    const tx = await beginUpdaterTransaction({
      files: ['package.json'],
      base: BASE,
      cwd: '/project',
      preExistingBackups: preExisting,
    });

    expect(mockBackupFiles).not.toHaveBeenCalled();
    expect(tx.backups).toBe(preExisting);
  });

  describe('success()', () => {
    it('returns base spread with packages_updated and validations', async () => {
      const tx = await beginUpdaterTransaction({ files: [], base: BASE, cwd: '/project' });

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
      const tx = await beginUpdaterTransaction({ files: [], base, cwd: '/project' });

      tx.success({ packages_updated: ['pkg'], validations: PASS_ENTRIES });

      expect(base.packages_updated).toEqual([]);
      expect(base.validations).toEqual(BASE.validations);
    });
  });

  describe('abortWithError()', () => {
    it('calls revert exactly once and returns status=error', async () => {
      const tx = await beginUpdaterTransaction({ files: [], base: BASE, cwd: '/project' });
      const revert = vi.fn().mockResolvedValue(undefined);

      const result = await tx.abortWithError({
        error: 'something broke',
        validations: FAIL_ENTRIES,
        revert,
      });

      expect(revert).toHaveBeenCalledOnce();
      expect(result.status).toBe('error');
      expect(result.error).toBe('something broke');
      expect(result.validations).toEqual(FAIL_ENTRIES);
    });

    it('returns base fields (agent, schema, etc.) merged into error result', async () => {
      const tx = await beginUpdaterTransaction({ files: [], base: BASE, cwd: '/project' });
      const revert = vi.fn().mockResolvedValue(undefined);

      const result = await tx.abortWithError({
        error: 'update failed',
        validations: SKIPPED_ENTRIES,
        revert,
      });

      expect(result.$schema).toBe(BASE.$schema);
      expect(result.agent).toBe(BASE.agent);
      expect(result.packages_updated).toEqual([]);
    });

    it('abortWithError propagates revert errors to the caller', async () => {
      const tx = await beginUpdaterTransaction({ files: [], base: BASE, cwd: '/project' });
      const revertErr = new Error('revert failed catastrophically');

      await expect(
        tx.abortWithError({
          error: 'mutation failed',
          validations: [{ name: 'v', status: 'fail' }],
          revert: async () => { throw revertErr; },
        }),
      ).rejects.toBe(revertErr);
    });
  });
});
