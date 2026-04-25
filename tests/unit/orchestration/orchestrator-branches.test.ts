/**
 * Branch coverage top-up for orchestrator.ts
 *
 * runOrchestrator(runner, config, options) — note: takes pre-loaded config,
 * does NOT call loadConfig internally (that is the run-context layer's job).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@infra/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@infra/utils/git-branch', () => ({
  detectGitBranch: vi.fn().mockResolvedValue(null),
}));

vi.mock('@app/report-saver', () => ({
  resolveReportsDir: vi.fn().mockReturnValue('/tmp/reports'),
  resolveEngineReportsDir: vi.fn().mockReturnValue('/tmp/reports'),
  saveReport: vi.fn().mockResolvedValue({ localUrl: '/tmp/report.md', cloudSkipped: true }),
  saveSonarQubeExport: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@app/audit-trail', () => ({
  writeAuditTrail: vi.fn().mockResolvedValue(undefined),
}));

import { ScannerEngineRegistry } from '@modules/scanner/registry';
import { runOrchestrator } from '@orchestration/orchestrator';
import type { CommandRunner } from '@core/types/common';
import type { ProjectConfig } from '@core/types/config';

function makeRunner(): CommandRunner {
  return {
    run: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, command: '', dryRun: false }),
    runArgs: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, command: '', dryRun: false }),
    dryRun: false,
    environment: 'local' as const,
  };
}

const minimalConfig: ProjectConfig = {
  project: { name: 'test', client: 'acme' },
  ecosystems: [],
  protected_packages: {},
} as unknown as ProjectConfig;

describe('runOrchestrator() — branch coverage', () => {
  it('throws when OSV engine is not registered in the injected scannerRegistry', async () => {
    const emptyRegistry = new ScannerEngineRegistry();

    await expect(
      runOrchestrator(makeRunner(), minimalConfig, {
        configPath: 'project-config.yml',
        cwd: '/proj',
        dryRun: false,
        verbose: false,
        scannerRegistry: emptyRegistry,
      }),
    ).rejects.toThrow('OSV scanner engine is not registered');
  });

  it('returns skipped status when scan phase is excluded from phases list', async () => {
    const result = await runOrchestrator(makeRunner(), minimalConfig, {
      configPath: 'project-config.yml',
      cwd: '/proj',
      dryRun: false,
      verbose: false,
      phases: ['report'],
    });

    expect(result.overallStatus).toBe('skipped');
    expect(result.scan).toBeNull();
  });
});
