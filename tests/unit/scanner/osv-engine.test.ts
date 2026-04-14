/**
 * Unit tests for OsvScannerEngine.
 *
 * Covers:
 * - Runner selection: 'local', 'docker', 'auto' modes
 * - assertAvailable() behaviour for each mode
 * - scan() local path vs Docker path dispatch
 * - dry-run handling
 * - error propagation
 *
 * Mocks:
 * - OsvDockerRunner to avoid real Docker calls
 * - CommandRunner (inline MockRunner) to control local-binary responses
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OsvScannerEngine } from '@modules/scanner/osv-engine';
import { EnvironmentError } from '@core/errors';
import type { ScannerEngineContext } from '@modules/scanner/types';
import type { CommandRunner, CommandResult, CommandRunnerOptions, ExecutionEnv } from '@core/types/common';
import type { ProjectConfig } from '@core/types/config';
import type { EcosystemRegistry } from '@modules/ecosystem/registry';

// ─── Mock OsvDockerRunner ────────────────────────────────────────────────────

const mockDockerRun = vi.fn();

vi.mock('@infra/provisioner/osv-runner.js', () => ({
  OsvDockerRunner: vi.fn().mockImplementation(() => ({
    run: mockDockerRun,
  })),
}));

import { OsvDockerRunner } from '@infra/provisioner/osv-runner';

// ─── Helpers ─────────────────────────────────────────────────────────────────

class MockRunner implements CommandRunner {
  readonly dryRun: boolean;
  readonly environment: ExecutionEnv = 'local';
  readonly calledCommands: string[] = [];
  private responses: Map<string, Partial<CommandResult>>;

  constructor(
    responses: Record<string, Partial<CommandResult>> = {},
    options: { dryRun?: boolean } = {},
  ) {
    this.dryRun = options.dryRun ?? false;
    this.responses = new Map(Object.entries(responses));
  }

  async run(command: string, _opts?: CommandRunnerOptions): Promise<CommandResult> {
    this.calledCommands.push(command);
    for (const [key, resp] of this.responses) {
      if (command.includes(key)) {
        return { stdout: resp.stdout ?? '', stderr: resp.stderr ?? '', exitCode: resp.exitCode ?? 0, command, dryRun: this.dryRun };
      }
    }
    return { stdout: '', stderr: '', exitCode: 0, command, dryRun: this.dryRun };
  }

  async runArgs(file: string, args: string[], _opts?: CommandRunnerOptions): Promise<CommandResult> {
    const command = [file, ...args].join(' ');
    return this.run(command, _opts);
  }
}

const MINIMAL_SCAN_JSON = JSON.stringify({ results: [] });

function makeConfig(
  osvConfig?: ProjectConfig['scanners'],
): ProjectConfig {
  return {
    project: { name: 'test', client: 'test' },
    ecosystems: [{ id: 'npm' }],
    protected_packages: {},
    safe_update_policy: {
      allow_patch_and_minor_within_constraints: true,
      require_authorization_for_constraint_change: false,
    },
    conflict_resolution: 'fail',
    ...(osvConfig !== undefined ? { scanners: osvConfig } : {}),
  };
}

function makeEcosystemRegistry(buildScanArgsResult: string[] = []): EcosystemRegistry {
  return {
    getAll: () => [
      {
        id: 'npm',
        buildScanArgs: () => buildScanArgsResult,
        getProtectedPackages: () => [],
        findByOsvEcosystem: () => undefined,
      } as unknown as ReturnType<EcosystemRegistry['getAll']>[0],
    ],
    register: vi.fn(),
    get: vi.fn(),
    findByOsvEcosystem: vi.fn(),
  } as unknown as EcosystemRegistry;
}

function makeCtx(
  runner: CommandRunner,
  config: ProjectConfig,
  cwd = '/project',
): ScannerEngineContext {
  return {
    runner,
    config,
    cwd,
    ecosystemRegistry: makeEcosystemRegistry(['--lockfile', 'package-lock.json']),
    branch: null,
  };
}

// ─── assertAvailable ─────────────────────────────────────────────────────────

describe('OsvScannerEngine.assertAvailable()', () => {
  const engine = new OsvScannerEngine();

  afterEach(() => vi.clearAllMocks());

  describe('runner: local', () => {
    it('succeeds when osv-scanner --version exits 0', async () => {
      const runner = new MockRunner({ 'osv-scanner': { exitCode: 0 } });
      const ctx = makeCtx(runner, makeConfig({ osv: { runner: 'local' } }));
      await expect(engine.assertAvailable(ctx)).resolves.toBeUndefined();
    });

    it('throws EnvironmentError when local binary not found', async () => {
      const runner = new MockRunner({ 'osv-scanner': { exitCode: 1, stderr: 'not found' } });
      const ctx = makeCtx(runner, makeConfig({ osv: { runner: 'local' } }));
      await expect(engine.assertAvailable(ctx)).rejects.toThrow(EnvironmentError);
    });

    it('does not check docker in local mode', async () => {
      const runner = new MockRunner({ 'osv-scanner': { exitCode: 0 } });
      const ctx = makeCtx(runner, makeConfig({ osv: { runner: 'local' } }));
      await engine.assertAvailable(ctx);
      expect(runner.calledCommands.some((c) => c.includes('docker'))).toBe(false);
    });
  });

  describe('runner: docker', () => {
    it('succeeds when docker --version exits 0', async () => {
      const runner = new MockRunner({ 'docker': { exitCode: 0 } });
      const ctx = makeCtx(runner, makeConfig({ osv: { runner: 'docker' } }));
      await expect(engine.assertAvailable(ctx)).resolves.toBeUndefined();
    });

    it('throws EnvironmentError when docker is not found', async () => {
      const runner = new MockRunner({ 'docker': { exitCode: 1, stderr: 'not found' } });
      const ctx = makeCtx(runner, makeConfig({ osv: { runner: 'docker' } }));
      await expect(engine.assertAvailable(ctx)).rejects.toThrow(EnvironmentError);
    });

    it('does not check local osv-scanner in docker mode', async () => {
      const runner = new MockRunner({ 'docker': { exitCode: 0 } });
      const ctx = makeCtx(runner, makeConfig({ osv: { runner: 'docker' } }));
      await engine.assertAvailable(ctx);
      expect(runner.calledCommands.some((c) => c.includes('osv-scanner'))).toBe(false);
    });
  });

  describe('runner: auto (default)', () => {
    it('succeeds when local osv-scanner is available', async () => {
      const runner = new MockRunner({ 'osv-scanner': { exitCode: 0 } });
      const ctx = makeCtx(runner, makeConfig({ osv: { runner: 'auto' } }));
      await expect(engine.assertAvailable(ctx)).resolves.toBeUndefined();
    });

    it('falls back to Docker check when local is unavailable, and succeeds when Docker is available', async () => {
      const runner = new MockRunner({
        'osv-scanner': { exitCode: 1 },
        'docker': { exitCode: 0 },
      });
      const ctx = makeCtx(runner, makeConfig({ osv: { runner: 'auto' } }));
      await expect(engine.assertAvailable(ctx)).resolves.toBeUndefined();
    });

    it('throws EnvironmentError when both local and Docker are unavailable', async () => {
      const runner = new MockRunner({
        'osv-scanner': { exitCode: 1 },
        'docker': { exitCode: 1 },
      });
      const ctx = makeCtx(runner, makeConfig({ osv: { runner: 'auto' } }));
      await expect(engine.assertAvailable(ctx)).rejects.toThrow(EnvironmentError);
    });

    it('defaults to auto when scanners.osv is not configured', async () => {
      const runner = new MockRunner({ 'osv-scanner': { exitCode: 0 } });
      const ctx = makeCtx(runner, makeConfig());
      await expect(engine.assertAvailable(ctx)).resolves.toBeUndefined();
    });

    it('defaults to auto when scanners is undefined', async () => {
      const runner = new MockRunner({ 'osv-scanner': { exitCode: 0 } });
      const ctx = makeCtx(runner, makeConfig(undefined));
      await expect(engine.assertAvailable(ctx)).resolves.toBeUndefined();
    });
  });
});

// ─── scan() — runner dispatch ─────────────────────────────────────────────────

describe('OsvScannerEngine.scan() — runner dispatch', () => {
  const engine = new OsvScannerEngine();

  beforeEach(() => {
    mockDockerRun.mockResolvedValue({ exitCode: 0, stdout: MINIMAL_SCAN_JSON, stderr: '' });
    vi.mocked(OsvDockerRunner).mockClear();
    mockDockerRun.mockClear();
  });

  afterEach(() => vi.clearAllMocks());

  it('uses local runner when runner=local and local is available', async () => {
    const runner = new MockRunner({
      'osv-scanner --version': { exitCode: 0 },
      'osv-scanner': { exitCode: 0, stdout: MINIMAL_SCAN_JSON },
    });
    const ctx = makeCtx(runner, makeConfig({ osv: { runner: 'local' } }));
    const result = await engine.scan(ctx);
    expect(result.status).toBe('success');
    expect(vi.mocked(OsvDockerRunner)).not.toHaveBeenCalled();
  });

  it('uses Docker runner when runner=docker', async () => {
    const runner = new MockRunner({ 'docker': { exitCode: 0 } });
    const ctx = makeCtx(runner, makeConfig({ osv: { runner: 'docker' } }));
    const result = await engine.scan(ctx);
    expect(result.status).toBe('success');
    expect(vi.mocked(OsvDockerRunner)).toHaveBeenCalledOnce();
    expect(mockDockerRun).toHaveBeenCalledOnce();
  });

  it('uses Docker runner with custom image when runner=docker and image is set', async () => {
    const runner = new MockRunner({ 'docker': { exitCode: 0 } });
    const ctx = makeCtx(
      runner,
      makeConfig({ osv: { runner: 'docker', image: 'ghcr.io/google/osv-scanner:v1.9.0' } }),
    );
    await engine.scan(ctx);
    expect(vi.mocked(OsvDockerRunner)).toHaveBeenCalledWith(
      expect.objectContaining({ image: 'ghcr.io/google/osv-scanner:v1.9.0' }),
    );
  });

  it('auto: uses local path when local is available', async () => {
    const runner = new MockRunner({
      'osv-scanner --version': { exitCode: 0 },
      'osv-scanner': { exitCode: 0, stdout: MINIMAL_SCAN_JSON },
    });
    const ctx = makeCtx(runner, makeConfig({ osv: { runner: 'auto' } }));
    const result = await engine.scan(ctx);
    expect(result.status).toBe('success');
    expect(vi.mocked(OsvDockerRunner)).not.toHaveBeenCalled();
  });

  it('auto: falls back to Docker when local is unavailable', async () => {
    const runner = new MockRunner({
      'osv-scanner': { exitCode: 1 },
      'docker': { exitCode: 0 },
    });
    const ctx = makeCtx(runner, makeConfig({ osv: { runner: 'auto' } }));
    const result = await engine.scan(ctx);
    expect(result.status).toBe('success');
    expect(vi.mocked(OsvDockerRunner)).toHaveBeenCalledOnce();
  });

  it('passes cwd as projectDir to OsvDockerRunner', async () => {
    const runner = new MockRunner({ 'docker': { exitCode: 0 } });
    const ctx = makeCtx(runner, makeConfig({ osv: { runner: 'docker' } }), '/my/cwd');
    await engine.scan(ctx);
    expect(vi.mocked(OsvDockerRunner)).toHaveBeenCalledWith(
      expect.objectContaining({ projectDir: '/my/cwd' }),
    );
  });

  it('passes raw plugin lockfile args directly to OsvDockerRunner.run() without path translation', async () => {
    // Plugin returns a relative lockfile path — the engine must NOT translate it
    // to /project/... because --workdir /project handles resolution inside the container.
    const rawPluginArgs = ['--lockfile', 'package-lock.json'];
    const registry = makeEcosystemRegistry(rawPluginArgs);
    const runner = new MockRunner({ 'docker': { exitCode: 0 } });
    const ctx: ScannerEngineContext = {
      runner,
      config: makeConfig({ osv: { runner: 'docker' } }),
      cwd: '/my/project',
      ecosystemRegistry: registry,
      branch: null,
    };
    await engine.scan(ctx);
    expect(mockDockerRun).toHaveBeenCalledWith(rawPluginArgs);
  });

  it('returns error result when scan exits non-zero with no stdout', async () => {
    mockDockerRun.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'scan failed' });
    const runner = new MockRunner({ 'docker': { exitCode: 0 } });
    const ctx = makeCtx(runner, makeConfig({ osv: { runner: 'docker' } }));
    const result = await engine.scan(ctx);
    expect(result.status).toBe('error');
    expect(result.error).toContain('scan failed');
  });

  it('parses JSON stdout even on non-zero exit (partial results)', async () => {
    mockDockerRun.mockResolvedValue({ exitCode: 1, stdout: MINIMAL_SCAN_JSON, stderr: 'warn' });
    const runner = new MockRunner({ 'docker': { exitCode: 0 } });
    const ctx = makeCtx(runner, makeConfig({ osv: { runner: 'docker' } }));
    const result = await engine.scan(ctx);
    expect(result.status).toBe('success');
  });
});

// ─── scan() — dry run ─────────────────────────────────────────────────────────

describe('OsvScannerEngine.scan() — dry run', () => {
  const engine = new OsvScannerEngine();

  afterEach(() => vi.clearAllMocks());

  it('returns empty result without calling any runner when dryRun=true (local)', async () => {
    const runner = new MockRunner(
      { 'osv-scanner --version': { exitCode: 0 } },
      { dryRun: true },
    );
    const ctx = makeCtx(runner, makeConfig({ osv: { runner: 'local' } }));
    const result = await engine.scan(ctx);
    expect(result.status).toBe('success');
    expect(Object.keys(result.ecosystems)).toHaveLength(0);
    expect(vi.mocked(OsvDockerRunner)).not.toHaveBeenCalled();
  });

  it('returns empty result without calling Docker runner when dryRun=true (docker)', async () => {
    const runner = new MockRunner({ 'docker': { exitCode: 0 } }, { dryRun: true });
    const ctx = makeCtx(runner, makeConfig({ osv: { runner: 'docker' } }));
    const result = await engine.scan(ctx);
    expect(result.status).toBe('success');
    expect(mockDockerRun).not.toHaveBeenCalled();
  });
});

// ─── id / name contract ───────────────────────────────────────────────────────

describe('OsvScannerEngine — identity', () => {
  it('has id "osv"', () => {
    expect(new OsvScannerEngine().id).toBe('osv');
  });

  it('has expected name', () => {
    expect(new OsvScannerEngine().name).toBe('OSV Scanner');
  });
});

// ─── branch stamping ─────────────────────────────────────────────────────────

describe('OsvScannerEngine — branch stamping', () => {
  const engine = new OsvScannerEngine();

  beforeEach(() => {
    mockDockerRun.mockResolvedValue({ exitCode: 0, stdout: MINIMAL_SCAN_JSON, stderr: '' });
    vi.mocked(OsvDockerRunner).mockClear();
    mockDockerRun.mockClear();
  });

  afterEach(() => vi.clearAllMocks());

  it('stamps branch into result when ctx.branch is set', async () => {
    const runner = new MockRunner({
      'osv-scanner --version': { exitCode: 0 },
      'osv-scanner': { exitCode: 0, stdout: MINIMAL_SCAN_JSON },
    });
    const ctx: ScannerEngineContext = {
      ...makeCtx(runner, makeConfig({ osv: { runner: 'local' } })),
      branch: 'main',
    };
    const result = await engine.scan(ctx);
    expect(result.branch).toBe('main');
  });

  it('does not include branch field when ctx.branch is null', async () => {
    const runner = new MockRunner({
      'osv-scanner --version': { exitCode: 0 },
      'osv-scanner': { exitCode: 0, stdout: MINIMAL_SCAN_JSON },
    });
    const ctx: ScannerEngineContext = {
      ...makeCtx(runner, makeConfig({ osv: { runner: 'local' } })),
      branch: null,
    };
    const result = await engine.scan(ctx);
    expect(result.branch).toBeUndefined();
  });

  it('stamps branch when using Docker runner', async () => {
    const runner = new MockRunner({ 'docker': { exitCode: 0 } });
    const ctx: ScannerEngineContext = {
      ...makeCtx(runner, makeConfig({ osv: { runner: 'docker' } })),
      branch: 'feature/my-feature',
    };
    const result = await engine.scan(ctx);
    expect(result.branch).toBe('feature/my-feature');
  });
});
