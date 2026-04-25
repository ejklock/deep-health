/**
 * Branch coverage top-up for src/app/report-saver.ts
 * Targets:
 *   line 47: cloud storage init failure with require_upload=true → returns cloudError immediately
 *   line 73: cloud upload failure (not local) → returns cloudError
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@infra/storage/local', () => ({
  LocalStorageProvider: vi.fn().mockImplementation(() => ({
    upload: vi.fn().mockResolvedValue({ url: '/local/report.md', id: 'report.md', provider: 'local' }),
  })),
}));

vi.mock('@infra/storage/factory', () => ({
  createStorageProvider: vi.fn(),
}));

vi.mock('@reporting/sonarqube-export', () => ({
  buildSonarQubeExport: vi.fn().mockReturnValue(null),
  sonarQubeExportFilename: vi.fn().mockReturnValue('export.json'),
}));

import { saveReport, saveSonarQubeExport } from '@app/report-saver';
import { createStorageProvider } from '@infra/storage/factory';
import { LocalStorageProvider } from '@infra/storage/local';

describe('saveReport() — cloud storage init failure with require_upload=true (line 47)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns cloudError immediately when cloud init fails and require_upload=true', async () => {
    vi.mocked(createStorageProvider).mockRejectedValue(new Error('auth expired'));

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const result = await saveReport(
      'report.md',
      '# content',
      '/reports',
      { provider: 'google-drive', folder_id: 'x', require_upload: true } as any,
      '/cwd',
    );

    expect(result.cloudError).toContain('auth expired');
    expect(result.cloudSkipped).toBe(false);
    stderrSpy.mockRestore();
  });

  it('uses String(err) when non-Error is thrown during cloud init (line 47 false branch)', async () => {
    vi.mocked(createStorageProvider).mockImplementation(() =>
      Promise.reject('cloud init string error'),
    );

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const result = await saveReport(
      'report.md',
      '# content',
      '/reports',
      { provider: 'google-drive', folder_id: 'x', require_upload: true } as any,
      '/cwd',
    );

    expect(result.cloudError).toContain('cloud init string error');
    stderrSpy.mockRestore();
  });
});

describe('saveReport() — cloud upload failure after local success (line 73)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns cloudError when cloud provider upload throws after local succeeds', async () => {
    // Local succeeds
    vi.mocked(LocalStorageProvider).mockImplementation(() => ({
      upload: vi.fn().mockResolvedValue({ url: '/local/report.md', id: 'report.md', provider: 'local' }),
    }));

    // Cloud provider upload throws
    const cloudProviderMock = {
      upload: vi.fn().mockRejectedValue(new Error('network timeout')),
    };
    vi.mocked(createStorageProvider).mockResolvedValue(cloudProviderMock as any);

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const result = await saveReport(
      'report.md',
      '# content',
      '/reports',
      { provider: 'google-drive', folder_id: 'x', require_upload: false } as any,
      '/cwd',
    );

    expect(result.cloudError).toContain('network timeout');
    expect(result.localUrl).toContain('/local/report.md');
    stderrSpy.mockRestore();
  });

  it('uses String(err) when cloud upload throws a non-Error (line 73 false branch)', async () => {
    vi.mocked(LocalStorageProvider).mockImplementation(() => ({
      upload: vi.fn().mockResolvedValue({ url: '/local/report.md', id: 'report.md', provider: 'local' }),
    }));

    const cloudProviderMock = {
      upload: vi.fn().mockImplementation(() => Promise.reject('upload string error')),
    };
    vi.mocked(createStorageProvider).mockResolvedValue(cloudProviderMock as any);

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const result = await saveReport(
      'report.md',
      '# content',
      '/reports',
      { provider: 'google-drive', folder_id: 'x', require_upload: false } as any,
      '/cwd',
    );

    expect(result.cloudError).toContain('upload string error');
    stderrSpy.mockRestore();
  });
});

describe('saveReport() — cloud upload success (line 73 return)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns cloudUrl when cloud provider upload succeeds after local', async () => {
    vi.mocked(LocalStorageProvider).mockImplementation(() => ({
      upload: vi.fn().mockResolvedValue({ url: '/local/report.md', id: 'report.md', provider: 'local' }),
    }));

    const cloudProviderMock = {
      upload: vi.fn().mockResolvedValue({ url: 'https://drive.google.com/x', id: 'x', provider: 'google-drive' }),
    };
    vi.mocked(createStorageProvider).mockResolvedValue(cloudProviderMock as any);

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const result = await saveReport(
      'report.md',
      '# content',
      '/reports',
      { provider: 'google-drive', folder_id: 'x', require_upload: false } as any,
      '/cwd',
    );

    expect(result.cloudUrl).toContain('drive.google.com');
    expect(result.cloudSkipped).toBe(false);
    stdoutSpy.mockRestore();
  });
});

describe('saveSonarQubeExport() — catch branch (line 121)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('logs to stderr when saveReport throws inside saveSonarQubeExport', async () => {
    // LocalStorageProvider upload throws to simulate local save failure
    vi.mocked(LocalStorageProvider).mockImplementation(() => ({
      upload: vi.fn().mockRejectedValue(new Error('disk full')),
    }));
    vi.mocked(createStorageProvider).mockRejectedValue(new Error('no cloud'));

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    // buildSonarQubeExport is mocked to return a non-null value
    const { buildSonarQubeExport } = await import('@reporting/sonarqube-export');
    vi.mocked(buildSonarQubeExport).mockReturnValue({ engineResults: {} } as any);

    await expect(
      saveSonarQubeExport({}, 'proj', '2026-01-01', '/reports', undefined, '/cwd'),
    ).resolves.toBeUndefined(); // never throws

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('SonarQube export save failed'));
    stderrSpy.mockRestore();
  });
});
