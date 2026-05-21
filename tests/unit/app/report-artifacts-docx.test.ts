/**
 * Tests for DOCX artifact generation in generateAndSaveReportArtifacts().
 * AC5: DOCX artifact is generated when outputs.formats includes 'docx'.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectConfig } from '@core/types/config';

vi.mock('@modules/scanner/index', () => ({
  runScanner: vi.fn(),
}));

vi.mock('@reporting/executive', () => ({
  generateExecutiveReport: vi.fn(() => '# executive report markdown'),
  executiveReportFilename: vi.fn(() => '[Acme Project] Security Report - 2026-05 - May.md'),
  buildExecutiveReportContext: vi.fn(() => ({})),
}));

vi.mock('@reporting/docx-executive', () => ({
  generateExecutiveReportDocx: vi.fn().mockResolvedValue(Buffer.from('fake-docx')),
  executiveReportDocxFilename: vi.fn(() => '[Acme Project] Security Report - 2026-05 - May.docx'),
}));

vi.mock('@reporting/sonarqube-report', () => ({
  generateSonarQubeHtmlReport: vi.fn(() => null),
  sonarqubeHtmlReportFilename: vi.fn(() => '[Acme Project] SonarQube Report - 2026-05 - May.html'),
}));

vi.mock('@app/report-saver', () => ({
  saveReport: vi.fn().mockResolvedValue({ localUrl: '/reports/report', cloudSkipped: true }),
  resolveReportsDir: vi.fn(() => '/abs/reports'),
  resolveEngineReportsDir: vi.fn(() => '/abs/reports'),
}));

import { runScanner } from '@modules/scanner/index';
import { generateExecutiveReport, executiveReportFilename } from '@reporting/executive';
import { generateExecutiveReportDocx, executiveReportDocxFilename } from '@reporting/docx-executive';
import { saveReport } from '@app/report-saver';
import { generateAndSaveReportArtifacts } from '@app/report-artifacts';

const emptyScan = {
  agent: 'osv-scanner' as const,
  status: 'success' as const,
  environment: 'local',
  ecosystems: {},
  error: null,
};

const baseConfig: ProjectConfig = {
  project: { name: 'Project', client: 'Acme' },
  ecosystems: [{ id: 'npm' }],
  protected_packages: {},
  safe_update_policy: {
    allow_patch_and_minor_within_constraints: true,
    require_authorization_for_constraint_change: false,
  },
  conflict_resolution: 'manual',
};

const baseInput = {
  runner: { environment: 'local' as const, run: vi.fn(), runArgs: vi.fn() },
  cwd: '/repo',
  config: baseConfig,
  scanBefore: emptyScan,
  updates: {},
};

describe('generateAndSaveReportArtifacts() — DOCX format', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runScanner).mockResolvedValue(emptyScan);
  });

  it('returns 0 and skips all saves when no formats are configured', async () => {
    const code = await generateAndSaveReportArtifacts({
      ...baseInput,
      config: { ...baseConfig, outputs: { formats: [] } },
    });
    expect(code).toBe(0);
    expect(saveReport).not.toHaveBeenCalled();
  });

  it('generates DOCX when docx format is enabled', async () => {
    const code = await generateAndSaveReportArtifacts({
      ...baseInput,
      config: { ...baseConfig, outputs: { formats: ['docx'] } },
    });
    expect(code).toBe(0);
    expect(generateExecutiveReportDocx).toHaveBeenCalledTimes(1);
    expect(saveReport).toHaveBeenCalledWith(
      expect.stringMatching(/\.docx$/),
      expect.any(Buffer),
      expect.any(String),
      undefined,
      '/repo',
    );
  });

  it('generates Markdown when markdown format is enabled', async () => {
    await generateAndSaveReportArtifacts({
      ...baseInput,
      config: { ...baseConfig, outputs: { formats: ['markdown'] } },
    });
    expect(generateExecutiveReport).toHaveBeenCalledTimes(1);
    expect(generateExecutiveReportDocx).not.toHaveBeenCalled();
    expect(saveReport).toHaveBeenCalledWith(
      expect.stringMatching(/\.md$/),
      expect.any(String),
      expect.any(String),
      undefined,
      '/repo',
    );
  });

  it('generates both Markdown and DOCX when both formats are enabled', async () => {
    const code = await generateAndSaveReportArtifacts({
      ...baseInput,
      config: { ...baseConfig, outputs: { formats: ['markdown', 'docx'] } },
    });
    expect(code).toBe(0);
    expect(generateExecutiveReport).toHaveBeenCalledTimes(1);
    expect(generateExecutiveReportDocx).toHaveBeenCalledTimes(1);
    expect(saveReport).toHaveBeenCalledTimes(2);
  });

  it('uses executiveReportDocxFilename for the DOCX artifact', async () => {
    await generateAndSaveReportArtifacts({
      ...baseInput,
      config: { ...baseConfig, outputs: { formats: ['docx'] } },
    });
    expect(executiveReportDocxFilename).toHaveBeenCalledWith('Acme', 'Project');
  });

  it('uses executiveReportFilename for the Markdown artifact', async () => {
    await generateAndSaveReportArtifacts({
      ...baseInput,
      config: { ...baseConfig, outputs: { formats: ['markdown'] } },
    });
    expect(executiveReportFilename).toHaveBeenCalledWith('Acme', 'Project');
  });

  it('returns 1 when DOCX cloud upload fails and require_upload is true', async () => {
    vi.mocked(saveReport).mockResolvedValue({
      localUrl: '/reports/doc.docx',
      cloudError: 'Network error',
      cloudSkipped: false,
    });

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const code = await generateAndSaveReportArtifacts({
      ...baseInput,
      config: {
        ...baseConfig,
        outputs: { formats: ['docx'] },
        cloud_storage: { provider: 'google_drive', folder_id: 'folder1', require_upload: true },
      },
    });
    expect(code).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('DOCX'));
    stderrSpy.mockRestore();
  });

  it('returns 0 when DOCX cloud upload fails but require_upload is false', async () => {
    vi.mocked(saveReport).mockResolvedValue({
      localUrl: '/reports/doc.docx',
      cloudError: 'Network error',
      cloudSkipped: false,
    });

    const code = await generateAndSaveReportArtifacts({
      ...baseInput,
      config: {
        ...baseConfig,
        outputs: { formats: ['docx'] },
        cloud_storage: { provider: 'google_drive', folder_id: 'folder1', require_upload: false },
      },
    });
    expect(code).toBe(0);
  });

  it('DOCX and Markdown are saved independently — both present without interfering', async () => {
    const calls: string[] = [];
    vi.mocked(saveReport).mockImplementation(async (filename) => {
      calls.push(filename);
      return { localUrl: `/reports/${filename}`, cloudSkipped: true };
    });

    await generateAndSaveReportArtifacts({
      ...baseInput,
      config: { ...baseConfig, outputs: { formats: ['markdown', 'docx'] } },
    });

    const mdCall = calls.find((f) => f.endsWith('.md'));
    const docxCall = calls.find((f) => f.endsWith('.docx'));
    expect(mdCall).toBeDefined();
    expect(docxCall).toBeDefined();
  });

  it('overrides client and project from input when provided', async () => {
    await generateAndSaveReportArtifacts({
      ...baseInput,
      client: 'OverrideClient',
      project: 'OverrideProject',
      config: { ...baseConfig, outputs: { formats: ['docx'] } },
    });
    expect(executiveReportDocxFilename).toHaveBeenCalledWith('OverrideClient', 'OverrideProject');
  });
});
