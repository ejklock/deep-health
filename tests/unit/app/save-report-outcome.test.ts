/**
 * Direct tests for SaveReportOutcome semantics and cloud_storage.require_upload
 * gating in the saveReport function.
 *
 * Covers the Tester gap:
 *   "No direct tests found for SaveReportOutcome and require_upload gating,
 *    including default non-fatal cloud upload failure behavior."
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StorageProvider, UploadResult } from '@infra/storage/provider';

// Mock the local storage provider and factory before importing saveReport
vi.mock('@infra/storage/local', () => ({
  LocalStorageProvider: vi.fn().mockImplementation(() => ({
    upload: vi.fn().mockResolvedValue({ url: '/local/report.md', id: 'report.md', provider: 'local' }),
  })),
}));

vi.mock('@infra/storage/factory', () => ({
  createStorageProvider: vi.fn(),
}));

import { saveReport } from '@app/report-saver';
import { createStorageProvider } from '@infra/storage/factory';

const mockCreateStorageProvider = vi.mocked(createStorageProvider);

// ─── helpers ────────────────────────────────────────────────────────────────

function makeCloudProvider(behavior: 'success' | 'throw', url = 'https://drive.example.com/report'): StorageProvider {
  return {
    upload: behavior === 'success'
      ? vi.fn().mockResolvedValue({ url, id: 'report.md', provider: 'google-drive' } satisfies UploadResult)
      : vi.fn().mockRejectedValue(new Error('network timeout')),
  };
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('saveReport — SaveReportOutcome semantics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns cloudSkipped=true when no cloud config is provided', async () => {
    const outcome = await saveReport('report.md', '# report', '/tmp/reports', undefined, '/cwd');
    expect(outcome.localUrl).toBe('/local/report.md');
    expect(outcome.cloudSkipped).toBe(true);
    expect(outcome.cloudUrl).toBeUndefined();
    expect(outcome.cloudError).toBeUndefined();
  });

  it('returns cloudUrl when cloud upload succeeds', async () => {
    mockCreateStorageProvider.mockResolvedValue(makeCloudProvider('success'));

    const outcome = await saveReport(
      'report.md',
      '# report',
      '/tmp/reports',
      { provider: 'google-drive', folder_id: 'abc123' },
      '/cwd',
    );

    expect(outcome.cloudSkipped).toBe(false);
    expect(outcome.cloudUrl).toBe('https://drive.example.com/report');
    expect(outcome.cloudError).toBeUndefined();
  });

  it('returns cloudError (non-fatal) when cloud upload throws and require_upload is not set', async () => {
    mockCreateStorageProvider.mockResolvedValue(makeCloudProvider('throw'));

    const outcome = await saveReport(
      'report.md',
      '# report',
      '/tmp/reports',
      { provider: 'google-drive', folder_id: 'abc123' },
      '/cwd',
    );

    expect(outcome.localUrl).toBe('/local/report.md');
    expect(outcome.cloudError).toMatch(/network timeout/);
    expect(outcome.cloudSkipped).toBe(false);
    // localUrl is still set — local save succeeded
    expect(outcome.localUrl).toBeTruthy();
  });

  it('returns cloudError when cloud storage init fails and require_upload is false (non-fatal)', async () => {
    mockCreateStorageProvider.mockRejectedValue(new Error('credentials missing'));

    const outcome = await saveReport(
      'report.md',
      '# report',
      '/tmp/reports',
      { provider: 'google-drive', folder_id: 'abc123', require_upload: false },
      '/cwd',
    );

    // Non-fatal: local save should still proceed
    expect(outcome.localUrl).toBeTruthy();
    expect(outcome.cloudError).toBeUndefined(); // init failure with require_upload=false is swallowed
    expect(outcome.cloudSkipped).toBe(false);
  });

  it('returns cloudError immediately when cloud storage init fails and require_upload=true', async () => {
    mockCreateStorageProvider.mockRejectedValue(new Error('credentials missing'));

    const outcome = await saveReport(
      'report.md',
      '# report',
      '/tmp/reports',
      { provider: 'google-drive', folder_id: 'abc123', require_upload: true },
      '/cwd',
    );

    expect(outcome.cloudError).toMatch(/Cloud storage init failed/);
    expect(outcome.cloudSkipped).toBe(false);
    // localUrl is empty because we returned early
    expect(outcome.localUrl).toBe('');
  });

  it('cloudSkipped is false when cloud config is present (even on failure)', async () => {
    mockCreateStorageProvider.mockResolvedValue(makeCloudProvider('throw'));

    const outcome = await saveReport(
      'report.md',
      '# report',
      '/tmp/reports',
      { provider: 'google-drive', folder_id: 'abc123' },
      '/cwd',
    );

    expect(outcome.cloudSkipped).toBe(false);
  });
});
