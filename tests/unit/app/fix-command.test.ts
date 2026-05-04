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

vi.mock('@app/output-writer', () => ({
  writeOutput: vi.fn(),
}));

vi.mock('@app/report-saver', () => ({
  saveReport: vi.fn().mockResolvedValue({ localUrl: '/abs/reports/report.md', cloudSkipped: true }),
  resolveReportsDir: vi.fn(() => '/abs/reports'),
  resolveEngineReportsDir: vi.fn(() => '/abs/reports'),
}));

vi.mock('@app/audit-trail', () => ({
  writeAuditTrail: vi.fn().mockResolvedValue(undefined),
  resolveCliVersion: vi.fn().mockResolvedValue('1.0.0'),
}));

import { runScanner } from '@modules/scanner/index';
import { runOrchestrator } from '@orchestration/orchestrator';
import { writeOutput } from '@app/output-writer';
import { runFixCommand } from '@app/commands/fix';
import { saveReport } from '@app/report-saver';
import { generateSonarQubeHtmlReport } from '@reporting/sonarqube-report';
import { writeAuditTrail } from '@app/audit-trail';

const configWithOutputs: ProjectConfig = {
  project: { name: 'Demo App', client: 'Client' },
  ecosystems: [{ id: 'npm' }],
  protected_packages: { npm: [] },
  safe_update_policy: {
    allow_patch_and_minor_within_constraints: true,
    require_authorization_for_constraint_change: true,
  },
  conflict_resolution: 'stop_and_ask',
  outputs: { formats: ['markdown'], dir: '.security-scan/reports' },
};

