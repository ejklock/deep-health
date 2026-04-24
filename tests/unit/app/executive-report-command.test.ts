import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunContext } from '@app/run-context';
import type { ProjectConfig } from '@core/types/config';

vi.mock('@modules/scanner/index', () => ({
  runScanner: vi.fn(),
}));

vi.mock('@orchestration/orchestrator', () => ({
  runOrchestrator: vi.fn(),
}));

vi.mock('@reporting/executive', () => ({
  generateExecutiveReport: vi.fn(() => '# executive report'),
  executiveReportFilename: vi.fn(() => 'executive.md'),
}));

vi.mock('@reporting/sonarqube-report', () => ({
  generateSonarQubeHtmlReport: vi.fn(() => null),
  sonarqubeHtmlReportFilename: vi.fn(() => '[Client Demo App] SonarQube Report - 2026-04 - April.html'),
}));

vi.mock('@app/report-saver', () => ({
  saveReport: vi.fn().mockResolvedValue({ localUrl: '/abs/reports/report.md', cloudSkipped: true }),
  resolveReportsDir: vi.fn(() => '/abs/reports'),
  resolveEngineReportsDir: vi.fn(() => '/abs/reports'),
}));

import { runScanner } from '@modules/scanner/index';
import { runOrchestrator } from '@orchestration/orchestrator';
import { runExecutiveReportCommand } from '@app/commands/executive-report';
import { saveReport } from '@app/report-saver';
import { generateSonarQubeHtmlReport } from '@reporting/sonarqube-report';

