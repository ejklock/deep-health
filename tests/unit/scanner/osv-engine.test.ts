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

    it('returns false from isLocalAvailable when runner.run throws (line 278)', async () => {
      // runner throws on osv-scanner --version → isLocalAvailable catch → returns false
      // then docker check also fails → EnvironmentError thrown
      const runner = new MockRunner({ 'docker': { exitCode: 1 } });
      const origRun = runner.run.bind(runner);
      runner.run = async (cmd: string, opts?: CommandRunnerOptions) => {
        if (cmd.includes('osv-scanner')) throw new Error('spawn ENOENT');
        return origRun(cmd, opts);
      };
      const ctx = makeCtx(runner, makeConfig({ osv: { runner: 'auto' } }));
      await expect(engine.assertAvailable(ctx)).rejects.toThrow(EnvironmentError);
    });

    it('returns false from isDockerAvailable when runner.run throws (line 288)', async () => {
      // runner returns non-zero for osv-scanner (local unavailable), then throws for docker
      const runner = new MockRunner({ 'osv-scanner': { exitCode: 1 } });
      const origRun = runner.run.bind(runner);
      runner.run = async (cmd: string, opts?: CommandRunnerOptions) => {
        if (cmd.includes('docker')) throw new Error('spawn ENOENT');
        return origRun(cmd, opts);
      };
      const ctx = makeCtx(runner, makeConfig({ osv: { runner: 'auto' } }));
      await expect(engine.assertAvailable(ctx)).rejects.toThrow(EnvironmentError);
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

// ─── scan() — parseOsvJsonOutput / extractSafeVersionFromVuln ────────────────

/**
 * Builds a minimal OSV JSON payload with a single vulnerable package entry.
 * Each range in `vulnRanges` is one OSV affected[].ranges[] entry containing
 * the events provided.
 */
function makeOsvJson(options: {
  pkgName: string;
  pkgVersion: string;
  ecosystem?: string;
  vulnRanges: Array<Array<{ introduced?: string; fixed?: string; last_affected?: string }>>;
}): string {
  const { pkgName, pkgVersion, ecosystem = 'npm', vulnRanges } = options;
  return JSON.stringify({
    results: [
      {
        packages: [
          {
            package: { name: pkgName, version: pkgVersion, ecosystem },
            vulnerabilities: [
              {
                id: 'GHSA-test-0001',
                summary: 'test vulnerability',
                affected: [
                  {
                    ranges: vulnRanges.map((events) => ({ events })),
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
}

/**
 * Registry whose findByOsvEcosystem returns the npm plugin for 'npm' input.
 * Used for parse-path tests that need actual JSON parsing to work end-to-end.
 */
function makeParseRegistry(): EcosystemRegistry {
  const npmPlugin = {
    id: 'npm',
    osvEcosystems: ['npm'],
    buildScanArgs: () => [],
    getProtectedPackages: () => [],
  } as unknown as ReturnType<EcosystemRegistry['getAll']>[0];

  return {
    getAll: () => [npmPlugin],
    register: vi.fn(),
    get: vi.fn(),
    findByOsvEcosystem: (eco: string) => (eco.toLowerCase() === 'npm' ? npmPlugin : undefined),
  } as unknown as EcosystemRegistry;
}

describe('OsvScannerEngine.scan() — multi-range safeVersion selection', () => {
  const engine = new OsvScannerEngine();

  const ROLLUP_RANGES = [
    [{ introduced: '0' }, { fixed: '2.80.0' }],
    [{ introduced: '3.0.0' }, { fixed: '3.30.0' }],
    [{ introduced: '4.0.0' }, { fixed: '4.59.0' }],
  ];

  beforeEach(() => {
    vi.mocked(OsvDockerRunner).mockClear();
    mockDockerRun.mockClear();
  });

  afterEach(() => vi.clearAllMocks());

  it('selects the range that contains v4 (4.57.1) → safeVersion 4.59.0', async () => {
    const stdout = makeOsvJson({ pkgName: 'rollup', pkgVersion: '4.57.1', vulnRanges: ROLLUP_RANGES });
    mockDockerRun.mockResolvedValue({ exitCode: 0, stdout, stderr: '' });

    const runner = new MockRunner({ docker: { exitCode: 0 } });
    const ctx: ScannerEngineContext = {
      runner,
      config: makeConfig({ osv: { runner: 'docker' } }),
      cwd: '/project',
      ecosystemRegistry: makeParseRegistry(),
      branch: null,
    };

    const result = await engine.scan(ctx);
    const vuln = result.ecosystems['npm']?.vulnerabilities[0];
    expect(vuln?.safeVersion).toBe('4.59.0');
  });

  it('selects the range that contains v3 (3.25.0) → safeVersion 3.30.0', async () => {
    const stdout = makeOsvJson({ pkgName: 'rollup', pkgVersion: '3.25.0', vulnRanges: ROLLUP_RANGES });
    mockDockerRun.mockResolvedValue({ exitCode: 0, stdout, stderr: '' });

    const runner = new MockRunner({ docker: { exitCode: 0 } });
    const ctx: ScannerEngineContext = {
      runner,
      config: makeConfig({ osv: { runner: 'docker' } }),
      cwd: '/project',
      ecosystemRegistry: makeParseRegistry(),
      branch: null,
    };

    const result = await engine.scan(ctx);
    const vuln = result.ecosystems['npm']?.vulnerabilities[0];
    expect(vuln?.safeVersion).toBe('3.30.0');
  });

  it('returns safeVersion null when only a last_affected range exists for the current version (no fix)', async () => {
    // pkg@2.5.0: v2 range has last_affected only (no patch available); v3 has a fix but is out of range
    const ranges = [
      [{ introduced: '0' }, { last_affected: '2.99.0' }],
      [{ introduced: '3.0.0' }, { fixed: '3.5.0' }],
    ];
    const stdout = makeOsvJson({ pkgName: 'pkg', pkgVersion: '2.5.0', vulnRanges: ranges });
    mockDockerRun.mockResolvedValue({ exitCode: 0, stdout, stderr: '' });

    const runner = new MockRunner({ docker: { exitCode: 0 } });
    const ctx: ScannerEngineContext = {
      runner,
      config: makeConfig({ osv: { runner: 'docker' } }),
      cwd: '/project',
      ecosystemRegistry: makeParseRegistry(),
      branch: null,
    };

    const result = await engine.scan(ctx);
    const vuln = result.ecosystems['npm']?.vulnerabilities[0];
    expect(vuln?.safeVersion).toBeNull();
  });

  it('falls back to first fixed when currentVersion is non-semver', async () => {
    // Non-semver currentVersion (e.g. "dev") → coerce returns null → fallback path
    const stdout = makeOsvJson({ pkgName: 'pkg', pkgVersion: 'dev', vulnRanges: ROLLUP_RANGES });
    mockDockerRun.mockResolvedValue({ exitCode: 0, stdout, stderr: '' });

    const runner = new MockRunner({ docker: { exitCode: 0 } });
    const ctx: ScannerEngineContext = {
      runner,
      config: makeConfig({ osv: { runner: 'docker' } }),
      cwd: '/project',
      ecosystemRegistry: makeParseRegistry(),
      branch: null,
    };

    const result = await engine.scan(ctx);
    const vuln = result.ecosystems['npm']?.vulnerabilities[0];
    // Fallback: returns the first fixed event encountered across all ranges
    expect(vuln?.safeVersion).toBe('2.80.0');
  });

  it('returns null safeVersion when currentVersion is non-semver and no fixed event exists (lines 116-119)', async () => {
    // Non-semver version → coerce returns null → fallback loop → no fixed event → null
    const stdout = makeOsvJson({
      pkgName: 'pkg',
      pkgVersion: 'dev',
      vulnRanges: [[{ introduced: '0' }]], // no 'fixed' event
    });
    mockDockerRun.mockResolvedValue({ exitCode: 0, stdout, stderr: '' });

    const runner = new MockRunner({ docker: { exitCode: 0 } });
    const ctx: ScannerEngineContext = {
      runner,
      config: makeConfig({ osv: { runner: 'docker' } }),
      cwd: '/project',
      ecosystemRegistry: makeParseRegistry(),
      branch: null,
    };

    const result = await engine.scan(ctx);
    const vuln = result.ecosystems['npm']?.vulnerabilities[0];
    expect(vuln?.safeVersion).toBeNull();
  });
});

// ─── scan() — scan.paths feature ─────────────────────────────────────────────

describe('OsvScannerEngine.scan() — scan.paths', () => {
  const engine = new OsvScannerEngine();

  beforeEach(() => {
    mockDockerRun.mockResolvedValue({ exitCode: 0, stdout: MINIMAL_SCAN_JSON, stderr: '' });
    vi.mocked(OsvDockerRunner).mockClear();
    mockDockerRun.mockClear();
  });

  afterEach(() => vi.clearAllMocks());

  it('passes resolveScanPathArgs output to Docker runner when scan.paths is set', async () => {
    const runner = new MockRunner({ 'docker': { exitCode: 0 } });
    const config = makeConfig({ osv: { runner: 'docker' } });
    const ctx: ScannerEngineContext = {
      runner,
      config: { ...config, scan: { auto_discover: true, paths: ['app/'] } },
      cwd: '/my/project',
      ecosystemRegistry: makeEcosystemRegistry(['--lockfile', 'package-lock.json']),
      branch: null,
    };

    await engine.scan(ctx);
    // 'app/' is a directory → resolveScanPathArgs produces ['-r', 'app/']
    expect(mockDockerRun).toHaveBeenCalledWith(['-r', 'app/']);
  });

  it('passes explicit file path as --lockfile when scan.paths contains a file', async () => {
    const runner = new MockRunner({ 'docker': { exitCode: 0 } });
    const config = makeConfig({ osv: { runner: 'docker' } });
    const ctx: ScannerEngineContext = {
      runner,
      config: { ...config, scan: { auto_discover: true, paths: ['app/package-lock.json'] } },
      cwd: '/my/project',
      ecosystemRegistry: makeEcosystemRegistry(['--lockfile', 'package-lock.json']),
      branch: null,
    };

    await engine.scan(ctx);
    expect(mockDockerRun).toHaveBeenCalledWith(['--lockfile', 'app/package-lock.json']);
  });

  it('falls back to plugin buildScanArgs when scan config is absent', async () => {
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
    // No scan.paths → falls back to plugin args
    expect(mockDockerRun).toHaveBeenCalledWith(rawPluginArgs);
  });

  it('falls back to plugin buildScanArgs when scan.paths is an empty array', async () => {
    const rawPluginArgs = ['--lockfile', 'package-lock.json'];
    const registry = makeEcosystemRegistry(rawPluginArgs);
    const runner = new MockRunner({ 'docker': { exitCode: 0 } });
    const config = makeConfig({ osv: { runner: 'docker' } });
    const ctx: ScannerEngineContext = {
      runner,
      config: { ...config, scan: { auto_discover: true, paths: [] } },
      cwd: '/my/project',
      ecosystemRegistry: registry,
      branch: null,
    };

    await engine.scan(ctx);
    // Empty paths → falls back to plugin args
    expect(mockDockerRun).toHaveBeenCalledWith(rawPluginArgs);
  });

  it('throws PhaseError when scan.paths contains a path traversal attempt at runtime', async () => {
    const runner = new MockRunner({ 'docker': { exitCode: 0 } });
    const config = makeConfig({ osv: { runner: 'docker' } });
    const ctx: ScannerEngineContext = {
      runner,
      config: { ...config, scan: { auto_discover: true, paths: ['../escape'] } },
      cwd: '/my/project',
      ecosystemRegistry: makeEcosystemRegistry([]),
      branch: null,
    };

    // The engine validates each path at runtime — should propagate as PhaseError
    await expect(engine.scan(ctx)).rejects.toThrow(/\.\./);
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

// ─── scan() — breaking and manual classification (lines 188-289) ─────────────

describe('OsvScannerEngine.scan() — breaking classification (major version bump)', () => {
  const engine = new OsvScannerEngine();

  beforeEach(() => { mockDockerRun.mockClear(); vi.mocked(OsvDockerRunner).mockClear(); });
  afterEach(() => vi.clearAllMocks());

  it('classifies package as "breaking" when safeVersion is a major bump (line 235-238)', async () => {
    // current: 1.2.3, fixed: 2.0.0 → major bump → breaking
    const stdout = makeOsvJson({
      pkgName: 'legacy-pkg',
      pkgVersion: '1.2.3',
      vulnRanges: [[{ introduced: '0' }, { fixed: '2.0.0' }]],
    });
    mockDockerRun.mockResolvedValue({ exitCode: 0, stdout, stderr: '' });
    const runner = new MockRunner({ docker: { exitCode: 0 } });
    const ctx: ScannerEngineContext = {
      runner,
      config: makeConfig({ osv: { runner: 'docker' } }),
      cwd: '/project',
      ecosystemRegistry: makeParseRegistry(),
      branch: null,
    };

    const result = await engine.scan(ctx);
    const vuln = result.ecosystems['npm']?.vulnerabilities[0];
    expect(vuln?.classification).toBe('breaking');
    expect(result.ecosystems['npm']?.breaking).toBe(1);
    expect(result.ecosystems['npm']?.breaking_packages).toContain('legacy-pkg@1.2.3');
  });
});

describe('OsvScannerEngine.scan() — manual classification (no safe version)', () => {
  const engine = new OsvScannerEngine();

  beforeEach(() => { mockDockerRun.mockClear(); vi.mocked(OsvDockerRunner).mockClear(); });
  afterEach(() => vi.clearAllMocks());

  it('classifies package as "manual" when no fixed version exists (lines 239-243)', async () => {
    // Range has last_affected but no fixed → safeVersion is null → manual
    const stdout = makeOsvJson({
      pkgName: 'unfixed-pkg',
      pkgVersion: '1.0.0',
      vulnRanges: [[{ introduced: '0' }, { last_affected: '9.99.99' }]],
    });
    mockDockerRun.mockResolvedValue({ exitCode: 0, stdout, stderr: '' });
    const runner = new MockRunner({ docker: { exitCode: 0 } });
    const ctx: ScannerEngineContext = {
      runner,
      config: makeConfig({ osv: { runner: 'docker' } }),
      cwd: '/project',
      ecosystemRegistry: makeParseRegistry(),
      branch: null,
    };

    const result = await engine.scan(ctx);
    const vuln = result.ecosystems['npm']?.vulnerabilities[0];
    expect(vuln?.classification).toBe('manual');
    expect(result.ecosystems['npm']?.manual).toBe(1);
    expect(result.ecosystems['npm']?.manual_packages).toContain('unfixed-pkg@1.0.0');
  });
});

describe('OsvScannerEngine.scan() — PhaseError on unexpected throw (lines 423-429)', () => {
  const engine = new OsvScannerEngine();
  afterEach(() => vi.clearAllMocks());

  it('throws PhaseError when runner throws unexpectedly during local scan', async () => {
    const runner = new MockRunner({ 'osv-scanner --version': { exitCode: 0 } });
    // Override run to throw after version check
    let callCount = 0;
    runner.run = async (cmd: string) => {
      callCount++;
      if (callCount === 1) return { stdout: 'osv-scanner version 0.7.0', stderr: '', exitCode: 0, command: cmd, dryRun: false };
      throw new Error('unexpected disk error');
    };

    const ctx: ScannerEngineContext = {
      runner,
      config: makeConfig({ osv: { runner: 'local' } }),
      cwd: '/project',
      ecosystemRegistry: makeParseRegistry(),
      branch: null,
    };

    await expect(engine.scan(ctx)).rejects.toThrow('OSV scanner phase failed');
  });
});

// ─── CVSS extraction (lines 46-119) ─────────────────────────────────────────

function makeOsvJsonWithCvss(options: {
  pkgName: string;
  pkgVersion: string;
  ecosystem?: string;
  cvssScore?: string;
  vulnRanges: Array<Array<{ introduced?: string; fixed?: string }>>;
}): string {
  const { pkgName, pkgVersion, ecosystem = 'npm', cvssScore, vulnRanges } = options;
  const vuln: Record<string, unknown> = {
    id: 'GHSA-cvss-test-0001',
    summary: 'test vulnerability with CVSS',
    affected: [
      {
        ranges: vulnRanges.map((events) => ({ events })),
      },
    ],
  };
  if (cvssScore) {
    vuln['severity'] = [{ type: 'CVSS_V3', score: cvssScore }];
  }
  return JSON.stringify({
    results: [
      {
        packages: [
          {
            package: { name: pkgName, version: pkgVersion, ecosystem },
            vulnerabilities: [vuln],
          },
        ],
      },
    ],
  });
}

describe('OsvScannerEngine.scan() — CVSS score extraction (lines 46-119)', () => {
  const engine = new OsvScannerEngine();

  beforeEach(() => {
    vi.mocked(OsvDockerRunner).mockClear();
    mockDockerRun.mockClear();
  });
  afterEach(() => vi.clearAllMocks());

  function makeCtxWithParseRegistry(runner: CommandRunner, mode: 'local' | 'docker' = 'docker') {
    return {
      runner,
      config: makeConfig({ osv: { runner: mode } }),
      cwd: '/project',
      ecosystemRegistry: makeParseRegistry(),
      branch: null,
    };
  }

  it('parses CVSS_V3 score and computes a numeric value (scope=Changed)', async () => {
    // A CVSS v3 vector with S:C (scope changed) — exercises the changed-scope branch
    const cvssVector = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H';
    const stdout = makeOsvJsonWithCvss({
      pkgName: 'lodash',
      pkgVersion: '4.17.15',
      cvssScore: cvssVector,
      vulnRanges: [[{ introduced: '0' }, { fixed: '4.17.21' }]],
    });
    mockDockerRun.mockResolvedValue({ exitCode: 0, stdout, stderr: '' });

    const runner = new MockRunner({ docker: { exitCode: 0 } });
    const result = await engine.scan(makeCtxWithParseRegistry(runner));
    const vuln = result.ecosystems['npm']?.vulnerabilities[0];
    expect(vuln).toBeDefined();
    // cvss should be a number string like "10.0"
    expect(vuln!.cvss).not.toBe('—');
    expect(parseFloat(vuln!.cvss)).toBeGreaterThan(0);
  });

  it('parses CVSS_V3 score with scope=Unchanged (different isc branch)', async () => {
    const cvssVector = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H';
    const stdout = makeOsvJsonWithCvss({
      pkgName: 'lodash',
      pkgVersion: '4.17.15',
      cvssScore: cvssVector,
      vulnRanges: [[{ introduced: '0' }, { fixed: '4.17.21' }]],
    });
    mockDockerRun.mockResolvedValue({ exitCode: 0, stdout, stderr: '' });

    const runner = new MockRunner({ docker: { exitCode: 0 } });
    const result = await engine.scan(makeCtxWithParseRegistry(runner));
    const vuln = result.ecosystems['npm']?.vulnerabilities[0];
    expect(vuln).toBeDefined();
    expect(parseFloat(vuln!.cvss)).toBeGreaterThan(0);
  });

  it('returns — when CVSS score vector is malformed (no match)', async () => {
    const stdout = makeOsvJsonWithCvss({
      pkgName: 'lodash',
      pkgVersion: '4.17.15',
      cvssScore: 'INVALID_SCORE',
      vulnRanges: [[{ introduced: '0' }, { fixed: '4.17.21' }]],
    });
    mockDockerRun.mockResolvedValue({ exitCode: 0, stdout, stderr: '' });

    const runner = new MockRunner({ docker: { exitCode: 0 } });
    const result = await engine.scan(makeCtxWithParseRegistry(runner));
    const vuln = result.ecosystems['npm']?.vulnerabilities[0];
    expect(vuln!.cvss).toBe('—');
  });

  it('returns — when no severity field is present', async () => {
    const stdout = makeOsvJsonWithCvss({
      pkgName: 'lodash',
      pkgVersion: '4.17.15',
      vulnRanges: [[{ introduced: '0' }, { fixed: '4.17.21' }]],
    });
    mockDockerRun.mockResolvedValue({ exitCode: 0, stdout, stderr: '' });

    const runner = new MockRunner({ docker: { exitCode: 0 } });
    const result = await engine.scan(makeCtxWithParseRegistry(runner));
    const vuln = result.ecosystems['npm']?.vulnerabilities[0];
    expect(vuln!.cvss).toBe('—');
  });

  it('returns 0.0 when ISC base is <= 0 (all impact=N)', async () => {
    // C:N, I:N, A:N → iscBase = 1 - 1*1*1 = 0 → returns "0.0"
    const cvssVector = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N';
    const stdout = makeOsvJsonWithCvss({
      pkgName: 'lodash',
      pkgVersion: '4.17.15',
      cvssScore: cvssVector,
      vulnRanges: [[{ introduced: '0' }, { fixed: '4.17.21' }]],
    });
    mockDockerRun.mockResolvedValue({ exitCode: 0, stdout, stderr: '' });

    const runner = new MockRunner({ docker: { exitCode: 0 } });
    const result = await engine.scan(makeCtxWithParseRegistry(runner));
    const vuln = result.ecosystems['npm']?.vulnerabilities[0];
    expect(vuln!.cvss).toBe('0.0');
  });

  it('returns — when score is non-string (catch block lines 91-92)', async () => {
    // Inject a numeric score that will cause score.match(...) to throw inside parseCvssBaseScore
    const stdout = JSON.stringify({
      results: [{
        packages: [{
          package: { name: 'lodash', version: '4.17.15', ecosystem: 'npm' },
          vulnerabilities: [{
            id: 'GHSA-cvss-catch-test',
            summary: 'catch block test',
            affected: [{ ranges: [{ events: [{ introduced: '0' }, { fixed: '4.17.21' }] }] }],
            severity: [{ type: 'CVSS_V3', score: 42 }], // number, not string → .match() throws
          }],
          groups: [{ ids: ['GHSA-cvss-catch-test'] }],
        }],
      }],
    });
    mockDockerRun.mockResolvedValue({ exitCode: 0, stdout, stderr: '' });

    const runner = new MockRunner({ docker: { exitCode: 0 } });
    const result = await engine.scan(makeCtxWithParseRegistry(runner));
    const vuln = result.ecosystems['npm']?.vulnerabilities[0];
    // The catch block returns '—'
    expect(vuln!.cvss).toBe('—');
  });
});

// ─── Additional branch coverage ───────────────────────────────────────────────

describe('OsvScannerEngine — additional branch coverage', () => {
  const engine = new OsvScannerEngine();

  beforeEach(() => {
    mockDockerRun.mockResolvedValue({ exitCode: 0, stdout: '{"results":[]}', stderr: '' });
    vi.mocked(OsvDockerRunner).mockClear();
    mockDockerRun.mockClear();
  });
  afterEach(() => vi.clearAllMocks());

  function makeCtxWithParseReg(runner: CommandRunner) {
    const npmPlugin = {
      id: 'npm', osvEcosystems: ['npm'],
      buildScanArgs: () => [], getProtectedPackages: () => [],
    } as unknown as ReturnType<EcosystemRegistry['getAll']>[0];
    const registry: EcosystemRegistry = {
      getAll: () => [npmPlugin], register: vi.fn(), get: vi.fn(),
      findByOsvEcosystem: (eco: string) => (eco.toLowerCase() === 'npm' ? npmPlugin : undefined),
    } as unknown as EcosystemRegistry;
    return {
      runner, config: makeConfig({ osv: { runner: 'docker' } }),
      cwd: '/project', ecosystemRegistry: registry, branch: null,
    };
  }

  // Line 161: !data.results → return { ecosystems }
  it('line 161: returns empty ecosystems when JSON has no results field', async () => {
    mockDockerRun.mockResolvedValue({ exitCode: 0, stdout: '{"schemaVersion":"1.0"}', stderr: '' });
    const runner = new MockRunner({ docker: { exitCode: 0 } });
    const result = await engine.scan(makeCtxWithParseReg(runner));
    expect(result.ecosystems).toEqual({});
  });

  // Lines 176-178: result.packages ?? [], pkg.package?.name ?? '', etc.
  it('lines 176-179: handles result with no packages array', async () => {
    const stdout = JSON.stringify({ results: [{ source: { path: 'package-lock.json' } /* no packages */ }] });
    mockDockerRun.mockResolvedValue({ exitCode: 0, stdout, stderr: '' });
    const runner = new MockRunner({ docker: { exitCode: 0 } });
    const result = await engine.scan(makeCtxWithParseReg(runner));
    expect(result.status).toBe('success');
  });

  // Line 182: !plugin → continue (unknown ecosystem)
  it('line 182: skips package with unknown ecosystem (no plugin found)', async () => {
    const stdout = JSON.stringify({
      results: [{
        packages: [{
          package: { name: 'some-pkg', version: '1.0.0', ecosystem: 'UnknownEco' },
          vulnerabilities: [],
          groups: [],
        }],
      }],
    });
    mockDockerRun.mockResolvedValue({ exitCode: 0, stdout, stderr: '' });
    const runner = new MockRunner({ docker: { exitCode: 0 } });
    const result = await engine.scan(makeCtxWithParseReg(runner));
    expect(result.ecosystems['npm']).toBeUndefined();
  });

  // Line 196: protectedByPlugin.get(pluginId) ?? new Map()
  it('line 196: ?? new Map() fires when protected map is absent for plugin', async () => {
    // The protectedByPlugin map is built from registry plugins — if getProtectedPackages returns []
    // for a plugin that IS found, the map exists but is empty. To trigger ?? new Map(), we need
    // a plugin that is NOT in the initial protectedByPlugin map.
    // Actually protectedByPlugin is built from ALL registry plugins, so the ?? fires if pluginId
    // is somehow not in the map — e.g. if we return a plugin from findByOsvEcosystem that is NOT
    // in getAll(). Let's construct that scenario:
    const ghostPlugin = {
      id: 'ghost', osvEcosystems: ['npm'],
      buildScanArgs: () => [], getProtectedPackages: () => [],
    } as unknown as ReturnType<EcosystemRegistry['getAll']>[0];
    const registry: EcosystemRegistry = {
      getAll: () => [], // empty — no plugins in list → protectedByPlugin is empty
      register: vi.fn(), get: vi.fn(),
      findByOsvEcosystem: () => ghostPlugin, // but findByOsvEcosystem returns ghostPlugin
    } as unknown as EcosystemRegistry;
    const stdout = JSON.stringify({
      results: [{
        packages: [{
          package: { name: 'lodash', version: '4.17.15', ecosystem: 'npm' },
          vulnerabilities: [{
            id: 'GHSA-test', summary: 'test', affected: [],
            severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }],
          }],
          groups: [{ ids: ['GHSA-test'] }],
        }],
      }],
    });
    mockDockerRun.mockResolvedValue({ exitCode: 0, stdout, stderr: '' });
    const runner = new MockRunner({ docker: { exitCode: 0 } });
    const ctx = { runner, config: makeConfig({ osv: { runner: 'docker' } }), cwd: '/project', ecosystemRegistry: registry, branch: null };
    const result = await engine.scan(ctx);
    expect(result).toBeDefined();
  });

  // Lines 198-200: pkg.vulnerabilities ?? [], vuln.id ?? '', vuln.summary ?? ''
  it('lines 198-200: handles package with no vulnerabilities array and missing vuln fields', async () => {
    const stdout = JSON.stringify({
      results: [{
        packages: [{
          package: { name: 'lodash', version: '4.17.15', ecosystem: 'npm' },
          // no vulnerabilities array
          groups: [],
        }],
      }],
    });
    mockDockerRun.mockResolvedValue({ exitCode: 0, stdout, stderr: '' });
    const runner = new MockRunner({ docker: { exitCode: 0 } });
    const result = await engine.scan(makeCtxWithParseReg(runner));
    expect(result.status).toBe('success');
  });

  // Lines 56-63: CVSS metrics with unknown keys → ?? 0
  it('lines 56-63: CVSS vector with unknown/missing metric keys triggers ?? 0 fallbacks', async () => {
    // Only provide AV and AC — all other metrics missing → ?? 0
    const cvssPartial = 'CVSS:3.1/AV:X/AC:X/PR:X/UI:X/S:U/C:X/I:X/A:X'; // all unknown values
    const stdout = JSON.stringify({
      results: [{
        packages: [{
          package: { name: 'lodash', version: '4.17.15', ecosystem: 'npm' },
          vulnerabilities: [{
            id: 'GHSA-cvss-unknown',
            summary: 'test',
            affected: [{ ranges: [{ events: [{ introduced: '0' }, { fixed: '4.17.21' }] }] }],
            severity: [{ type: 'CVSS_V3', score: cvssPartial }],
          }],
          groups: [{ ids: ['GHSA-cvss-unknown'] }],
        }],
      }],
    });
    mockDockerRun.mockResolvedValue({ exitCode: 0, stdout, stderr: '' });
    const runner = new MockRunner({ docker: { exitCode: 0 } });
    const result = await engine.scan(makeCtxWithParseReg(runner));
    // Should not throw; CVSS will be '—' or a computed value
    expect(result).toBeDefined();
  });

  // Lines 111-113: vuln.affected ?? [] / ranges ?? [] / events ?? [] for non-semver current version
  it('lines 111-113: uses ?? [] fallbacks when affected/ranges/events absent (non-semver version)', async () => {
    const stdout = JSON.stringify({
      results: [{
        packages: [{
          package: { name: 'lodash', version: 'non-semver-abc', ecosystem: 'npm' },
          vulnerabilities: [{
            id: 'GHSA-no-affected',
            summary: 'test',
            // affected is absent
            severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }],
          }],
          groups: [{ ids: ['GHSA-no-affected'] }],
        }],
      }],
    });
    mockDockerRun.mockResolvedValue({ exitCode: 0, stdout, stderr: '' });
    const runner = new MockRunner({ docker: { exitCode: 0 } });
    const result = await engine.scan(makeCtxWithParseReg(runner));
    expect(result).toBeDefined();
  });

  // Lines 121-122: vuln.affected ?? [] / ranges ?? [] for semver version
  it('lines 121-122: uses ?? [] for affected/ranges when semver version has missing fields', async () => {
    const stdout = JSON.stringify({
      results: [{
        packages: [{
          package: { name: 'lodash', version: '4.17.15', ecosystem: 'npm' },
          vulnerabilities: [{
            id: 'GHSA-semver-no-ranges',
            summary: 'test',
            affected: [{ /* no ranges */ }],
            severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }],
          }],
          groups: [{ ids: ['GHSA-semver-no-ranges'] }],
        }],
      }],
    });
    mockDockerRun.mockResolvedValue({ exitCode: 0, stdout, stderr: '' });
    const runner = new MockRunner({ docker: { exitCode: 0 } });
    const result = await engine.scan(makeCtxWithParseReg(runner));
    expect(result).toBeDefined();
  });

  // Line 133: introduced is undefined → coercedIntroduced = null
  it('line 133: range with fixed but no introduced event → coercedIntroduced = null', async () => {
    const stdout = JSON.stringify({
      results: [{
        packages: [{
          package: { name: 'lodash', version: '4.17.15', ecosystem: 'npm' },
          vulnerabilities: [{
            id: 'GHSA-no-introduced',
            summary: 'test',
            affected: [{ ranges: [{ events: [{ fixed: '4.17.21' }] /* no introduced */ }] }],
            severity: [],
          }],
          groups: [{ ids: ['GHSA-no-introduced'] }],
        }],
      }],
    });
    mockDockerRun.mockResolvedValue({ exitCode: 0, stdout, stderr: '' });
    const runner = new MockRunner({ docker: { exitCode: 0 } });
    const result = await engine.scan(makeCtxWithParseReg(runner));
    expect(result).toBeDefined();
  });

  // Line 136: !coercedFixed → continue
  it('line 136: range with non-coercible fixed version → skipped', async () => {
    const stdout = JSON.stringify({
      results: [{
        packages: [{
          package: { name: 'lodash', version: '4.17.15', ecosystem: 'npm' },
          vulnerabilities: [{
            id: 'GHSA-bad-fixed',
            summary: 'test',
            affected: [{ ranges: [{ events: [{ introduced: '0' }, { fixed: 'not-a-version' }] }] }],
            severity: [],
          }],
          groups: [{ ids: ['GHSA-bad-fixed'] }],
        }],
      }],
    });
    mockDockerRun.mockResolvedValue({ exitCode: 0, stdout, stderr: '' });
    const runner = new MockRunner({ docker: { exitCode: 0 } });
    const result = await engine.scan(makeCtxWithParseReg(runner));
    expect(result).toBeDefined();
  });

  // Line 354: config.scanners?.osv?.runner ?? 'docker' — no scanners key
  it('line 354: defaults to "docker" runner when scanners config is absent', async () => {
    const runner = new MockRunner({ docker: { exitCode: 0 } });
    const ctx = makeCtx(runner, makeConfig(undefined)); // no scanners
    const result = await engine.scan(ctx);
    expect(result.status).toBe('success');
    expect(vi.mocked(OsvDockerRunner)).toHaveBeenCalledOnce();
  });

  // Line 423: EnvironmentError is rethrown
  it('line 423: EnvironmentError from assertAvailable is rethrown', async () => {
    vi.spyOn(engine, 'assertAvailable').mockRejectedValueOnce(new EnvironmentError('env failed'));
    const runner = new MockRunner({ docker: { exitCode: 0 } });
    const ctx = makeCtx(runner, makeConfig({ osv: { runner: 'docker' } }));
    await expect(engine.scan(ctx)).rejects.toThrow(EnvironmentError);
  });

  // Line 425: non-Error thrown → String(err) in PhaseError
  it('line 425: non-Error thrown inside scan → PhaseError with String(err)', async () => {
    vi.spyOn(engine, 'assertAvailable').mockRejectedValueOnce('string-scan-error');
    const runner = new MockRunner({ docker: { exitCode: 0 } });
    const ctx = makeCtx(runner, makeConfig({ osv: { runner: 'docker' } }));
    await expect(engine.scan(ctx)).rejects.toThrow('OSV scanner phase failed: string-scan-error');
  });

  // Lines 177-179: pkg.package?.name/version/ecosystem null → ?? '' fires
  it('lines 177-179: pkg.package fields null → ?? "" fallback fires', async () => {
    const jsonWithNullFields = JSON.stringify({
      results: [{
        packages: [{
          package: { name: null, version: null, ecosystem: 'npm' },
          vulnerabilities: [],
          groups: [],
        }],
      }],
    });
    const runner = new MockRunner({ '--lockfile': { stdout: jsonWithNullFields, exitCode: 0 } });
    const ctx = makeCtx(runner, makeConfig({ osv: { runner: 'local' } }));
    const result = await engine.scan(ctx);
    expect(result.status).toBe('success');
  });

  // Lines 199-200: vuln.id/summary null → ?? '' fires
  it('lines 199-200: vuln.id and vuln.summary null → ?? "" fallback fires', async () => {
    const jsonWithNullVulnFields = JSON.stringify({
      results: [{
        packages: [{
          package: { name: 'lodash', version: '4.17.15', ecosystem: 'npm' },
          vulnerabilities: [{
            id: null,
            summary: null,
            affected: [{ ranges: [{ events: [{ introduced: '0' }, { fixed: '4.17.21' }] }] }],
          }],
          groups: [{ ids: [null] }],
        }],
      }],
    });
    const runner = new MockRunner({ '--lockfile': { stdout: jsonWithNullVulnFields, exitCode: 0 } });
    const ctx = makeCtx(runner, makeConfig({ osv: { runner: 'local' } }));
    const result = await engine.scan(ctx);
    expect(result.status).toBe('success');
  });
});
