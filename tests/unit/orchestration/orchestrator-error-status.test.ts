/**
 * Coverage top-up for orchestrator.ts lines 895-899:
 *  - updateResult.status === "error" branch sets overallStatus and breaks
 *
 * Requires mocking @core/gates/validator to return valid:true even for
 * error-status results (otherwise the gate throws GateValidationError first).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@infra/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@infra/utils/git-branch.js', () => ({
  detectGitBranch: vi.fn().mockResolvedValue(null),
}));
vi.mock('@infra/provisioner/npm-runner.js', () => ({
  NpmDockerRunner: vi.fn().mockImplementation(() => ({})),
  resolveNpmDockerImage: vi.fn(() => 'node:lts'),
}));
vi.mock('@infra/provisioner/osv-runner.js', () => ({
  OsvDockerRunner: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('@infra/provisioner/pip-runner.js', () => ({
  PipDockerRunner: vi.fn().mockImplementation(() => ({})),
  resolvePipDockerImage: vi.fn(() => 'python:3-slim'),
}));
vi.mock('@infra/provisioner/composer-runner.js', () => ({
  ComposerDockerRunner: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('@infra/provisioner/php-image-resolver.js', () => ({
  resolveComposerDockerImage: vi.fn(() => 'composer:2'),
}));
vi.mock('@infra/executor/npm-container-runner.js', () => ({
  NpmContainerCommandRunner: vi.fn().mockImplementation((opts: { dryRun?: boolean }) => ({
    run: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, command: '', dryRun: false }),
    runArgs: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, command: '', dryRun: false }),
    dryRun: opts?.dryRun ?? false,
    environment: 'local',
  })),
}));
vi.mock('@infra/executor/osv-container-runner.js', () => ({
  OsvContainerCommandRunner: vi.fn().mockImplementation(() => ({
    run: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, command: '', dryRun: false }),
    runArgs: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, command: '', dryRun: false }),
    dryRun: false,
    environment: 'local',
  })),
}));
vi.mock('@infra/executor/pip-container-runner.js', () => ({
  PipContainerCommandRunner: vi.fn().mockImplementation(() => ({
    run: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, command: '', dryRun: false }),
    runArgs: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, command: '', dryRun: false }),
    dryRun: false,
    environment: 'local',
  })),
}));
vi.mock('@infra/executor/composer-container-runner.js', () => ({
  ComposerContainerCommandRunner: vi.fn().mockImplementation(() => ({
    run: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, command: '', dryRun: false }),
    runArgs: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, command: '', dryRun: false }),
    dryRun: false,
    environment: 'local',
  })),
}));
vi.mock('@orchestration/osv-fix-applier.js', () => ({
  applyOsvFixViaStaging: vi.fn().mockResolvedValue({
    applied: false,
    packagesUpdated: [],
    backups: new Map(),
  }),
}));
vi.mock('@orchestration/lockfile-inspect.js', () => ({
  readNpmLockfileVersion: vi.fn().mockResolvedValue(null),
}));
vi.mock('@modules/advisor/index.js', () => ({
  runAdvisors: vi.fn().mockResolvedValue([]),
}));

// Mock gate validator to return valid:true always — bypasses the gate throw
// so the status==="error" check at line 895 can be reached.
vi.mock('@core/gates/validator.js', () => ({
  validateGateA: vi.fn().mockReturnValue({ valid: true, gate: 'A', errors: [] }),
  validateEcosystemGate: vi.fn().mockReturnValue({ valid: true, gate: 'npm', errors: [] }),
}));

import { runOrchestrator } from '@orchestration/orchestrator';
import { ScannerEngineRegistry } from '@modules/scanner/registry';
import { OsvScannerEngine } from '@modules/scanner/osv-engine';
import { npmPlugin } from '@modules/ecosystem/plugins/npm';
import type { CommandRunner, CommandResult, CommandRunnerOptions } from '@core/types/common';
import type { ProjectConfig } from '@core/types/config';

class MockCommandRunner implements CommandRunner {
  readonly dryRun = false;
  readonly environment = 'local' as const;
  constructor(private responses: Record<string, { stdout: string; exitCode: number }> = {}) {}
  async run(command: string): Promise<CommandResult> {
    for (const [key, val] of Object.entries(this.responses)) {
      if (command.includes(key)) return { stdout: val.stdout, stderr: '', exitCode: val.exitCode, command, dryRun: false };
    }
    return { stdout: '', stderr: '', exitCode: 0, command, dryRun: false };
  }
  async runArgs(file: string, args: string[], _opts?: CommandRunnerOptions): Promise<CommandResult> {
    return this.run([file, ...args].join(' '));
  }
}

function makeRegistry(): ScannerEngineRegistry {
  const reg = new ScannerEngineRegistry();
  reg.register(new OsvScannerEngine());
  return reg;
}

function npmScanOutput(): string {
  return JSON.stringify({
    results: [{
      source: { path: 'package-lock.json', type: 'lockfile' },
      packages: [{
        package: { name: 'lodash', version: '4.17.15', ecosystem: 'npm' },
        vulnerabilities: [{
          id: 'GHSA-test-npm',
          summary: 'Test npm vuln',
          affected: [{
            package: { ecosystem: 'npm', name: 'lodash' },
            ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.17.21' }] }],
          }],
        }],
        groups: [{ ids: ['GHSA-test-npm'] }],
      }],
    }],
  });
}

describe('orchestrator — updateResult.status=error sets overallStatus (lines 895-899)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sets result.overallStatus to "error" and breaks the loop (lines 895-899)', async () => {
    const errorUpdaterResult = {
      $schema: 'osv-update-result/v1',
      agent: 'deep-health/test',
      status: 'error' as const,
      packages_updated: [],
      packages_skipped: [],
      packages_pending_breaking: [],
      validations: [{ name: 'validation', status: 'skipped' as const }],
      error: 'Updater failed for testing',
    };

    const runUpdaterSpy = vi.spyOn(npmPlugin, 'runUpdater').mockResolvedValue(errorUpdaterResult);

    const runner = new MockCommandRunner({
      '--lockfile package-lock.json --format json': { stdout: npmScanOutput(), exitCode: 0 },
    });

    const config: ProjectConfig = {
      project: { name: 'Test', client: 'Test' },
      ecosystems: [{ id: 'npm', validationCommands: [], advisors: [] }],
      protected_packages: { npm: [], composer: [], pip: [] },
      safe_update_policy: {
        allow_patch_and_minor_within_constraints: true,
        require_authorization_for_constraint_change: true,
      },
      conflict_resolution: 'stop_and_ask',
      scanners: { osv: { runner: 'local' } },
    } as ProjectConfig;

    const result = await runOrchestrator(runner, config, {
      configPath: 'config.yml',
      cwd: '/project',
      dryRun: false,
      verbose: false,
      scannerRegistry: makeRegistry(),
    });

    expect(result.overallStatus).toBe('error');
    runUpdaterSpy.mockRestore();
  });
});