const scanResult = {
  $schema: 'osv-scan-result/v1' as const,
  agent: 'osv' as const,
  status: 'success' as const,
  environment: 'local',
  ecosystems: {
    npm: {
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

const baseConfig: ProjectConfig = {
  project: { name: 'Demo App', client: 'Client' },
  ecosystems: [{ id: 'npm' }],
  protected_packages: { npm: [] },
  safe_update_policy: {
    allow_patch_and_minor_within_constraints: true,
    require_authorization_for_constraint_change: true,
  },
  conflict_resolution: 'stop_and_ask',
};

describe('runExecutiveReportCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runScanner).mockResolvedValue(scanResult);
    // Reset sonarqube-report mocks to null defaults so tests don't bleed into each other
    vi.mocked(generateSonarQubeHtmlReport).mockReturnValue(null);
  });

  it('does not save reports when markdown output is disabled', async () => {
    vi.mocked(runOrchestrator).mockResolvedValue({
      scan: scanResult,
      updates: {},
      overallStatus: 'success',
      warnings: [],
      aggregated: {
        primary: scanResult,
        engineResults: {
          sonarqube: {
            ...scanResult,
            $schema: 'sonarqube-scan-result/v1',
            agent: 'sonarqube',
          },
        },
      },
      advisorResults: {},
    });

    const ctx: RunContext = {
      config: { ...baseConfig, outputs: { formats: [], dir: '.deep-health/reports' } },
      runner: { environment: 'local', run: vi.fn(), runArgs: vi.fn() },
    };

    const code = await runExecutiveReportCommand(ctx, {
      config: 'project-config.yml',
      cwd: '/repo',
      dryRun: false,
      verbose: false,
      quiet: false,
      json: false,
    });

    expect(code).toBe(0);
    expect(saveReport).not.toHaveBeenCalled();
  });

  it('saves markdown report when markdown is enabled (no sonarqube results)', async () => {
    vi.mocked(runOrchestrator).mockResolvedValue({
      scan: scanResult,
      updates: {},
      overallStatus: 'success',
      warnings: [],
      aggregated: undefined,
      advisorResults: {},
    });
    const ctx: RunContext = {
      config: {
        ...baseConfig,
        outputs: { formats: ['markdown'], dir: '.deep-health/reports' },
      },
      runner: { environment: 'local', run: vi.fn(), runArgs: vi.fn() },
    };

    await runExecutiveReportCommand(ctx, {
      config: 'project-config.yml',
      cwd: '/repo',
      dryRun: false,
      verbose: false,
      quiet: false,
      json: false,
    });

    // Only the main executive report is saved; no sonarqube artifact
    expect(saveReport).toHaveBeenCalledTimes(1);
  });

  it('saves executive report and sonarqube html artifact when markdown enabled and sonarqube results exist', async () => {
    vi.mocked(runOrchestrator).mockResolvedValue({
      scan: scanResult,
      updates: {},
      overallStatus: 'success',
      warnings: [],
      aggregated: {
        primary: scanResult,
        engineResults: {
          sonarqube: {
            ...scanResult,
            $schema: 'sonarqube-scan-result/v1',
            agent: 'sonarqube',
          },
        },
      },
      advisorResults: {},
    });
    vi.mocked(generateSonarQubeHtmlReport).mockReturnValue('<html></html>');

    const ctx: RunContext = {
      config: {
        ...baseConfig,
        outputs: { formats: ['markdown'], dir: '.deep-health/reports' },
      },
      runner: { environment: 'local', run: vi.fn(), runArgs: vi.fn() },
    };

    await runExecutiveReportCommand(ctx, {
      config: 'project-config.yml',
      cwd: '/repo',
      dryRun: false,
      verbose: false,
      quiet: false,
      json: false,
    });

    // Both the executive report and the SonarQube HTML artifact are saved
    expect(saveReport).toHaveBeenCalledTimes(2);
  });

  it('saves executive and html when both are available', async () => {
    vi.mocked(runOrchestrator).mockResolvedValue({
      scan: scanResult,
      updates: {},
      overallStatus: 'success',
      warnings: [],
      aggregated: {
        primary: scanResult,
        engineResults: {
          sonarqube: {
            ...scanResult,
            $schema: 'sonarqube-scan-result/v1',
            agent: 'sonarqube',
          },
        },
      },
      advisorResults: {},
    });
    vi.mocked(generateSonarQubeHtmlReport).mockReturnValue('<html></html>');

    const ctx: RunContext = {
      config: {
        ...baseConfig,
        outputs: { formats: ['markdown'], dir: '.deep-health/reports' },
      },
      runner: { environment: 'local', run: vi.fn(), runArgs: vi.fn() },
    };

    await runExecutiveReportCommand(ctx, {
      config: 'project-config.yml',
      cwd: '/repo',
      dryRun: false,
      verbose: false,
      quiet: false,
      json: false,
    });

    expect(saveReport).toHaveBeenCalledTimes(2);
  });

  it('does not save sonarqube html artifact when html generation returns null', async () => {
    vi.mocked(runOrchestrator).mockResolvedValue({
      scan: scanResult,
      updates: {},
      overallStatus: 'success',
      warnings: [],
      aggregated: {
        primary: scanResult,
        engineResults: {
          sonarqube: {
            ...scanResult,
            $schema: 'sonarqube-scan-result/v1',
            agent: 'sonarqube',
            status: 'skipped' as const,
          },
        },
      },
      advisorResults: {},
    });
    const ctx: RunContext = {
      config: {
        ...baseConfig,
        outputs: { formats: ['markdown'], dir: '.deep-health/reports' },
      },
      runner: { environment: 'local', run: vi.fn(), runArgs: vi.fn() },
    };

    await runExecutiveReportCommand(ctx, {
      config: 'project-config.yml',
      cwd: '/repo',
      dryRun: false,
      verbose: false,
      quiet: false,
      json: false,
    });

    // Only the executive report; no SonarQube HTML artifact when it returns null
    expect(saveReport).toHaveBeenCalledTimes(1);
  });

  it('returns exit code 1 and emits stderr when require_upload is true and saveReport returns cloudError (executive report)', async () => {
    vi.mocked(runOrchestrator).mockResolvedValue({
      scan: scanResult,
      updates: {},
      overallStatus: 'success',
      warnings: [],
      aggregated: undefined,
      advisorResults: {},
    });
    vi.mocked(saveReport).mockResolvedValueOnce({
      localUrl: '/abs/reports/executive.md',
      cloudError: 'Google Drive quota exceeded',
      cloudSkipped: false,
    });

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const ctx: RunContext = {
      config: {
        ...baseConfig,
        outputs: { formats: ['markdown'], dir: '.deep-health/reports' },
        cloud_storage: { provider: 'google_drive', folder_id: 'abc123', require_upload: true },
      },
      runner: { environment: 'local', run: vi.fn(), runArgs: vi.fn() },
    };

    const code = await runExecutiveReportCommand(ctx, {
      config: 'project-config.yml',
      cwd: '/repo',
      dryRun: false,
      verbose: false,
      quiet: false,
      json: false,
    });

    expect(code).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('Cloud upload required but failed'),
    );

    stderrSpy.mockRestore();
  });

  it('returns exit code 1 and emits stderr when require_upload is true and saveReport returns cloudError (sonarqube html)', async () => {
    vi.mocked(runOrchestrator).mockResolvedValue({
      scan: scanResult,
      updates: {},
      overallStatus: 'success',
      warnings: [],
      aggregated: {
        primary: scanResult,
        engineResults: {
          sonarqube: {
            ...scanResult,
            $schema: 'sonarqube-scan-result/v1',
            agent: 'sonarqube',
          },
        },
      },
      advisorResults: {},
    });
    vi.mocked(generateSonarQubeHtmlReport).mockReturnValue('<html></html>');
    // First saveReport (executive report) succeeds; second (sonarqube html) fails with cloudError
    vi.mocked(saveReport)
      .mockResolvedValueOnce({ localUrl: '/abs/reports/executive.md', cloudSkipped: false })
      .mockResolvedValueOnce({
        localUrl: '/abs/reports/sonarqube.html',
        cloudError: 'Upload bandwidth exceeded',
        cloudSkipped: false,
      });

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const ctx: RunContext = {
      config: {
        ...baseConfig,
        outputs: { formats: ['markdown'], dir: '.deep-health/reports' },
        cloud_storage: { provider: 'google_drive', folder_id: 'abc123', require_upload: true },
      },
      runner: { environment: 'local', run: vi.fn(), runArgs: vi.fn() },
    };

    const code = await runExecutiveReportCommand(ctx, {
      config: 'project-config.yml',
      cwd: '/repo',
      dryRun: false,
      verbose: false,
      quiet: false,
      json: false,
    });

    expect(code).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('Cloud upload required but failed (SonarQube HTML)'),
    );

    stderrSpy.mockRestore();
  });

  it('does NOT return exit code 1 when cloudError is set but require_upload is false', async () => {
    vi.mocked(runOrchestrator).mockResolvedValue({
      scan: scanResult,
      updates: {},
      overallStatus: 'success',
      warnings: [],
      aggregated: undefined,
      advisorResults: {},
    });
    vi.mocked(saveReport).mockResolvedValueOnce({
      localUrl: '/abs/reports/executive.md',
      cloudError: 'Some cloud error',
      cloudSkipped: false,
    });

    const ctx: RunContext = {
      config: {
        ...baseConfig,
        outputs: { formats: ['markdown'], dir: '.deep-health/reports' },
        cloud_storage: { provider: 'google_drive', folder_id: 'abc123', require_upload: false },
      },
      runner: { environment: 'local', run: vi.fn(), runArgs: vi.fn() },
    };

    const code = await runExecutiveReportCommand(ctx, {
      config: 'project-config.yml',
      cwd: '/repo',
      dryRun: false,
      verbose: false,
      quiet: false,
      json: false,
    });

    // Cloud error without require_upload must not force exit code 1
    expect(code).toBe(0);
  });
});
