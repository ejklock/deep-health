/**
 * Additional tests for src/app/report-saver.ts
 * Covers resolveEngineReportsDir, saveSonarQubeExport, and resolveReportsDir.
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
  buildSonarQubeExport: vi.fn(),
  sonarQubeExportFilename: vi.fn().mockReturnValue('sonarqube-export-test-2026-04-24.json'),
}));

import { resolveReportsDir, resolveEngineReportsDir, saveSonarQubeExport } from '@app/report-saver';
import { buildSonarQubeExport } from '@reporting/sonarqube-export';
import type { ScanResultJson } from '@core/types/scan';

describe('resolveReportsDir()', () => {
  it('resolves to default .security-scan/reports when configReportsDir is undefined', () => {
    const result = resolveReportsDir('/project', undefined);
    expect(result).toContain('.security-scan/reports');
  });

  it('resolves to the provided dir relative to cwd', () => {
    const result = resolveReportsDir('/project', 'custom/reports');
    expect(result).toContain('custom/reports');
    expect(result).toContain('/project');
  });
});

describe('resolveEngineReportsDir()', () => {
  it('returns reportsDir unchanged when subFolder is falsy', () => {
    expect(resolveEngineReportsDir('/reports', undefined)).toBe('/reports');
    expect(resolveEngineReportsDir('/reports', '')).toBe('/reports');
  });

  it('appends subFolder to reportsDir', () => {
    const result = resolveEngineReportsDir('/reports', 'sonarqube');
    expect(result).toContain('sonarqube');
    expect(result).toContain('/reports');
  });
});

describe('saveSonarQubeExport()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing when buildSonarQubeExport returns null', async () => {
    vi.mocked(buildSonarQubeExport).mockReturnValue(null);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await saveSonarQubeExport({}, 'project', '2026-04-24', '/reports', undefined, '/cwd');
    expect(stderrSpy).not.toHaveBeenCalled();
    stderrSpy.mockRestore();
  });

  it('saves export when buildSonarQubeExport returns data', async () => {
    const mockExport = {
      $schema: 'sonarqube-export/v1' as const,
      exportedAt: '2026-04-24T00:00:00.000Z',
      agent: 'sonarqube',
      status: 'success',
      qualityGate: null,
      metrics: null,
      issues: null,
      error: null,
    };
    vi.mocked(buildSonarQubeExport).mockReturnValue(mockExport);

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await saveSonarQubeExport({}, 'project', '2026-04-24', '/reports', undefined, '/cwd');
    expect(stdoutSpy).toHaveBeenCalled();
    stdoutSpy.mockRestore();
  });

  it('logs error to stderr when saveReport throws', async () => {
    const mockExport = {
      $schema: 'sonarqube-export/v1' as const,
      exportedAt: '',
      agent: 'sonarqube',
      status: 'success',
      qualityGate: null,
      metrics: null,
      issues: null,
      error: null,
    };
    vi.mocked(buildSonarQubeExport).mockReturnValue(mockExport);

    // Make LocalStorageProvider throw
    const { LocalStorageProvider } = await import('@infra/storage/local');
    vi.mocked(LocalStorageProvider).mockImplementation(() => ({
      upload: vi.fn().mockRejectedValue(new Error('disk full')),
    }));

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await saveSonarQubeExport({}, 'project', '2026-04-24', '/reports', undefined, '/cwd');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('SonarQube export save failed'));
    stderrSpy.mockRestore();
  });
});
