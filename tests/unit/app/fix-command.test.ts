import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunContext } from '@app/run-context';
import type { ProjectConfig } from '@core/types/config';

vi.mock('@modules/scanner/index', () => ({
  runScanner: vi.fn(),
}));

vi.mock('@orchestration/orchestrator', () => ({
  runOrchestrator: vi.fn(),
}));

vi.mock('@reporting/consolidated', () => ({
  generateConsolidatedReport: vi.fn(() => '# consolidated report'),
}));

vi.mock('@reporting/executive', () => ({
  generateExecutiveReport: vi.fn(() => '# executive report'),
  executiveReportFilename: vi.fn(() => 'executive.md'),
  consolidatedReportFilename: vi.fn(() => 'consolidated.md'),
}));

vi.mock('@app/output-writer', () => ({
  writeOutput: vi.fn(),
}));

vi.mock('@app/report-saver', () => ({
  saveReport: vi.fn(),
  resolveReportsDir: vi.fn(() => '/abs/reports'),
}));

import { runScanner } from '@modules/scanner/index';
import { runOrchestrator } from '@orchestration/orchestrator';
import { writeOutput } from '@app/output-writer';
import { runFixCommand } from '@app/commands/fix';
import { saveReport } from '@app/report-saver';

const configWithOutputs: ProjectConfig = {
  project: { name: 'Demo App', client: 'Client' },
  runtime: { execution: 'local', docker_service: 'app' },
  ecosystems: [{ id: 'npm' }],
  protected_packages: { npm: [] },
  safe_update_policy: {
    allow_patch_and_minor_within_constraints: true,
    require_authorization_for_constraint_change: true,
    authorization_format: 'yes',
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
  });

  it('saves consolidated report in reportsDir when markdown output enabled', async () => {
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
    expect(writeOutput).toHaveBeenCalled();
    expect(saveReport).toHaveBeenCalledWith(
      'consolidated.md',
      '# consolidated report',
      '/abs/reports',
      undefined,
      '/repo',
    );
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
});
