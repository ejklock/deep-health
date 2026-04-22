import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module-level mocks ────────────────────────────────────────────────────────

vi.mock('@infra/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@infra/utils/git.js', () => ({
  backupFiles: vi.fn(),
  restoreFiles: vi.fn().mockResolvedValue(undefined),
}));

// Mock OsvDockerRunner and fs/promises.
// Using vi.hoisted() so these vi.fn() instances are initialized BEFORE the
// hoisted vi.mock() factories reference them — avoids the "Cannot access
// 'mockMkdtemp' before initialization" TDZ error.
const {
  mockOsvDockerRunnerRun,
  mockMkdtemp,
  mockReadFile,
  mockWriteFile,
  mockRm,
} = vi.hoisted(() => ({
  mockOsvDockerRunnerRun: vi.fn(),
  mockMkdtemp: vi.fn(),
  mockReadFile: vi.fn(),
  mockWriteFile: vi.fn(),
  mockRm: vi.fn(),
}));

vi.mock('@infra/provisioner/osv-runner.js', () => ({
  OsvDockerRunner: vi.fn().mockImplementation(() => ({
    run: mockOsvDockerRunnerRun,
  })),
}));

vi.mock('node:fs/promises', () => ({
  mkdtemp: mockMkdtemp,
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  rm: mockRm,
}));

import { applyOsvFixViaStaging } from '@orchestration/osv-fix-applier';
import * as gitUtils from '@infra/utils/git.js';
import { logger } from '@infra/utils/logger.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeInput(overrides: Partial<Parameters<typeof applyOsvFixViaStaging>[0]> = {}) {
  return {
    cwd: '/project',
    osvConfig: undefined,
    osvFixSpec: {
      fixLockfile: 'package-lock.json',
      backupFiles: ['package.json', 'package-lock.json'] as readonly string[],
    },
    dryRun: false,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('applyOsvFixViaStaging — dryRun=true', () => {
  it('returns immediately with applied=false, empty packagesUpdated, empty backups', async () => {
    const result = await applyOsvFixViaStaging(makeInput({ dryRun: true }));

    expect(result.applied).toBe(false);
    expect(result.packagesUpdated).toHaveLength(0);
    expect(result.backups.size).toBe(0);
    expect(result.rawFixStdout).toBe('');
    expect(result.rawFixStderr).toBe('');
    // No fs operations should have been called
    expect(mockMkdtemp).not.toHaveBeenCalled();
    expect(mockOsvDockerRunnerRun).not.toHaveBeenCalled();
  });
});

describe('applyOsvFixViaStaging — parseOsvFixJson', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Setup standard mocks for non-dry-run path
    (gitUtils.backupFiles as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Map([
        ['package.json', '{"name":"test"}'],
        ['package-lock.json', 'original-lockfile-content'],
      ]),
    );
    mockMkdtemp.mockResolvedValue('/tmp/deep-health-osv-fix-abc123');
    mockWriteFile.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);
  });

  it('valid JSON with patches → returns correct packagesUpdated', async () => {
    const fixOutput = JSON.stringify({
      patches: [
        {
          packageUpdates: [
            { name: 'lodash', versionFrom: '4.17.20', versionTo: '4.17.21' },
            { name: 'axios', versionFrom: '1.6.0', versionTo: '1.7.0' },
          ],
        },
      ],
    });

    mockOsvDockerRunnerRun.mockResolvedValue({ exitCode: 0, stdout: fixOutput, stderr: '' });
    // staging lockfile differs from backup → applied=true
    mockReadFile.mockResolvedValue('updated-lockfile-content');

    const result = await applyOsvFixViaStaging(makeInput());

    expect(result.packagesUpdated).toHaveLength(2);
    expect(result.packagesUpdated).toContainEqual({
      name: 'lodash',
      versionFrom: '4.17.20',
      versionTo: '4.17.21',
    });
    expect(result.packagesUpdated).toContainEqual({
      name: 'axios',
      versionFrom: '1.6.0',
      versionTo: '1.7.0',
    });
  });

  it('malformed JSON → returns [] (defensive)', async () => {
    mockOsvDockerRunnerRun.mockResolvedValue({
      exitCode: 0,
      stdout: 'NOT_VALID_JSON',
      stderr: '',
    });
    mockReadFile.mockResolvedValue('updated-lockfile-content');

    const result = await applyOsvFixViaStaging(makeInput());

    expect(result.packagesUpdated).toHaveLength(0);
    expect((logger.warn as ReturnType<typeof vi.fn>).mock.calls.some(
      (c) => String(c[0]).includes('Could not parse osv-scanner fix JSON output'),
    )).toBe(true);
  });

  it('valid JSON but empty patches array → returns []', async () => {
    mockOsvDockerRunnerRun.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ patches: [] }),
      stderr: '',
    });
    mockReadFile.mockResolvedValue('updated-lockfile-content');

    const result = await applyOsvFixViaStaging(makeInput());

    expect(result.packagesUpdated).toHaveLength(0);
  });

  it('multiple patches with same package name → dedupes, keeps last', async () => {
    const fixOutput = JSON.stringify({
      patches: [
        {
          packageUpdates: [
            { name: 'lodash', versionFrom: '4.17.18', versionTo: '4.17.20' },
          ],
        },
        {
          packageUpdates: [
            { name: 'lodash', versionFrom: '4.17.20', versionTo: '4.17.21' },
          ],
        },
      ],
    });

    mockOsvDockerRunnerRun.mockResolvedValue({ exitCode: 0, stdout: fixOutput, stderr: '' });
    mockReadFile.mockResolvedValue('updated-lockfile-content');

    const result = await applyOsvFixViaStaging(makeInput());

    const lodashEntries = result.packagesUpdated.filter((p) => p.name === 'lodash');
    expect(lodashEntries).toHaveLength(1);
    expect(lodashEntries[0]!.versionTo).toBe('4.17.21');
  });
});

