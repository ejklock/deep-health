/**
 * Error-path branch coverage for src/modules/scanner/sonar-properties.ts
 * Uses fs mocks to trigger non-ENOENT errors in readSonarProperties (line 98-99)
 * and cleanup callbacks (lines 229-231, 244-246).
 */
import { describe, it, expect, vi } from 'vitest';

// ─── fs mock (must be before imports that use fs) ─────────────────────────────

const { mockReadFile, mockWriteFile, mockUnlink, mockMkdtemp, mockRm } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockWriteFile: vi.fn().mockResolvedValue(undefined),
  mockUnlink: vi.fn().mockResolvedValue(undefined),
  mockMkdtemp: vi.fn().mockResolvedValue('/tmp/security-scan-sonar-test-abc'),
  mockRm: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('node:fs/promises', () => ({
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  unlink: mockUnlink,
  mkdtemp: mockMkdtemp,
  rm: mockRm,
}));

import {
  readSonarProperties,
  sanitizeAndWriteProperties,
} from '@modules/scanner/sonar-properties';

describe('readSonarProperties — non-ENOENT error (lines 98-99)', () => {
  it('rethrows when readFile throws a non-ENOENT error', async () => {
    const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    mockReadFile.mockRejectedValue(err);

    await expect(readSonarProperties('/some/cwd')).rejects.toThrow('EACCES');
  });

  it('returns null when readFile throws ENOENT', async () => {
    const err = Object.assign(new Error('ENOENT: file not found'), { code: 'ENOENT' });
    mockReadFile.mockRejectedValue(err);

    const result = await readSonarProperties('/some/cwd');
    expect(result).toBeNull();
  });
});

describe('sanitizeAndWriteProperties cleanup — error paths', () => {
  it('logs warning when cwd-hidden unlink throws non-ENOENT (lines 229-231)', async () => {
    mockReadFile.mockResolvedValue('sonar.projectKey=test\n');

    const sanitized = await sanitizeAndWriteProperties({ cwd: '/cwd', location: 'cwd-hidden' });

    const unlinkErr = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    mockUnlink.mockRejectedValue(unlinkErr);

    // Should not throw — just logs warning
    await expect(sanitized.cleanup()).resolves.toBeUndefined();
  });

  it('silently ignores ENOENT when cwd-hidden unlink returns ENOENT (line 229 false branch)', async () => {
    mockReadFile.mockResolvedValue('sonar.projectKey=test\n');

    const sanitized = await sanitizeAndWriteProperties({ cwd: '/cwd', location: 'cwd-hidden' });

    const unlinkErr = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
    mockUnlink.mockRejectedValue(unlinkErr);

    await expect(sanitized.cleanup()).resolves.toBeUndefined();
  });

  it('logs warning when os-tmpdir rm throws (lines 244-246)', async () => {
    mockReadFile.mockResolvedValue('sonar.projectKey=test\n');
    mockMkdtemp.mockResolvedValue('/tmp/security-scan-sonar-test-abc');

    const sanitized = await sanitizeAndWriteProperties({ cwd: '/cwd', location: 'os-tmpdir' });

    const rmErr = new Error('EPERM: operation not permitted');
    mockRm.mockRejectedValue(rmErr);

    // Should not throw — just logs warning
    await expect(sanitized.cleanup()).resolves.toBeUndefined();
  });
});
