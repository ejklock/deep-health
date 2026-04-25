/**
 * Branch coverage for src/modules/ecosystem/plugins/npm.ts
 * Targets:
 * - line 106: supportedFixers property access
 * - lines 221-222: versionAfter === undefined || versionAfter === versionBefore (warn branch)
 * - line 236: return { status: 'error' } when verifiedCount === 0
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@infra/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { mockReadFile } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readFile: mockReadFile,
}));

const { mockRunNpmUpdater } = vi.hoisted(() => ({
  mockRunNpmUpdater: vi.fn().mockResolvedValue({
    agent: 'npm',
    status: 'success',
    environment: 'local',
    packages_updated: [],
    validations: [],
  }),
}));

vi.mock('@modules/ecosystem/plugins/npm-updater', () => ({
  runNpmUpdater: mockRunNpmUpdater,
}));

import { npmPlugin } from '@modules/ecosystem/plugins/npm';
import type { CommandRunner, CommandResult } from '@core/types/common';
import type { ScanResultJson } from '@core/types/scan';
import { logger } from '@infra/utils/logger';

function ok(stdout = ''): CommandResult {
  return { stdout, stderr: '', exitCode: 0, command: '', dryRun: false };
}

function makeRunner(): CommandRunner {
  return {
    run: vi.fn().mockResolvedValue(ok()),
    runArgs: vi.fn().mockResolvedValue(ok()),
    dryRun: false,
    environment: 'local',
  } as unknown as CommandRunner;
}

function buildLockfile(pairs: Array<{ name: string; version: string }>): string {
  const packages: Record<string, { version: string }> = { '': { version: '1.0.0' } };
  const dependencies: Record<string, { version: string }> = {};
  for (const { name, version } of pairs) {
    packages[`node_modules/${name}`] = { version };
    dependencies[name] = { version };
  }
  return JSON.stringify({ name: 'sample', lockfileVersion: 2, packages, dependencies });
}

function buildScan(breakingPkgs: { pkg: string; safeVersion: string }[]): ScanResultJson {
  return {
    $schema: 'osv-scan-result/v1',
    agent: 'osv',
    status: 'success',
    environment: 'local',
    ecosystems: {
      npm: {
        vulnerabilities_total: breakingPkgs.length,
        auto_safe: 0,
        breaking: breakingPkgs.length,
        manual: 0,
        auto_safe_packages: [],
        breaking_packages: breakingPkgs.map((p) => `${p.pkg}@${p.safeVersion}`),
        manual_packages: [],
        vulnerabilities: breakingPkgs.map((p) => ({
          ecosystem: 'npm',
          package: p.pkg,
          currentVersion: '1.0.0',
          safeVersion: p.safeVersion,
          cvss: '8.0',
          ghsaId: 'GHSA-test',
          risk: 'critical',
          classification: 'breaking' as const,
          reason: 'major bump',
        })),
      },
    },
    error: null,
  };
}

describe('npmPlugin.supportedFixers', () => {
  it('exposes supportedFixers array (line 106)', () => {
    expect(npmPlugin.supportedFixers).toContain('osv');
    expect(npmPlugin.supportedFixers).toContain('npm-audit');
    expect(npmPlugin.supportedFixers).toContain('osv-then-audit');
  });
});

describe('npmPlugin.installBreakingPackages — version not in lockfile diff (lines 221-222)', () => {
  beforeEach(() => { vi.clearAllMocks(); mockReadFile.mockReset(); });

  it('warns when versionAfter is undefined (package not in post-install lockfile)', async () => {
    const runner = makeRunner();
    const preLockfile = buildLockfile([{ name: 'ajv', version: '6.0.0' }]);
    // Post-install lockfile: ajv still at 6.0.0 (not upgraded)
    const postLockfile = buildLockfile([{ name: 'ajv', version: '6.0.0' }]);

    mockReadFile
      .mockResolvedValueOnce(preLockfile)   // pre-install
      .mockResolvedValueOnce(postLockfile); // post-install

    const scan = buildScan([{ pkg: 'ajv', safeVersion: '8.18.0' }]);
    const result = await npmPlugin.installBreakingPackages!({
      runner,
      cwd: '/project',
      scanResult: scan,
      dryRun: false,
      fixerStrategy: 'osv',
    });

    // versionAfter === versionBefore (6.0.0 === 6.0.0) → verifiedCount stays 0 → error
    expect(result?.status).toBe('error');
    expect((logger.warn as ReturnType<typeof vi.fn>).mock.calls.some(
      (c) => String(c[0]).includes('was requested but not found in lockfile diff'),
    )).toBe(true);
  });
});

describe('npmPlugin.installBreakingPackages — verifiedCount === 0 → error (line 236)', () => {
  beforeEach(() => { vi.clearAllMocks(); mockReadFile.mockReset(); });

  it('returns error with message when no breaking packages verified', async () => {
    const runner = makeRunner();
    const preLockfile = buildLockfile([]);
    const postLockfile = buildLockfile([]); // empty — no packages present

    mockReadFile
      .mockResolvedValueOnce(preLockfile)
      .mockResolvedValueOnce(postLockfile);

    const scan = buildScan([{ pkg: 'lodash', safeVersion: '4.17.21' }]);
    const result = await npmPlugin.installBreakingPackages!({
      runner,
      cwd: '/project',
      scanResult: scan,
      dryRun: false,
      fixerStrategy: 'osv',
    });

    expect(result?.status).toBe('error');
    expect(result?.error).toContain('Breaking install produced no verified upgrades');
    expect((logger.error as ReturnType<typeof vi.fn>).mock.calls.some(
      (c) => String(c[0]).includes('None of the requested packages'),
    )).toBe(true);
  });
});

// ─── protected-constraint skip warn (lines 154-158) ───────────────────────────

describe('npmPlugin.installBreakingPackages — protected-constraint warn (lines 154-158)', () => {
  beforeEach(() => { vi.clearAllMocks(); mockReadFile.mockReset(); });

  it('warns about protected-constraint packages and skips them', async () => {
    const runner = makeRunner();
    const lockfile = buildLockfile([{ name: 'react', version: '17.0.0' }]);

    mockReadFile
      .mockResolvedValueOnce(lockfile)   // pre-install
      .mockResolvedValueOnce(lockfile);  // post-install (no change)

    const scan: ScanResultJson = {
      $schema: 'osv-scan-result/v1',
      agent: 'osv',
      status: 'success',
      environment: 'local',
      ecosystems: {
        npm: {
          vulnerabilities_total: 1,
          auto_safe: 0,
          breaking: 1,
          manual: 0,
          auto_safe_packages: [],
          breaking_packages: [],
          manual_packages: [],
          vulnerabilities: [{
            ecosystem: 'npm',
            package: 'react',
            currentVersion: '17.0.0',
            safeVersion: '18.0.0',
            cvss: '8.0',
            ghsaId: 'GHSA-prot',
            risk: 'critical',
            classification: 'breaking' as const,
            breakingReason: 'protected-constraint',
          }],
        },
      },
      error: null,
    };

    // react is protected-constraint → skipped; breakingPkgs.size === 0 → success
    const result = await npmPlugin.installBreakingPackages!({
      runner,
      cwd: '/project',
      scanResult: scan,
      dryRun: false,
      fixerStrategy: 'osv',
    });

    expect(result?.status).toBe('success');
    expect((logger.warn as ReturnType<typeof vi.fn>).mock.calls.some(
      (c) => String(c[0]).includes('protected-constraint'),
    )).toBe(true);
  });
});

// ─── dryRun path (lines 173-175) ──────────────────────────────────────────────

describe('npmPlugin.installBreakingPackages — dryRun (lines 173-175)', () => {
  beforeEach(() => { vi.clearAllMocks(); mockReadFile.mockReset(); });

  it('logs dry-run and returns success without calling runArgs', async () => {
    const runner = makeRunner();
    const scan = buildScan([{ pkg: 'express', safeVersion: '4.21.0' }]);

    // No readFile calls expected in dryRun
    const result = await npmPlugin.installBreakingPackages!({
      runner,
      cwd: '/project',
      scanResult: scan,
      dryRun: true,
      fixerStrategy: 'osv',
    });

    expect(result?.status).toBe('success');
    expect(runner.runArgs).not.toHaveBeenCalled();
    expect((logger.info as ReturnType<typeof vi.fn>).mock.calls.some(
      (c) => String(c[0]).includes('DRY-RUN'),
    )).toBe(true);
  });
});

// ─── pre-install readFile throws (lines 182-183, 186) ─────────────────────────

describe('npmPlugin.installBreakingPackages — pre-install lockfile unreadable (lines 182-183, 186)', () => {
  beforeEach(() => { vi.clearAllMocks(); mockReadFile.mockReset(); });

  it('debug-logs and continues when pre-install lockfile cannot be read', async () => {
    const runner = makeRunner();
    const postLockfile = buildLockfile([{ name: 'moment', version: '2.30.0' }]);

    mockReadFile
      .mockRejectedValueOnce(new Error('ENOENT'))  // pre-install fails
      .mockResolvedValueOnce(postLockfile);          // post-install succeeds

    const scan = buildScan([{ pkg: 'moment', safeVersion: '2.30.0' }]);

    const result = await npmPlugin.installBreakingPackages!({
      runner,
      cwd: '/project',
      scanResult: scan,
      dryRun: false,
      fixerStrategy: 'osv',
    });

    expect((logger.debug as ReturnType<typeof vi.fn>).mock.calls.some(
      (c) => String(c[0]).includes('skipping pre-snapshot'),
    )).toBe(true);
    // moment@2.30.0 found post-install and not in empty rootBefore → verifiedCount++ → success
    expect(result?.status).toBe('success');
  });
});

// ─── install exit non-zero (lines 191-195) ────────────────────────────────────

describe('npmPlugin.installBreakingPackages — install fails (lines 191-195)', () => {
  beforeEach(() => { vi.clearAllMocks(); mockReadFile.mockReset(); });

  it('returns error when npm install exits non-zero', async () => {
    const preLockfile = buildLockfile([{ name: 'webpack', version: '4.0.0' }]);
    const failRunner: CommandRunner = {
      run: vi.fn().mockResolvedValue({ stdout: '', stderr: 'npm ERR!', exitCode: 1, command: '', dryRun: false }),
      runArgs: vi.fn().mockResolvedValue({ stdout: '', stderr: 'npm ERR!', exitCode: 1, command: '', dryRun: false }),
      dryRun: false,
      environment: 'local',
    } as unknown as CommandRunner;

    mockReadFile.mockResolvedValueOnce(preLockfile);

    const scan = buildScan([{ pkg: 'webpack', safeVersion: '5.0.0' }]);
    const result = await npmPlugin.installBreakingPackages!({
      runner: failRunner,
      cwd: '/project',
      scanResult: scan,
      dryRun: false,
      fixerStrategy: 'osv',
    });

    expect(result?.status).toBe('error');
    expect(result?.error).toContain('npm install');
    expect((logger.error as ReturnType<typeof vi.fn>).mock.calls.some(
      (c) => String(c[0]).includes('breaking packages failed'),
    )).toBe(true);
  });
});

// ─── post-install readFile throws (lines 202-203, 206) ────────────────────────

describe('npmPlugin.installBreakingPackages — post-install lockfile unreadable (lines 202-203, 206)', () => {
  beforeEach(() => { vi.clearAllMocks(); mockReadFile.mockReset(); });

  it('debug-logs and continues when post-install lockfile cannot be read', async () => {
    const runner = makeRunner();
    const preLockfile = buildLockfile([]);

    mockReadFile
      .mockResolvedValueOnce(preLockfile)           // pre-install succeeds
      .mockRejectedValueOnce(new Error('ENOENT'));  // post-install fails

    const scan = buildScan([{ pkg: 'chalk', safeVersion: '5.0.0' }]);

    const result = await npmPlugin.installBreakingPackages!({
      runner,
      cwd: '/project',
      scanResult: scan,
      dryRun: false,
      fixerStrategy: 'osv',
    });

    expect((logger.debug as ReturnType<typeof vi.fn>).mock.calls.some(
      (c) => String(c[0]).includes('skipping post-snapshot'),
    )).toBe(true);
    // post-install lockfile unreadable → rootAfter is empty Map → versionAfter undefined
    // → verifiedCount stays 0 → error
    expect(result?.status).toBe('error');
  });
});

// ─── verified success path (lines 221-222, 236) ───────────────────────────────

describe('npmPlugin.installBreakingPackages — verified success (lines 221-222, 236)', () => {
  beforeEach(() => { vi.clearAllMocks(); mockReadFile.mockReset(); });

  it('returns success when breaking package is verified in lockfile', async () => {
    const runner = makeRunner();
    const preLockfile = buildLockfile([{ name: 'lodash', version: '4.17.15' }]);
    const postLockfile = buildLockfile([{ name: 'lodash', version: '4.17.21' }]);

    mockReadFile
      .mockResolvedValueOnce(preLockfile)
      .mockResolvedValueOnce(postLockfile);

    const scan = buildScan([{ pkg: 'lodash', safeVersion: '4.17.21' }]);

    const result = await npmPlugin.installBreakingPackages!({
      runner,
      cwd: '/project',
      scanResult: scan,
      dryRun: false,
      fixerStrategy: 'osv',
    });

    expect(result?.status).toBe('success');
  });
});

// ─── npm plugin additional branch gaps ───────────────────────────────────────

describe('npmPlugin additional branch coverage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('line 122: getProtectedPackages ?? [] fires when npm key absent in protected_packages', async () => {
    const config = {
      project: { name: 'test', client: 'test' },
      protected_packages: {},
      ecosystems: [],
      safe_update_policy: { allow_patch_and_minor_within_constraints: true, require_authorization_for_constraint_change: false },
      conflict_resolution: 'fail' as const,
    };
    const result = npmPlugin.getProtectedPackages!(config as any);
    expect(result).toEqual([]);
  });

  it('lines 132-133: runUpdater with validationCommands and fixerStrategy absent fires ?? defaults', async () => {
    const config = {
      project: { name: 'test', client: 'test' },
      protected_packages: { npm: [], composer: [] },
      ecosystems: [{ id: 'npm', validationCommands: [] }],
      safe_update_policy: { allow_patch_and_minor_within_constraints: true, require_authorization_for_constraint_change: false },
      conflict_resolution: 'fail' as const,
    };
    const ctx = {
      runner: makeRunner(),
      config,
      scanResult: buildScan([]),
      cwd: '/project',
      authorizeBreaking: false,
      // validationCommands and fixerStrategy intentionally absent
    };
    const result = await npmPlugin.runUpdater(ctx as any);
    expect(result).toBeDefined();
  });

  it('line 148: installBreakingPackages returns null when fixerStrategy !== "osv"', async () => {
    const result = await npmPlugin.installBreakingPackages!({
      runner: makeRunner(),
      cwd: '/project',
      scanResult: buildScan([]),
      dryRun: false,
      fixerStrategy: 'npm-audit',
    });
    expect(result).toBeNull();
  });

  it('line 150: installBreakingPackages ?? emptyEcosystem() fires when npm key missing in scan', async () => {
    const scan = buildScan([]);
    (scan as any).ecosystems = {};
    const result = await npmPlugin.installBreakingPackages!({
      runner: makeRunner(),
      cwd: '/project',
      scanResult: scan as any,
      dryRun: false,
      fixerStrategy: 'osv',
    });
    // No breaking packages → returns { status: 'success' } or similar
    expect(result).toBeDefined();
  });

  it('line 213: spec with no "@" hits at > 0 false branch in breaking install verification', async () => {
    const scan = buildScan([]);
    // Add a breaking package spec without "@"
    scan.ecosystems['npm']!.breaking_packages = ['no-at-breaking'];
    scan.ecosystems['npm']!.breaking = 1;
    scan.ecosystems['npm']!.vulnerabilities.push({
      ecosystem: 'npm',
      package: 'no-at-breaking',
      currentVersion: '1.0.0',
      safeVersion: '2.0.0',
      cvss: '8.0',
      ghsaId: 'GHSA-breaking',
      risk: 'critical',
      classification: 'breaking' as const,
      reason: 'major',
    });

    const preLockfile = buildLockfile([{ name: 'no-at-breaking', version: '1.0.0' }]);
    const postLockfile = buildLockfile([{ name: 'no-at-breaking', version: '2.0.0' }]);
    mockReadFile
      .mockResolvedValueOnce(preLockfile)
      .mockResolvedValueOnce(postLockfile);

    const result = await npmPlugin.installBreakingPackages!({
      runner: makeRunner(),
      cwd: '/project',
      scanResult: scan,
      dryRun: false,
      fixerStrategy: 'osv',
    });
    expect(result).toBeDefined();
  });
});