describe('applyOsvFixViaStaging — container exit codes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (gitUtils.backupFiles as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Map([
        ['package.json', '{"name":"test"}'],
        ['package-lock.json', 'original-lockfile-content'],
      ]),
    );
    mockMkdtemp.mockResolvedValue('/tmp/deep-health-osv-fix-abc123');
    mockWriteFile.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);
  });

  it('OSV container exits non-zero → applied=false, no host write', async () => {
    mockOsvDockerRunnerRun.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'error: no compatible patches',
    });

    const result = await applyOsvFixViaStaging(makeInput());

    expect(result.applied).toBe(false);
    expect(result.packagesUpdated).toHaveLength(0);
    // writeFile should only have been called for staging (not for host) — verify no second call
    // writeFile called twice (one per backup file), then NOT for the host lockfile
    const writeFileCalls = (mockWriteFile.mock.calls as string[][]).map((c) => c[0]);
    expect(writeFileCalls.every((p) => p.startsWith('/tmp/'))).toBe(true);
  });

  it('OSV exits 0, staging lockfile = backup content → applied=false, no host write', async () => {
    mockOsvDockerRunnerRun.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ patches: [] }),
      stderr: '',
    });
    // readFile returns same content as backup
    mockReadFile.mockResolvedValue('original-lockfile-content');

    const result = await applyOsvFixViaStaging(makeInput());

    expect(result.applied).toBe(false);
    // writeFile not called for host lockfile
    const writeFileCalls = (mockWriteFile.mock.calls as string[][]).map((c) => c[0]);
    expect(writeFileCalls.every((p) => p.startsWith('/tmp/'))).toBe(true);
  });

  it('OSV exits 0, staging lockfile ≠ backup content → applied=true, fs.writeFile called once with correct path', async () => {
    const fixedContent = 'updated-lockfile-content-v2';
    mockOsvDockerRunnerRun.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({
        patches: [
          { packageUpdates: [{ name: 'lodash', versionFrom: '4.17.20', versionTo: '4.17.21' }] },
        ],
      }),
      stderr: '',
    });
    mockReadFile.mockResolvedValue(fixedContent);

    const result = await applyOsvFixViaStaging(makeInput());

    expect(result.applied).toBe(true);
    // The last writeFile call should be the host write
    const allCalls = mockWriteFile.mock.calls as [string, string, string][];
    const hostWrite = allCalls.find(([p]) => p === '/project/package-lock.json');
    expect(hostWrite).toBeDefined();
    expect(hostWrite![1]).toBe(fixedContent);
    expect(hostWrite![2]).toBe('utf-8');
  });
});

describe('applyOsvFixViaStaging — staging dir cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (gitUtils.backupFiles as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Map([['package-lock.json', 'original']]),
    );
    mockMkdtemp.mockResolvedValue('/tmp/deep-health-osv-fix-cleanup-test');
    mockWriteFile.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);
  });

  it('staging dir is cleaned up (rm called) in success path', async () => {
    mockOsvDockerRunnerRun.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ patches: [] }),
      stderr: '',
    });
    mockReadFile.mockResolvedValue('original');

    await applyOsvFixViaStaging(makeInput());

    expect(mockRm).toHaveBeenCalledWith('/tmp/deep-health-osv-fix-cleanup-test', {
      recursive: true,
      force: true,
    });
  });

  it('staging dir is cleaned up in failure path (exception thrown by runner)', async () => {
    mockOsvDockerRunnerRun.mockRejectedValue(new Error('Docker not available'));

    await expect(applyOsvFixViaStaging(makeInput())).rejects.toThrow('Docker not available');

    expect(mockRm).toHaveBeenCalledWith('/tmp/deep-health-osv-fix-cleanup-test', {
      recursive: true,
      force: true,
    });
  });
});
