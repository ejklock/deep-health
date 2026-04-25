/**
 * Branch coverage top-up for src/app/commands/fix.ts
 * Targets:
 *   line 61: opts.phases is provided → split into array (phases branch)
 *   line 127: advisorResults with entries → passes them to generateExecutiveReport
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunContext } from '@app/run-context';
import type { ProjectConfig } from '@core/types/config';

vi.mock('@modules/scanner/index', () => ({
  runScanner: vi.fn(),
}));

vi.mock('@orchestration/orchestrator', () => ({
  runOrchestrator: vi.fn(),
}));

vi.mock('@reporting/executive', () => ({
  generateExecutiveReport: vi.fn(() => '# report'),
  executiveReportFilename: vi.fn(() => 'report.md'),
}));

vi.mock('@reporting/sonarqube-report', () => ({
  generateSonarQubeHtmlReport: vi.fn(() => null),
  sonarqubeHtmlReportFilename: vi.fn(() => 'sonar.html'),
}));

vi.mock('@app/output-writer', () => ({
  writeOutput: vi.fn(),
}));

vi.mock('@app/report-saver', () => ({
  saveReport: vi.fn().mockResolvedValue({ localUrl: '/reports/report.md', cloudSkipped: true }),
  resolveReportsDir: vi.fn(() => '/reports'),
  resolveEngineReportsDir: vi.fn(() => '/reports'),
}));

vi.mock('@app/audit-trail', () => ({
  writeAuditTrail: vi.fn().mockResolvedValue(undefined),
  resolveCliVersion: vi.fn().mockResolvedValue('1.0.0'),
}));

import { runScanner } from '@modules/scanner/index';
import { runOrchestrator } from '@orchestration/orchestrator';
import { generateExecutiveReport } from '@reporting/executive';
import { runFixCommand } from '@app/commands/fix';

const config: ProjectConfig = {
  project: { name: 'App', client: 'Client' },
  ecosystems: [{ id: 'npm' }],
  protected_packages: { npm: [] },
  safe_update_policy: {
    allow_patch_and_minor_within_constraints: true,
    require_authorization_for_constraint_change: true,
  },
  conflict_resolution: 'stop_and_ask',
  outputs: { formats: ['markdown'], dir: '.deep-health/reports' },
} as unknown as ProjectConfig;

const scanResult = {
  agent: 'osv-scanner' as const,
  status: 'success' as const,
  environment: 'local',
  ecosystems: {},
  error: null,
};

function makeCtx(): RunContext {
  return {
    config,
    runner: { environment: 'local' as const, run: vi.fn(), runArgs: vi.fn(), dryRun: false },
  };
}

describe('runFixCommand() — phases split branch (line 61)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes phases array to runOrchestrator when opts.phases is a comma-separated string', async () => {
    vi.mocked(runScanner).mockResolvedValue(scanResult);
    vi.mocked(runOrchestrator).mockResolvedValue({
      scan: scanResult,
      updates: {},
      overallStatus: 'success',
      hasPendingVulns: false,
      warnings: [],
      aggregated: undefined,
      advisorResults: {},
    });

    await runFixCommand(makeCtx(), {
      config: 'project-config.yml',
      cwd: '/repo',
      dryRun: false,
      verbose: false,
      quiet: false,
      json: false,
      noReport: true,
      phases: 'scan,npm',
    });

    expect(runOrchestrator).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ phases: ['scan', 'npm'] }),
    );
  });
});

describe('runFixCommand() — advisorResults branch (line 127)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes advisorResults to generateExecutiveReport when they are non-empty', async () => {
    vi.mocked(runScanner).mockResolvedValue(scanResult);
    vi.mocked(runOrchestrator).mockResolvedValue({
      scan: scanResult,
      updates: {},
      overallStatus: 'success',
      hasPendingVulns: false,
      warnings: [],
      aggregated: undefined,
      advisorResults: {
        npm: [{ name: 'audit', command: 'npm audit', exitCode: 0, output: '', status: 'clean' }],
      },
    });

    await runFixCommand(makeCtx(), {
      config: 'project-config.yml',
      cwd: '/repo',
      dryRun: false,
      verbose: false,
      quiet: false,
      json: false,
      noReport: false,
    });

    expect(generateExecutiveReport).toHaveBeenCalledWith(
      expect.objectContaining({
        advisorResults: expect.objectContaining({ npm: expect.any(Array) }),
      }),
    );
  });
});

describe('runFixCommand() — breaking packages warning branch (lines 92-109)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes stderr warning when scan has breaking packages for an active plugin not authorized', async () => {
    vi.mocked(runScanner).mockResolvedValue(scanResult);
    vi.mocked(runOrchestrator).mockResolvedValue({
      scan: {
        ...scanResult,
        ecosystems: {
          npm: {
            vulnerabilities_total: 1,
            auto_safe: 0,
            breaking: 1,
            manual: 0,
            auto_safe_packages: [],
            breaking_packages: ['lodash'],
            manual_packages: [],
            vulnerabilities: [],
          },
        },
      },
      updates: {},
      overallStatus: 'success',
      hasPendingVulns: true,
      warnings: [],
      aggregated: undefined,
      advisorResults: {},
    });

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await runFixCommand(makeCtx(), {
      config: 'project-config.yml',
      cwd: '/repo',
      dryRun: false,
      verbose: false,
      quiet: false,
      json: false,
      noReport: true,
    });

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Breaking-change updates skipped'));
    stderrSpy.mockRestore();
  });
});

describe('runFixCommand() — return codes (lines 186-187)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 1 when overallStatus is error', async () => {
    vi.mocked(runScanner).mockResolvedValue(scanResult);
    vi.mocked(runOrchestrator).mockResolvedValue({
      scan: null,
      updates: {},
      overallStatus: 'error',
      hasPendingVulns: false,
      warnings: [],
      aggregated: undefined,
      advisorResults: {},
    });

    const code = await runFixCommand(makeCtx(), {
      config: 'project-config.yml',
      cwd: '/repo',
      dryRun: false,
      verbose: false,
      quiet: false,
      json: false,
      noReport: true,
    });

    expect(code).toBe(1);
  });

  it('returns 1 when hasPendingVulns is true', async () => {
    vi.mocked(runScanner).mockResolvedValue(scanResult);
    vi.mocked(runOrchestrator).mockResolvedValue({
      scan: scanResult,
      updates: {},
      overallStatus: 'success',
      hasPendingVulns: true,
      warnings: [],
      aggregated: undefined,
      advisorResults: {},
    });

    const code = await runFixCommand(makeCtx(), {
      config: 'project-config.yml',
      cwd: '/repo',
      dryRun: false,
      verbose: false,
      quiet: false,
      json: false,
      noReport: true,
    });

    expect(code).toBe(1);
  });
});

describe('runFixCommand() — branch coverage top-up', () => {
  beforeEach(() => vi.clearAllMocks());

  it('handles ecosystem with undefined breaking/breaking_packages (lines 92,95 ?? branches)', async () => {
    vi.mocked(runScanner).mockResolvedValue(scanResult);
    vi.mocked(runOrchestrator).mockResolvedValue({
      scan: {
        ...scanResult,
        ecosystems: {
          npm: {
            vulnerabilities_total: 0,
            auto_safe: 0,
            breaking: undefined as any,
            manual: 0,
            auto_safe_packages: [],
            breaking_packages: undefined as any,
            manual_packages: [],
            vulnerabilities: [],
          },
        },
      },
      updates: {},
      overallStatus: 'success',
      hasPendingVulns: false,
      warnings: [],
      aggregated: undefined,
      advisorResults: {},
    });

    const code = await runFixCommand(makeCtx(), {
      config: 'project-config.yml',
      cwd: '/repo',
      dryRun: false,
      verbose: false,
      quiet: false,
      json: false,
      noReport: true,
    });
    expect(code).toBe(0);
  });

  it('uses "unknown" when breaking_packages is empty array (line 95 || branch)', async () => {
    vi.mocked(runScanner).mockResolvedValue(scanResult);
    vi.mocked(runOrchestrator).mockResolvedValue({
      scan: {
        ...scanResult,
        ecosystems: {
          npm: {
            vulnerabilities_total: 1,
            auto_safe: 0,
            breaking: 1,
            manual: 0,
            auto_safe_packages: [],
            breaking_packages: [],
            manual_packages: [],
            vulnerabilities: [],
          },
        },
      },
      updates: {},
      overallStatus: 'success',
      hasPendingVulns: false,
      warnings: [],
      aggregated: undefined,
      advisorResults: {},
    });

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await runFixCommand(makeCtx(), {
      config: 'project-config.yml',
      cwd: '/repo',
      dryRun: false,
      verbose: false,
      quiet: false,
      json: false,
      noReport: true,
    });
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('unknown'));
    stderrSpy.mockRestore();
  });

  it('uses sub_folders=true (line 106 true branch) and formats defined (line 109)', async () => {
    vi.mocked(runScanner).mockResolvedValue(scanResult);
    vi.mocked(runOrchestrator).mockResolvedValue({
      scan: scanResult,
      updates: {},
      overallStatus: 'success',
      hasPendingVulns: false,
      warnings: [],
      aggregated: undefined,
      advisorResults: {},
    });

    const ctx: RunContext = {
      config: {
        ...config,
        outputs: { formats: ['markdown'], dir: '.deep-health/reports', sub_folders: true },
      },
      runner: { environment: 'local' as const, run: vi.fn(), runArgs: vi.fn(), dryRun: false },
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
    expect(code).toBe(0);
  });

  it('uses breaking_packages ?? [] fallback when breaking_packages is undefined (line 92 ?? right branch)', async () => {
    vi.mocked(runScanner).mockResolvedValue(scanResult);
    vi.mocked(runOrchestrator).mockResolvedValue({
      scan: {
        ...scanResult,
        ecosystems: {
          npm: {
            vulnerabilities_total: 1,
            auto_safe: 0,
            breaking: 1,
            manual: 0,
            auto_safe_packages: [],
            breaking_packages: undefined as any, // triggers ?? []
            manual_packages: [],
            vulnerabilities: [],
          },
        },
      },
      updates: {},
      overallStatus: 'success',
      hasPendingVulns: false,
      warnings: [],
      aggregated: undefined,
      advisorResults: {},
    });

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await runFixCommand(makeCtx(), {
      config: 'project-config.yml',
      cwd: '/repo',
      dryRun: false,
      verbose: false,
      quiet: false,
      json: false,
      noReport: true,
    });
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Breaking-change'));
    stderrSpy.mockRestore();
  });

  it('uses formats ?? [] fallback when formats is absent (line 109 ?? right branch)', async () => {
    vi.mocked(runScanner).mockResolvedValue(scanResult);
    vi.mocked(runOrchestrator).mockResolvedValue({
      scan: scanResult,
      updates: {},
      overallStatus: 'success',
      hasPendingVulns: false,
      warnings: [],
      aggregated: undefined,
      advisorResults: {},
    });

    const ctx: RunContext = {
      config: {
        ...config,
        outputs: { dir: '.deep-health/reports' } as any, // no formats
      },
      runner: { environment: 'local' as const, run: vi.fn(), runArgs: vi.fn(), dryRun: false },
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
  });
});
