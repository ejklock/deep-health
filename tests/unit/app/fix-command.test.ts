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
  saveReport: vi.fn(),
  resolveReportsDir: vi.fn(() => '/abs/reports'),
  resolveEngineReportsDir: vi.fn(() => '/abs/reports'),
}));

import { runScanner } from '@modules/scanner/index';
import { runOrchestrator } from '@orchestration/orchestrator';
import { writeOutput } from '@app/output-writer';
import { runFixCommand } from '@app/commands/fix';
import { saveReport } from '@app/report-saver';
import { generateSonarQubeHtmlReport } from '@reporting/sonarqube-report';

const configWithOutputs: ProjectConfig = {
  project: { name: 'Demo App', client: 'Client' },
  ecosystems: [{ id: 'npm' }],
  protected_packages: { npm: [] },
  safe_update_policy: {
    allow_patch_and_minor_within_constraints: true,
    require_authorization_for_constraint_change: true,
  },
  conflict_resolution: 'stop_and_ask',
  outputs: { formats: ['markdown'], dir: '.deep-health/reports' },
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
      runner: { environment: 'local', run: vi.fn() },
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
      runner: { environment: 'local', run: vi.fn() },
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
        outputs: { formats: [], dir: '.deep-health/reports' },
      },
      runner: { environment: 'local', run: vi.fn() },
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
      runner: { environment: 'local', run: vi.fn() },
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
      runner: { environment: 'local', run: vi.fn() },
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
      runner: { environment: 'local', run: vi.fn() },
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
      runner: { environment: 'local', run: vi.fn() },
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
});