const scanResult = {
  $schema: 'osv-scan-result/v1' as const,
  agent: 'osv-scanner' as const,
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

describe('runFixCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(generateSonarQubeHtmlReport).mockReturnValue(null);
  });

  it('does not write or save consolidated output when noReport=true', async () => {
    vi.mocked(runScanner).mockResolvedValue(scanResult);
    vi.mocked(runOrchestrator).mockResolvedValue({
      scan: scanResult,
      updates: {},
      overallStatus: 'success',
      warnings: [],
      aggregated: undefined,
      advisorResults: {},
    });

    const ctx: RunContext = {
      config: configWithOutputs,
      runner: { environment: 'local', run: vi.fn(), runArgs: vi.fn() },
    };

    const code = await runFixCommand(ctx, {
      config: 'project-config.yml',
      cwd: '/repo',
      dryRun: false,
      verbose: false,
      quiet: false,
      json: false,
      noReport: true,
    });

    expect(code).toBe(0);
    expect(writeOutput).not.toHaveBeenCalled();
    expect(saveReport).not.toHaveBeenCalled();
  });

  it('writes json output when json=true', async () => {
    vi.mocked(runScanner).mockResolvedValue(scanResult);
    vi.mocked(runOrchestrator).mockResolvedValue({
      scan: scanResult,
      updates: {},
      overallStatus: 'success',
      warnings: [],
      aggregated: undefined,
      advisorResults: {},
    });

    const ctx: RunContext = {
      config: configWithOutputs,
      runner: { environment: 'local', run: vi.fn(), runArgs: vi.fn() },
    };

    await runFixCommand(ctx, {
      config: 'project-config.yml',
      cwd: '/repo',
      dryRun: false,
      verbose: false,
      quiet: false,
      json: true,
      noReport: true,
    });

    expect(writeOutput).toHaveBeenCalledTimes(1);
  });

  it('does not save any reports when outputs.formats is empty', async () => {
    vi.mocked(runScanner).mockResolvedValue(scanResult);
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
      config: {
        ...configWithOutputs,
        outputs: { formats: [], dir: '.security-scan/reports' },
      },
      runner: { environment: 'local', run: vi.fn(), runArgs: vi.fn() },
    };

    await runFixCommand(ctx, {
      config: 'project-config.yml',
      cwd: '/repo',
      dryRun: false,
      verbose: false,
      quiet: false,
      json: false,
      noReport: false,
    });

    // No reports when formats is empty
    expect(saveReport).not.toHaveBeenCalled();
  });

  it('calls runScanner exactly once (scanAfter only) and runOrchestrator exactly once', async () => {
    // Regression test: fix.ts uses result.scan from runOrchestrator as the canonical
    // before-fix snapshot (scanBefore). The only standalone runScanner call is scanAfter,
    // used exclusively for the executive-report before/after diff.
    // SonarQube results flow exclusively through the single runOrchestrator call.
    vi.mocked(runScanner).mockResolvedValue(scanResult);
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
      config: configWithOutputs,
      runner: { environment: 'local', run: vi.fn(), runArgs: vi.fn() },
    };

    await runFixCommand(ctx, {
      config: 'project-config.yml',
      cwd: '/repo',
      dryRun: false,
      verbose: false,
      quiet: false,
      json: false,
      noReport: false,
    });

    // runScanner must be called exactly once: scanAfter only (scanBefore comes from result.scan)
    expect(runScanner).toHaveBeenCalledTimes(1);

    // runOrchestrator must be called exactly once (owns scan + SonarQube execution)
    expect(runOrchestrator).toHaveBeenCalledTimes(1);
  });

  it('saves only executive markdown and sonarqube html artifacts', async () => {
    vi.mocked(runScanner).mockResolvedValue(scanResult);
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
      config: configWithOutputs,
      runner: { environment: 'local', run: vi.fn(), runArgs: vi.fn() },
    };

    await runFixCommand(ctx, {
      config: 'project-config.yml',
      cwd: '/repo',
      dryRun: false,
      verbose: false,
      quiet: false,
      json: false,
      noReport: false,
    });

    expect(saveReport).toHaveBeenCalledTimes(2);
    expect(saveReport).toHaveBeenNthCalledWith(
      1,
      'executive.md',
      '# executive report',
      '/abs/reports',
      undefined,
      '/repo',
    );
    expect(saveReport).toHaveBeenNthCalledWith(
      2,
      '[Client Demo App] SonarQube Report - 2026-04 - April.html',
      '<html></html>',
      '/abs/reports',
      undefined,
      '/repo',
    );
  });

  it('does not call runScanner at all when noReport=true', async () => {
    // When noReport=true the executive-report branch (which calls scanAfter) is skipped,
    // so runScanner must not be called at all.
    vi.mocked(runScanner).mockResolvedValue(scanResult);
    vi.mocked(runOrchestrator).mockResolvedValue({
      scan: scanResult,
      updates: {},
      overallStatus: 'success',
      warnings: [],
      aggregated: undefined,
      advisorResults: {},
    });

    const ctx: RunContext = {
      config: configWithOutputs,
      runner: { environment: 'local', run: vi.fn(), runArgs: vi.fn() },
    };

    await runFixCommand(ctx, {
      config: 'project-config.yml',
      cwd: '/repo',
      dryRun: false,
      verbose: false,
      quiet: false,
      json: false,
      noReport: true,
    });

    expect(runScanner).not.toHaveBeenCalled();
    expect(runOrchestrator).toHaveBeenCalledTimes(1);
  });

  it('emits breaking-vuln warning sourced from result.scan (not a standalone scan)', async () => {
    // Breaking-vuln warnings must use result.scan from the orchestrator, not a pre-scan call.
    const scanWithBreaking = {
      ...scanResult,
      ecosystems: {
        npm: {
          ...scanResult.ecosystems.npm,
          breaking: 2,
          breaking_packages: ['lodash', 'express'],
        },
      },
    };

    vi.mocked(runScanner).mockResolvedValue(scanResult);
    vi.mocked(runOrchestrator).mockResolvedValue({
      scan: scanWithBreaking,
      updates: {},
      overallStatus: 'success',
      warnings: [],
      aggregated: undefined,
      advisorResults: {},
    });

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const ctx: RunContext = {
      config: configWithOutputs,
      runner: { environment: 'local', run: vi.fn(), runArgs: vi.fn() },
    };

    await runFixCommand(ctx, {
      config: 'project-config.yml',
      cwd: '/repo',
      dryRun: false,
      verbose: false,
      quiet: false,
      json: false,
      noReport: true,
    });

    // Warning should reference the breaking packages from result.scan
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('Breaking-change updates skipped for'),
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('lodash, express'),
    );

    // runScanner must NOT have been called (no standalone pre-scan)
    expect(runScanner).not.toHaveBeenCalled();

    stderrSpy.mockRestore();
  });

  it('returns exit code 1 and emits stderr when require_upload is true and saveReport returns cloudError (executive report)', async () => {
    vi.mocked(runScanner).mockResolvedValue(scanResult);
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
        ...configWithOutputs,
        cloud_storage: { provider: 'google_drive', folder_id: 'abc123', require_upload: true },
      },
      runner: { environment: 'local', run: vi.fn(), runArgs: vi.fn() },
    };

    const code = await runFixCommand(ctx, {
      config: 'project-config.yml',
      cwd: '/repo',
      dryRun: false,
      verbose: false,
      quiet: false,
      json: false,
      noReport: false,
    });

    expect(code).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('Cloud upload required but failed'),
    );

    stderrSpy.mockRestore();
  });

  it('returns exit code 1 and emits stderr when require_upload is true and saveReport returns cloudError (sonarqube html)', async () => {
    vi.mocked(runScanner).mockResolvedValue(scanResult);
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
        ...configWithOutputs,
        cloud_storage: { provider: 'google_drive', folder_id: 'abc123', require_upload: true },
      },
      runner: { environment: 'local', run: vi.fn(), runArgs: vi.fn() },
    };

    const code = await runFixCommand(ctx, {
      config: 'project-config.yml',
      cwd: '/repo',
      dryRun: false,
      verbose: false,
      quiet: false,
      json: false,
      noReport: false,
    });

    expect(code).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('Cloud upload required but failed (SonarQube HTML)'),
    );

    stderrSpy.mockRestore();
  });

  it('does NOT return exit code 1 when cloudError is set but require_upload is false', async () => {
    vi.mocked(runScanner).mockResolvedValue(scanResult);
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
        ...configWithOutputs,
        cloud_storage: { provider: 'google_drive', folder_id: 'abc123', require_upload: false },
      },
      runner: { environment: 'local', run: vi.fn(), runArgs: vi.fn() },
    };

    const code = await runFixCommand(ctx, {
      config: 'project-config.yml',
      cwd: '/repo',
      dryRun: false,
      verbose: false,
      quiet: false,
      json: false,
      noReport: false,
    });

    // Cloud error without require_upload must not force exit code 1
    expect(code).toBe(0);
  });

  it('calls writeAuditTrail once with cwd and matching dry_run flag', async () => {
    vi.mocked(runOrchestrator).mockResolvedValue({
      scan: scanResult,
      updates: {},
      overallStatus: 'success',
      warnings: [],
      aggregated: undefined,
      advisorResults: {},
    });

    const ctx: RunContext = {
      config: configWithOutputs,
      runner: { environment: 'local', run: vi.fn(), runArgs: vi.fn() },
    };

    await runFixCommand(ctx, {
      config: 'project-config.yml',
      cwd: '/repo',
      dryRun: true,
      verbose: false,
      quiet: false,
      json: false,
      noReport: true,
    });

    expect(writeAuditTrail).toHaveBeenCalledTimes(1);
    const [calledCwd, calledRecord] = vi.mocked(writeAuditTrail).mock.calls[0];
    expect(calledCwd).toBe('/repo');
    expect(calledRecord.dry_run).toBe(true);
  });
});
