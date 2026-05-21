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
  outputs: { formats: ['markdown'], dir: '.security-scan/reports' },
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
        outputs: { formats: ['markdown'], dir: '.security-scan/reports', sub_folders: true },
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
        outputs: { dir: '.security-scan/reports' } as any, // no formats
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

// ─── Phase 4: createBranchAndCommit / buildBranchName / openPr ───────────────

import { createBranchAndCommit, buildBranchName } from '@infra/utils/git-commit';

function makeRunArgs(responses: Record<string, { exitCode: number; stdout?: string; stderr?: string }>) {
  return vi.fn().mockImplementation((_file: string, args: string[]) => {
    const key = args.join(' ');
    const r = responses[key] ?? { exitCode: 0, stdout: '', stderr: '' };
    return Promise.resolve({ exitCode: r.exitCode, stdout: r.stdout ?? '', stderr: r.stderr ?? '', command: key, dryRun: false });
  });
}

describe('createBranchAndCommit()', () => {
  it('creates branch with correct name via runArgs', async () => {
    const runArgs = makeRunArgs({
      'checkout -b my-branch': { exitCode: 0 },
      'add -A': { exitCode: 0 },
      'commit -m fix: test': { exitCode: 0 },
    });
    const runner = { runArgs, run: vi.fn(), dryRun: false, environment: 'local' as const };

    await createBranchAndCommit(runner, '/repo', 'main', 'my-branch', 'fix: test', async () => 0);

    expect(runArgs).toHaveBeenCalledWith('git', ['checkout', '-b', 'my-branch'], { cwd: '/repo' });
  });

  it('commits on success: git add -A then git commit -m <msg>', async () => {
    const runArgs = makeRunArgs({
      'checkout -b new-branch': { exitCode: 0 },
      'add -A': { exitCode: 0 },
      'commit -m fix: apply': { exitCode: 0 },
    });
    const runner = { runArgs, run: vi.fn(), dryRun: false, environment: 'local' as const };

    const result = await createBranchAndCommit(runner, '/repo', 'main', 'new-branch', 'fix: apply', async () => 0);

    expect(runArgs).toHaveBeenCalledWith('git', ['add', '-A'], { cwd: '/repo' });
    expect(runArgs).toHaveBeenCalledWith('git', ['commit', '-m', 'fix: apply'], { cwd: '/repo' });
    expect(result.committed).toBe(true);
    expect(result.branch).toBe('new-branch');
    expect(result.exitCode).toBe(0);
  });

  it('rolls back to originalBranch when fn() throws and re-throws the error', async () => {
    const runArgs = makeRunArgs({
      'checkout -b fail-branch': { exitCode: 0 },
      'checkout main': { exitCode: 0 },
    });
    const runner = { runArgs, run: vi.fn(), dryRun: false, environment: 'local' as const };

    const boom = new Error('pipeline failed');
    await expect(
      createBranchAndCommit(runner, '/repo', 'main', 'fail-branch', 'fix: x', async () => { throw boom; }),
    ).rejects.toThrow('pipeline failed');

    expect(runArgs).toHaveBeenCalledWith('git', ['checkout', 'main'], { cwd: '/repo' });
  });

  it('returns { committed: false, exitCode: N } without throwing when fn() returns non-zero', async () => {
    const runArgs = makeRunArgs({
      'checkout -b nonzero-branch': { exitCode: 0 },
      'checkout main': { exitCode: 0 },
      'branch -D nonzero-branch': { exitCode: 0 },
    });
    const runner = { runArgs, run: vi.fn(), dryRun: false, environment: 'local' as const };

    const result = await createBranchAndCommit(runner, '/repo', 'main', 'nonzero-branch', 'fix: x', async () => 2);

    // Must NOT throw
    expect(result.committed).toBe(false);
    expect(result.exitCode).toBe(2);

    // Rollback: checkout originalBranch then branch -D
    expect(runArgs).toHaveBeenCalledWith('git', ['checkout', 'main'], { cwd: '/repo' });
    expect(runArgs).toHaveBeenCalledWith('git', ['branch', '-D', 'nonzero-branch'], { cwd: '/repo' });

    // git add -A must NOT have been called (no commit on non-zero exit)
    const addCalls = runArgs.mock.calls.filter(
      ([_file, args]: [string, string[]]) => args[0] === 'add',
    );
    expect(addCalls).toHaveLength(0);
  });

  it('returns committed=false when commit reports nothing to commit', async () => {
    const runArgs = makeRunArgs({
      'checkout -b clean-branch': { exitCode: 0 },
      'add -A': { exitCode: 0 },
      'commit -m fix: x': { exitCode: 1, stdout: 'nothing to commit, working tree clean' },
    });
    const runner = { runArgs, run: vi.fn(), dryRun: false, environment: 'local' as const };

    const result = await createBranchAndCommit(runner, '/repo', 'main', 'clean-branch', 'fix: x', async () => 0);

    expect(result.committed).toBe(false);
    expect(result.exitCode).toBe(0);
  });
});

