import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CommandResult, CommandRunner, CommandRunnerOptions, ExecutionEnv } from '@core/types/common';
import type { ProjectConfig } from '@core/types/config';
import type { ScannerEngine } from '@modules/scanner/types';
import { ScannerEngineRegistry } from '@modules/scanner/registry';
import { OSV_ENGINE_ID } from '@modules/scanner/aggregator';

vi.mock('@infra/utils/git-branch', () => ({
  detectGitBranch: vi.fn().mockResolvedValue('main'),
}));

import { detectGitBranch } from '@infra/utils/git-branch';
import { bootstrapDefaultEngines, runScanner } from '@modules/scanner/index';

class MockRunner implements CommandRunner {
  readonly dryRun = false;
  readonly environment: ExecutionEnv = 'local';

  async run(command: string, _opts?: CommandRunnerOptions): Promise<CommandResult> {
    return { stdout: '', stderr: '', exitCode: 0, command, dryRun: this.dryRun };
  }

  async runArgs(file: string, args: string[], _opts?: CommandRunnerOptions): Promise<CommandResult> {
    const command = [file, ...args].join(' ');
    return this.run(command, _opts);
  }
}

function makeConfig(): ProjectConfig {
  return {
    project: { name: 'test', client: 'test' },
    ecosystems: [{ id: 'npm' }],
    protected_packages: {},
    safe_update_policy: {
      allow_patch_and_minor_within_constraints: true,
      require_authorization_for_constraint_change: false,
    },
    conflict_resolution: 'fail',
  } as ProjectConfig;
}

function makeEcosystemRegistry() {
  return {
    getAll: () => [],
    register: vi.fn(),
    get: vi.fn(),
    findByOsvEcosystem: vi.fn(),
  } as any;
}

describe('scanner module index: bootstrap + runScanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('bootstrapDefaultEngines is idempotent (no double-registration on repeated calls)', () => {
    const registry = new ScannerEngineRegistry();

    bootstrapDefaultEngines(registry as any);
    bootstrapDefaultEngines(registry as any);

    const ids = registry.getAll().map((e) => e.id);
    expect(ids).toEqual(['osv', 'sonarqube']);
  });

  it('runScanner uses injected scannerRegistry and executes only OSV engine', async () => {
    const osvScan = vi.fn().mockResolvedValue({
      $schema: 'scan-result/v1',
      agent: 'osv-scanner',
      status: 'success',
      environment: { dry_run: false, cwd: '/tmp/project', platform: process.platform },
      ecosystems: {},
    });
    const sonarScan = vi.fn().mockResolvedValue({
      $schema: 'sonarqube-scan-result/v1',
      agent: 'sonarqube',
      status: 'success',
      ecosystems: {},
    });

    const registry = new ScannerEngineRegistry();
    registry.register({
      id: OSV_ENGINE_ID,
      name: 'OSV',
      assertAvailable: vi.fn(),
      scan: osvScan,
    } as unknown as ScannerEngine);
    registry.register({
      id: 'sonarqube',
      name: 'SonarQube',
      assertAvailable: vi.fn(),
      scan: sonarScan,
    } as unknown as ScannerEngine);

    const result = await runScanner(
      new MockRunner(),
      makeConfig(),
      '/tmp/project',
      makeEcosystemRegistry(),
      registry as any,
    );

    expect(result.status).toBe('success');
    expect(osvScan).toHaveBeenCalledTimes(1);
    expect(sonarScan).not.toHaveBeenCalled();
    expect(vi.mocked(detectGitBranch)).toHaveBeenCalledWith('/tmp/project', expect.any(MockRunner));
  });

  it('runScanner throws clear error when injected scannerRegistry has no OSV engine', async () => {
    const registry = new ScannerEngineRegistry();
    // Non-OSV engine present to ensure lookup is by canonical OSV engine id.
    registry.register({
      id: 'sonarqube',
      name: 'SonarQube',
      assertAvailable: vi.fn(),
      scan: vi.fn(),
    } as unknown as ScannerEngine);

    await expect(
      runScanner(
        new MockRunner(),
        makeConfig(),
        '/tmp/project',
        makeEcosystemRegistry(),
        registry as any,
      ),
    ).rejects.toThrow('OSV scanner engine ("osv") is not registered in the scanner registry');
  });

  it('runScanner does not auto-bootstrap a custom injected scannerRegistry', async () => {
    const registry = new ScannerEngineRegistry();

    await expect(
      runScanner(
        new MockRunner(),
        makeConfig(),
        '/tmp/project',
        makeEcosystemRegistry(),
        registry as any,
      ),
    ).rejects.toThrow();

    expect(registry.has(OSV_ENGINE_ID)).toBe(false);
    expect(registry.getAll()).toHaveLength(0);
  });
});