describe('buildBranchName()', () => {
  it('returns a string starting with the given prefix', () => {
    const name = buildBranchName('fix/security-scan-');
    expect(name.startsWith('fix/security-scan-')).toBe(true);
  });

  it('replaces colons in the timestamp for filesystem safety', () => {
    const name = buildBranchName('fix/security-scan-');
    expect(name).not.toContain(':');
  });
});

describe('runFixCommand() — --open-pr: gh not installed', () => {
  beforeEach(() => vi.clearAllMocks());

  it('exits with code 3 when gh --version fails', async () => {
    vi.mocked(runOrchestrator).mockResolvedValue({
      scan: null,
      updates: {},
      overallStatus: 'success',
      hasPendingVulns: false,
      warnings: [],
      aggregated: undefined,
      advisorResults: {},
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number | string) => { throw new Error('process.exit'); });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    // runArgs: checkout -b succeeds, add -A succeeds, commit succeeds, gh --version fails
    const runArgs = vi.fn().mockImplementation((_file: string, args: string[]) => {
      const key = args.join(' ');
      if (key === '--version' && _file === 'gh') return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'not found', command: key, dryRun: false });
      if (key.startsWith('rev-parse')) return Promise.resolve({ exitCode: 0, stdout: 'main', stderr: '', command: key, dryRun: false });
      return Promise.resolve({ exitCode: 0, stdout: 'ok', stderr: '', command: key, dryRun: false });
    });
    const ctx: RunContext = {
      config,
      runner: { environment: 'local' as const, run: vi.fn(), runArgs, dryRun: false },
    };

    await expect(
      runFixCommand(ctx, {
        config: 'project-config.yml',
        cwd: '/repo',
        dryRun: false,
        verbose: false,
        quiet: false,
        json: false,
        noReport: true,
        openPr: true,
      }),
    ).rejects.toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(3);
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });
});

describe('runFixCommand() — dry-run skips branch creation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not call git commands when dryRun=true even with createBranch=true', async () => {
    vi.mocked(runOrchestrator).mockResolvedValue({
      scan: null,
      updates: {},
      overallStatus: 'success',
      hasPendingVulns: false,
      warnings: [],
      aggregated: undefined,
      advisorResults: {},
    });

    const runArgs = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', command: '', dryRun: true });
    const ctx: RunContext = {
      config,
      runner: { environment: 'local' as const, run: vi.fn(), runArgs, dryRun: true },
    };

    await runFixCommand(ctx, {
      config: 'project-config.yml',
      cwd: '/repo',
      dryRun: true,
      verbose: false,
      quiet: false,
      json: false,
      noReport: true,
      createBranch: true,
    });

    // runArgs should NOT have been called with checkout -b
    const checkoutCalls = runArgs.mock.calls.filter(
      ([_file, args]: [string, string[]]) => args.includes('-b'),
    );
    expect(checkoutCalls).toHaveLength(0);
  });
});

describe('runFixCommand() — --open-pr: push + gh pr create called, PR URL printed', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls git push origin <branch> then gh pr create, and prints the PR URL', async () => {
    vi.mocked(runOrchestrator).mockResolvedValue({
      scan: null,
      updates: {},
      overallStatus: 'success',
      hasPendingVulns: false,
      warnings: [],
      aggregated: undefined,
      advisorResults: {},
    });

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const runArgs = vi.fn().mockImplementation((file: string, args: string[]) => {
      const key = args.join(' ');
      if (file === 'git' && key.startsWith('rev-parse')) {
        return Promise.resolve({ exitCode: 0, stdout: 'main', stderr: '', command: key, dryRun: false });
      }
      if (file === 'gh' && key === '--version') {
        return Promise.resolve({ exitCode: 0, stdout: 'gh version 2.0.0', stderr: '', command: key, dryRun: false });
      }
      if (file === 'gh' && key.startsWith('pr create')) {
        return Promise.resolve({ exitCode: 0, stdout: 'https://github.com/org/repo/pull/42\n', stderr: '', command: key, dryRun: false });
      }
      // git commit → return committed output
      if (file === 'git' && key.startsWith('commit')) {
        return Promise.resolve({ exitCode: 0, stdout: '[branch abc] fix', stderr: '', command: key, dryRun: false });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', command: key, dryRun: false });
    });

    const ctx: RunContext = {
      config,
      runner: { environment: 'local' as const, run: vi.fn(), runArgs, dryRun: false },
    };

    const code = await runFixCommand(ctx, {
      config: 'project-config.yml',
      cwd: '/repo',
      dryRun: false,
      verbose: false,
      quiet: false,
      json: false,
      noReport: true,
      openPr: true,
    });

    expect(code).toBe(0);

    const pushCalls = runArgs.mock.calls.filter(
      ([file, args]: [string, string[]]) => file === 'git' && args[0] === 'push',
    );
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0][1][0]).toBe('push');
    expect(pushCalls[0][1][1]).toBe('origin');

    const prCreateCalls = runArgs.mock.calls.filter(
      ([file, args]: [string, string[]]) => file === 'gh' && args[0] === 'pr',
    );
    expect(prCreateCalls).toHaveLength(1);

    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('https://github.com/org/repo/pull/42'));
    stdoutSpy.mockRestore();
  });
});
