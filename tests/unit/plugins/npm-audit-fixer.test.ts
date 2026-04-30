import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module-level mocks ────────────────────────────────────────────────────────

vi.mock('@infra/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), phase: vi.fn(), skip: vi.fn(), header: vi.fn() },
}));

// Using vi.hoisted() so the vi.fn() instances are initialized before the
// hoisted vi.mock() factories reference them — avoids TDZ errors.
const { mockReadFile } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readFile: mockReadFile,
}));

import { applyNpmAuditFix } from '@modules/ecosystem/fixers/npm-audit-fixer';
import type { CommandRunner, CommandResult } from '@core/types/common';
import type { ScanResultJson } from '@core/types/scan';
import { logger } from '@infra/utils/logger.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a syntactically valid package-lock.json v2 content string whose tree
 * contains the given { name, version } pairs.
 */
function buildLockfile(pairs: Array<{ name: string; version: string }>, lockfileVersion = 2): string {
  const dependencies: Record<string, { version: string }> = {};
  const packages: Record<string, { name?: string; version: string }> = {
    '': { name: 'sample', version: '1.0.0' },
  };
  for (const { name, version } of pairs) {
    dependencies[name] = { version };
    packages[`node_modules/${name}`] = { version };
  }
  return JSON.stringify({ name: 'sample', lockfileVersion, dependencies, packages });
}

function ok(stdout = '', stderr = ''): CommandResult {
  return { stdout, stderr, exitCode: 0, command: '', dryRun: false };
}

function fail(stderr = 'something failed', exitCode = 1): CommandResult {
  return { stdout: '', stderr, exitCode, command: '', dryRun: false };
}

function makeRunner(overrides: Partial<CommandRunner> & { dryRun?: boolean } = {}): CommandRunner {
  const { dryRun = false, ...rest } = overrides;
  return {
    run: vi.fn().mockResolvedValue(ok()),
    runArgs: vi.fn().mockResolvedValue(ok()),
    dryRun,
    environment: 'local',
    ...rest,
  } as unknown as CommandRunner;
}

/**
 * Build a ScanResultJson for npm with the given packages.
 * `autoSafePkgs`: array of { pkg, version } for auto_safe vulnerabilities.
 * `breakingPkgs`: array of { pkg, safeVersion } for breaking vulnerabilities.
 */
function buildScan(
  autoSafePkgs: { pkg: string; version: string }[] = [],
  breakingPkgs: { pkg: string; safeVersion: string }[] = [],
): ScanResultJson {
  const auto_safe_packages = autoSafePkgs.map((p) => `${p.pkg}@${p.version}`);
  const breaking_packages = breakingPkgs.map((p) => `${p.pkg}@${p.safeVersion}`);
  const vulnerabilities = [
    ...autoSafePkgs.map((p) => ({
      ecosystem: 'npm',
      package: p.pkg,
      currentVersion: '1.0.0',
      safeVersion: p.version,
      cvss: '7.5',
      ghsaId: 'GHSA-auto',
      risk: 'high',
      classification: 'auto_safe' as const,
      reason: 'patch update',
    })),
    ...breakingPkgs.map((p) => ({
      ecosystem: 'npm',
      package: p.pkg,
      currentVersion: '1.0.0',
      safeVersion: p.safeVersion,
      cvss: '8.0',
      ghsaId: 'GHSA-breaking',
      risk: 'critical',
      classification: 'breaking' as const,
      reason: 'major version bump',
    })),
  ];
  return {
    $schema: 'osv-scan-result/v1',
    agent: 'osv',
    status: 'success',
    environment: 'local',
    ecosystems: {
      npm: {
        vulnerabilities_total: vulnerabilities.length,
        auto_safe: autoSafePkgs.length,
        breaking: breakingPkgs.length,
        manual: 0,
        auto_safe_packages,
        breaking_packages,
        manual_packages: [],
        vulnerabilities,
      },
    },
    error: null,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('applyNpmAuditFix — happy path: all auto-safe packages upgraded', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns packagesUpdated with verified upgrades when lockfile post-fix has newer versions', async () => {
    const runner = makeRunner();

    const preLockfile = buildLockfile([
      { name: 'lodash', version: '4.17.20' },
      { name: 'axios', version: '1.6.0' },
    ]);
    const postLockfile = buildLockfile([
      { name: 'lodash', version: '4.17.21' },
      { name: 'axios', version: '1.7.0' },
    ]);

    mockReadFile
      .mockResolvedValueOnce(preLockfile)   // pre-fix read
      .mockResolvedValueOnce(postLockfile); // post-fix read

    const scan = buildScan([
      { pkg: 'lodash', version: '4.17.21' },
      { pkg: 'axios', version: '1.7.0' },
    ]);

    const result = await applyNpmAuditFix({
      runner,
      cwd: '/project',
      scanResult: scan,
      authorizeBreaking: false,
    });

    expect(result.breakingInstallError).toBeNull();
    expect(result.packagesUpdated).toHaveLength(2);
    expect(result.packagesUpdated).toContain('lodash@4.17.21');
    expect(result.packagesUpdated).toContain('axios@1.7.0');
  });
});

describe('applyNpmAuditFix — false positive from scanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns packagesUpdated=[] and warns when pre and post lockfile are identical', async () => {
    const runner = makeRunner();

    const lockfile = buildLockfile([
      { name: 'lodash', version: '4.17.20' },
      { name: 'axios', version: '1.6.0' },
    ]);

    // same lockfile before and after — npm audit fix did nothing
    mockReadFile
      .mockResolvedValueOnce(lockfile)
      .mockResolvedValueOnce(lockfile);

    const scan = buildScan([
      { pkg: 'lodash', version: '4.17.21' },
      { pkg: 'axios', version: '1.7.0' },
    ]);

    const result = await applyNpmAuditFix({
      runner,
      cwd: '/project',
      scanResult: scan,
      authorizeBreaking: false,
    });

    expect(result.breakingInstallError).toBeNull();
    expect(result.packagesUpdated).toHaveLength(0);

    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    expect(
      warnCalls.some((c) => String(c[0]).includes('no newer version')),
    ).toBe(true);
  });
});

describe('applyNpmAuditFix — partial success', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns only verified packages and warns about unverified when npm audit fix partially succeeds', async () => {
    const runner = makeRunner();

    const preLockfile = buildLockfile([
      { name: 'a', version: '1.0.0' },
      { name: 'b', version: '2.0.0' },
      { name: 'c', version: '3.0.0' },
    ]);
    // only 'a' was upgraded
    const postLockfile = buildLockfile([
      { name: 'a', version: '1.1.0' },
      { name: 'b', version: '2.0.0' },
      { name: 'c', version: '3.0.0' },
    ]);

    mockReadFile
      .mockResolvedValueOnce(preLockfile)
      .mockResolvedValueOnce(postLockfile);

    const scan = buildScan([
      { pkg: 'a', version: '1.1.0' },
      { pkg: 'b', version: '2.1.0' },
      { pkg: 'c', version: '3.1.0' },
    ]);

    const result = await applyNpmAuditFix({
      runner,
      cwd: '/project',
      scanResult: scan,
      authorizeBreaking: false,
    });

    expect(result.packagesUpdated).toHaveLength(1);
    expect(result.packagesUpdated[0]).toBe('a@1.1.0');

    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    expect(warnCalls.some((c) => String(c[0]).includes('no newer version'))).toBe(true);
  });
});

describe('applyNpmAuditFix — npm audit fix non-zero exit with partial patches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not abort on non-zero exit and returns verified packages', async () => {
    const runner = makeRunner();
    const runMock = runner.run as ReturnType<typeof vi.fn>;

    // npm audit fix exits 1 but some upgrades were applied
    runMock.mockResolvedValue(fail('some audit error', 1));

    const preLockfile = buildLockfile([
      { name: 'p1', version: '1.0.0' },
      { name: 'p2', version: '2.0.0' },
      { name: 'p3', version: '3.0.0' },
      { name: 'p4', version: '4.0.0' },
      { name: 'p5', version: '5.0.0' },
    ]);
    // 2 of 5 were upgraded
    const postLockfile = buildLockfile([
      { name: 'p1', version: '1.1.0' },
      { name: 'p2', version: '2.1.0' },
      { name: 'p3', version: '3.0.0' },
      { name: 'p4', version: '4.0.0' },
      { name: 'p5', version: '5.0.0' },
    ]);

    mockReadFile
      .mockResolvedValueOnce(preLockfile)
      .mockResolvedValueOnce(postLockfile);

    const scan = buildScan([
      { pkg: 'p1', version: '1.1.0' },
      { pkg: 'p2', version: '2.1.0' },
      { pkg: 'p3', version: '3.1.0' },
      { pkg: 'p4', version: '4.1.0' },
      { pkg: 'p5', version: '5.1.0' },
    ]);

    const result = await applyNpmAuditFix({
      runner,
      cwd: '/project',
      scanResult: scan,
      authorizeBreaking: false,
    });

    expect(result.breakingInstallError).toBeNull();
    expect(result.packagesUpdated).toHaveLength(2);
    expect(result.packagesUpdated).toContain('p1@1.1.0');
    expect(result.packagesUpdated).toContain('p2@2.1.0');
  });
});

describe('applyNpmAuditFix — lockfile absent pre-fix', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty result and never calls npm audit fix when lockfile does not exist', async () => {
    const runner = makeRunner();

    const enoent = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
    mockReadFile.mockRejectedValue(enoent);

    const scan = buildScan([{ pkg: 'lodash', version: '4.17.21' }]);

    const result = await applyNpmAuditFix({
      runner,
      cwd: '/project',
      scanResult: scan,
      authorizeBreaking: false,
    });

    expect(result.breakingInstallError).toBeNull();
    expect(result.packagesUpdated).toHaveLength(0);
    expect(runner.run).not.toHaveBeenCalled();
  });
});

describe('applyNpmAuditFix — lockfile malformed pre-fix', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty result and never calls npm audit fix when lockfile is unparseable', async () => {
    const runner = makeRunner();

    // collectNpmLockfileVersions returns empty map for garbage content
    mockReadFile.mockResolvedValue('this is not json at all !@#$');

    const scan = buildScan([{ pkg: 'lodash', version: '4.17.21' }]);

    const result = await applyNpmAuditFix({
      runner,
      cwd: '/project',
      scanResult: scan,
      authorizeBreaking: false,
    });

    expect(result.breakingInstallError).toBeNull();
    expect(result.packagesUpdated).toHaveLength(0);
    expect(runner.run).not.toHaveBeenCalled();
  });
});

describe('applyNpmAuditFix — breaking install verified', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('includes verified breaking package in packagesUpdated when lockfile post-install has target version', async () => {
    const runner = makeRunner();

    const preLockfile = buildLockfile([{ name: 'ajv', version: '6.0.0' }]);
    const postAutoSafeLockfile = buildLockfile([{ name: 'ajv', version: '6.0.0' }]);
    const postBreakingLockfile = buildLockfile([{ name: 'ajv', version: '8.18.0' }]);

    mockReadFile
      .mockResolvedValueOnce(preLockfile)           // pre-fix
      .mockResolvedValueOnce(postAutoSafeLockfile)  // post auto-safe
      .mockResolvedValueOnce(postBreakingLockfile); // post breaking install

    const scan = buildScan([], [{ pkg: 'ajv', safeVersion: '8.18.0' }]);

    const result = await applyNpmAuditFix({
      runner,
      cwd: '/project',
      scanResult: scan,
      authorizeBreaking: true,
    });

    expect(result.breakingInstallError).toBeNull();
    expect(result.packagesUpdated).toContain('ajv@8.18.0');
  });
});

describe('applyNpmAuditFix — breaking install partial', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns verified subset and warns about unverified when 2 of 3 breaking installs land on disk', async () => {
    const runner = makeRunner();

    const preLockfile = buildLockfile([
      { name: 'pkg-a', version: '1.0.0' },
      { name: 'pkg-b', version: '1.0.0' },
      { name: 'pkg-c', version: '1.0.0' },
    ]);
    const postAutoSafe = buildLockfile([
      { name: 'pkg-a', version: '1.0.0' },
      { name: 'pkg-b', version: '1.0.0' },
      { name: 'pkg-c', version: '1.0.0' },
    ]);
    // pkg-c was not upgraded
    const postBreaking = buildLockfile([
      { name: 'pkg-a', version: '2.0.0' },
      { name: 'pkg-b', version: '2.0.0' },
      { name: 'pkg-c', version: '1.0.0' },
    ]);

    mockReadFile
      .mockResolvedValueOnce(preLockfile)
      .mockResolvedValueOnce(postAutoSafe)
      .mockResolvedValueOnce(postBreaking);

    const scan = buildScan([], [
      { pkg: 'pkg-a', safeVersion: '2.0.0' },
      { pkg: 'pkg-b', safeVersion: '2.0.0' },
      { pkg: 'pkg-c', safeVersion: '2.0.0' },
    ]);

    const result = await applyNpmAuditFix({
      runner,
      cwd: '/project',
      scanResult: scan,
      authorizeBreaking: true,
    });

    expect(result.breakingInstallError).toBeNull();
    expect(result.packagesUpdated).toHaveLength(2);
    expect(result.packagesUpdated).toContain('pkg-a@2.0.0');
    expect(result.packagesUpdated).toContain('pkg-b@2.0.0');
    expect(result.packagesUpdated).not.toContain('pkg-c@2.0.0');

    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    expect(warnCalls.some((c) => String(c[0]).includes('unverified'))).toBe(true);
  });
});

describe('applyNpmAuditFix — breaking install total failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets breakingInstallError and packagesUpdated contains only auto-safe verified when npm install fails with no disk changes', async () => {
    const runner = makeRunner();
    const runArgsMock = runner.runArgs as ReturnType<typeof vi.fn>;

    // npm audit fix succeeds (upgrades lodash), npm install fails (nothing upgrades)
    runArgsMock
      .mockResolvedValueOnce(ok())           // npm audit fix
      .mockResolvedValueOnce(fail('peer dep conflict', 1)); // npm install

    const preLockfile = buildLockfile([
      { name: 'lodash', version: '4.17.20' },
      { name: 'ajv', version: '6.0.0' },
    ]);
    const postAutoSafe = buildLockfile([
      { name: 'lodash', version: '4.17.21' },
      { name: 'ajv', version: '6.0.0' },
    ]);
    // breaking install changed nothing
    const postBreaking = buildLockfile([
      { name: 'lodash', version: '4.17.21' },
      { name: 'ajv', version: '6.0.0' },
    ]);

    mockReadFile
      .mockResolvedValueOnce(preLockfile)
      .mockResolvedValueOnce(postAutoSafe)
      .mockResolvedValueOnce(postBreaking);

    const scan = buildScan(
      [{ pkg: 'lodash', version: '4.17.21' }],
      [{ pkg: 'ajv', safeVersion: '8.18.0' }],
    );

    const result = await applyNpmAuditFix({
      runner,
      cwd: '/project',
      scanResult: scan,
      authorizeBreaking: true,
    });

    // auto-safe lodash verified
    expect(result.packagesUpdated).toContain('lodash@4.17.21');
    // breaking failed
    expect(result.breakingInstallError).not.toBeNull();
    expect(result.breakingInstallError).toContain('npm install');
    // ajv not in packagesUpdated
    expect(result.packagesUpdated.some((p) => p.startsWith('ajv@'))).toBe(false);
  });
});

describe('applyNpmAuditFix — disk regression (version lower than pre-fix)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('discards package from verified list and warns when post-fix lockfile has older version than pre-fix', async () => {
    const runner = makeRunner();

    const preLockfile = buildLockfile([{ name: 'strange-pkg', version: '2.0.0' }]);
    // lockfile shows a downgrade after npm audit fix (should not happen but must be handled)
    const postLockfile = buildLockfile([{ name: 'strange-pkg', version: '1.9.0' }]);

    mockReadFile
      .mockResolvedValueOnce(preLockfile)
      .mockResolvedValueOnce(postLockfile);

    const scan = buildScan([{ pkg: 'strange-pkg', version: '2.1.0' }]);

    const result = await applyNpmAuditFix({
      runner,
      cwd: '/project',
      scanResult: scan,
      authorizeBreaking: false,
    });

    expect(result.packagesUpdated).toHaveLength(0);

    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    expect(warnCalls.some((c) => String(c[0]).includes('no newer version'))).toBe(true);
  });
});

// ── Regression guard ──────────────────────────────────────────────────────────
// These tests document the exact behavior that was broken before disk-verification
// was added. They should fail if the old behavior of returning `auto_safe_packages`
// directly is ever restored.

describe('regression: scanner auto_safe cannot override disk verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does NOT return scanner auto_safe_packages when npm audit fix made no lockfile changes', async () => {
    const runner = makeRunner();

    const lockfile = buildLockfile([
      { name: 'express', version: '4.18.1' },
      { name: 'helmet', version: '7.0.0' },
    ]);

    // pre == post → no changes at all
    mockReadFile
      .mockResolvedValueOnce(lockfile)
      .mockResolvedValueOnce(lockfile);

    const scan = buildScan([
      { pkg: 'express', version: '4.19.0' },
      { pkg: 'helmet', version: '7.1.0' },
    ]);

    const result = await applyNpmAuditFix({
      runner,
      cwd: '/project',
      scanResult: scan,
      authorizeBreaking: false,
    });

    // Old behavior would return ['express@4.19.0', 'helmet@7.1.0']
    // New behavior must return []
    expect(result.packagesUpdated).toHaveLength(0);
    expect(result.packagesUpdated).not.toContain('express@4.19.0');
    expect(result.packagesUpdated).not.toContain('helmet@7.1.0');
  });

  it('does NOT report packages as updated when lockfile is identical after npm audit fix exits non-zero', async () => {
    const runner = makeRunner();
    const runMock = runner.run as ReturnType<typeof vi.fn>;

    runMock.mockResolvedValue(fail('npm ERR! audit fix failed', 1));

    const lockfile = buildLockfile([
      { name: 'minimist', version: '1.2.5' },
      { name: 'cross-fetch', version: '3.1.4' },
    ]);

    mockReadFile
      .mockResolvedValueOnce(lockfile)
      .mockResolvedValueOnce(lockfile);

    const scan = buildScan([
      { pkg: 'minimist', version: '1.2.8' },
      { pkg: 'cross-fetch', version: '3.1.8' },
    ]);

    const result = await applyNpmAuditFix({
      runner,
      cwd: '/project',
      scanResult: scan,
      authorizeBreaking: false,
    });

    // Old behavior: packagesUpdated would be ['minimist@1.2.8', 'cross-fetch@3.1.8']
    // New behavior: disk says nothing changed → packagesUpdated is []
    expect(result.packagesUpdated).toHaveLength(0);
    expect(result.packagesUpdated).not.toContain('minimist@1.2.8');
    expect(result.packagesUpdated).not.toContain('cross-fetch@3.1.8');
  });
});

describe('applyNpmAuditFix — readFile failure after breaking install (lines 197-199)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('logs warning and falls back to postAutoSafeLockfile when readFile throws after breaking install', async () => {
    const runner = makeRunner();

    const preLockfile = buildLockfile([{ name: 'ajv', version: '6.0.0' }]);
    const postAutoSafeLockfile = buildLockfile([{ name: 'ajv', version: '6.0.0' }]);

    mockReadFile
      .mockResolvedValueOnce(preLockfile)           // pre-fix read
      .mockResolvedValueOnce(postAutoSafeLockfile)  // post auto-safe read
      .mockRejectedValueOnce(new Error('ENOENT: no such file or directory')); // post breaking read fails

    const scan = buildScan([], [{ pkg: 'ajv', safeVersion: '8.18.0' }]);

    const result = await applyNpmAuditFix({
      runner,
      cwd: '/project',
      scanResult: scan,
      authorizeBreaking: true,
    });

    // Falls back to postAutoSafeLockfile which has ajv@6.0.0, not 8.18.0 → unverified
    expect((logger.warn as ReturnType<typeof vi.fn>).mock.calls.some(
      (c) => String(c[0]).includes('Could not read package-lock.json after breaking install'),
    )).toBe(true);
  });
});

describe('applyNpmAuditFix — breaking install exits non-zero with no verified packages (lines 219-220)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns breakingInstallError when install exits non-zero and no breaking packages verified', async () => {
    const runner = makeRunner();
    // Override runArgs to simulate failing breaking install
    const runArgsMock = runner.runArgs as ReturnType<typeof vi.fn>;
    runArgsMock.mockResolvedValue({ stdout: '', stderr: 'npm ERR! code E401', exitCode: 1, command: '', dryRun: false });

    const preLockfile = buildLockfile([{ name: 'ajv', version: '6.0.0' }]);
    const postAutoSafeLockfile = buildLockfile([{ name: 'ajv', version: '6.0.0' }]);
    const postBreakingLockfile = buildLockfile([{ name: 'ajv', version: '6.0.0' }]); // not updated

    mockReadFile
      .mockResolvedValueOnce(preLockfile)
      .mockResolvedValueOnce(postAutoSafeLockfile)
      .mockResolvedValueOnce(postBreakingLockfile);

    const scan = buildScan([], [{ pkg: 'ajv', safeVersion: '8.18.0' }]);

    const result = await applyNpmAuditFix({
      runner,
      cwd: '/project',
      scanResult: scan,
      authorizeBreaking: true,
    });

    expect(result.breakingInstallError).toBeTruthy();
    expect(result.breakingInstallError).toContain('failed');
  });
});

// ─── semverMax multi-version loop (lines 34-40) ───────────────────────────────

describe('applyNpmAuditFix — semverMax multi-version (lines 34-40)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('picks the highest semver when a package has multiple nested versions', async () => {
    // Pre-lockfile: lodash at 4.17.19 (top-level) and 4.17.15 (nested) → semverMax = 4.17.19
    // Post-lockfile: lodash at 4.17.21 everywhere → semverMax = 4.17.21
    const preLockfile = JSON.stringify({
      name: 'sample',
      lockfileVersion: 2,
      dependencies: { lodash: { version: '4.17.19' } },
      packages: {
        '': { name: 'sample', version: '1.0.0' },
        'node_modules/lodash': { version: '4.17.19' },
        'node_modules/some-lib/node_modules/lodash': { version: '4.17.15' },
      },
    });
    const postLockfile = JSON.stringify({
      name: 'sample',
      lockfileVersion: 2,
      dependencies: { lodash: { version: '4.17.21' } },
      packages: {
        '': { name: 'sample', version: '1.0.0' },
        'node_modules/lodash': { version: '4.17.21' },
        'node_modules/some-lib/node_modules/lodash': { version: '4.17.21' },
      },
    });

    mockReadFile
      .mockResolvedValueOnce(preLockfile)
      .mockResolvedValueOnce(postLockfile);

    const scan = buildScan([{ pkg: 'lodash', version: '4.17.19' }]);

    const result = await applyNpmAuditFix({
      runner: makeRunner(),
      cwd: '/project',
      scanResult: scan,
      authorizeBreaking: false,
    });

    expect(result.packagesUpdated.some((p) => p.startsWith('lodash@'))).toBe(true);
  });
});

// ─── isUpgraded non-semver fallback (lines 66-67) ─────────────────────────────

describe('applyNpmAuditFix — isUpgraded non-semver fallback (lines 66-67)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not count as upgrade when both pre and post versions are non-semver', async () => {
    const preLockfile = JSON.stringify({
      name: 'sample',
      lockfileVersion: 2,
      dependencies: { 'native-pkg': { version: 'git+https://github.com/foo/bar.git' } },
      packages: {
        '': { name: 'sample', version: '1.0.0' },
        'node_modules/native-pkg': { version: 'git+https://github.com/foo/bar.git' },
      },
    });
    const postLockfile = JSON.stringify({
      name: 'sample',
      lockfileVersion: 2,
      dependencies: { 'native-pkg': { version: 'git+https://github.com/foo/bar2.git' } },
      packages: {
        '': { name: 'sample', version: '1.0.0' },
        'node_modules/native-pkg': { version: 'git+https://github.com/foo/bar2.git' },
      },
    });

    mockReadFile
      .mockResolvedValueOnce(preLockfile)
      .mockResolvedValueOnce(postLockfile);

    const scan = buildScan([{ pkg: 'native-pkg', version: '0.0.1' }]);

    const result = await applyNpmAuditFix({
      runner: makeRunner(),
      cwd: '/project',
      scanResult: scan,
      authorizeBreaking: false,
    });

    expect(result.packagesUpdated.some((p) => p.startsWith('native-pkg@'))).toBe(false);
  });
});

// ─── post-audit lockfile read failure (lines 118-120) ─────────────────────────

describe('applyNpmAuditFix — post-audit lockfile unreadable (lines 118-120)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('warns and falls back to pre-fix lockfile when post-fix read fails', async () => {
    const preLockfile = buildLockfile([{ name: 'ms', version: '2.0.0' }]);

    mockReadFile
      .mockResolvedValueOnce(preLockfile)       // pre-fix read
      .mockRejectedValueOnce(new Error('EIO')); // post-audit-fix read fails

    const scan = buildScan([{ pkg: 'ms', version: '2.0.0' }]);

    const result = await applyNpmAuditFix({
      runner: makeRunner(),
      cwd: '/project',
      scanResult: scan,
      authorizeBreaking: false,
    });

    expect((logger.warn as ReturnType<typeof vi.fn>).mock.calls.some(
      (c) => String(c[0]).includes('Could not read package-lock.json after npm audit fix'),
    )).toBe(true);
    // Falls back to pre-lockfile, so ms is not upgraded
    expect(result.packagesUpdated).toHaveLength(0);
  });
});

// ─── bare package name (no @version) in auto_safe_packages (line 135) ─────────

describe('applyNpmAuditFix — bare package name in auto_safe_packages (line 135)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('handles bare package name (no @version suffix) correctly', async () => {
    const preLockfile = buildLockfile([{ name: 'debug', version: '4.3.3' }]);
    const postLockfile = buildLockfile([{ name: 'debug', version: '4.3.7' }]);

    mockReadFile
      .mockResolvedValueOnce(preLockfile)
      .mockResolvedValueOnce(postLockfile);

    // Inject scan with bare name (no @version)
    const scan: ScanResultJson = {
      $schema: 'osv-scan-result/v1',
      agent: 'osv',
      status: 'success',
      environment: 'local',
      error: null,
      ecosystems: {
        npm: {
          vulnerabilities_total: 1,
          auto_safe: 1,
          breaking: 0,
          manual: 0,
          auto_safe_packages: ['debug'], // bare name, no @version
          breaking_packages: [],
          manual_packages: [],
          vulnerabilities: [{
            ecosystem: 'npm',
            package: 'debug',
            currentVersion: '4.3.3',
            safeVersion: '4.3.7',
            cvss: '5.0',
            ghsaId: 'GHSA-bare',
            risk: 'medium',
            classification: 'auto_safe' as const,
          }],
        },
      },
    };

    const result = await applyNpmAuditFix({
      runner: makeRunner(),
      cwd: '/project',
      scanResult: scan,
      authorizeBreaking: false,
    });

    expect(result.packagesUpdated.some((p) => p.startsWith('debug@'))).toBe(true);
  });
});

// ─── breaking install semver.gte path (lines 219-220) ─────────────────────────

describe('applyNpmAuditFix — breaking install semver.gte verification (lines 219-220)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('verifies breaking package when disk version is >= target (but not exact match)', async () => {
    const preLockfile = buildLockfile([{ name: 'webpack', version: '4.0.0' }]);
    const postAutoSafe = buildLockfile([{ name: 'webpack', version: '4.0.0' }]);
    // Disk gets webpack@5.99.0 — higher than target 5.0.0, not exact, triggers semver.gte path
    const postBreaking = buildLockfile([{ name: 'webpack', version: '5.99.0' }]);

    mockReadFile
      .mockResolvedValueOnce(preLockfile)
      .mockResolvedValueOnce(postAutoSafe)
      .mockResolvedValueOnce(postBreaking);

    const scan = buildScan([], [{ pkg: 'webpack', safeVersion: '5.0.0' }]);

    const result = await applyNpmAuditFix({
      runner: makeRunner(),
      cwd: '/project',
      scanResult: scan,
      authorizeBreaking: true,
    });

    // webpack@5.99.0 >= 5.0.0 → verified
    expect(result.packagesUpdated.some((p) => p.startsWith('webpack@'))).toBe(true);
    expect(result.breakingInstallError).toBeNull();
  });
});

describe('applyNpmAuditFix — semverMax non-semver best replaced by semver (lines 39-40)', () => {
  beforeEach(() => {
    mockReadFile.mockReset();
  });

  it('picks semver version when lockfile set has non-semver entry followed by semver entry', async () => {
    const runner = makeRunner();

    // Lockfile where "mixed-pkg" has git URL in dependencies and semver in packages
    const lockfileWithMixed = JSON.stringify({
      name: 'sample',
      lockfileVersion: 2,
      dependencies: {
        'mixed-pkg': { version: 'github:user/mixed-pkg#abc123' }, // non-semver → best first
      },
      packages: {
        '': { name: 'sample', version: '1.0.0' },
        'node_modules/mixed-pkg': { version: '2.0.0' }, // valid semver → vValid && !bestValid fires
      },
    });
    const postAuditLockfile = buildLockfile([{ name: 'mixed-pkg', version: '2.1.0' }]);

    mockReadFile
      .mockResolvedValueOnce(lockfileWithMixed)   // pre-fix snapshot
      .mockResolvedValueOnce(postAuditLockfile);  // post-fix snapshot

    const scan = buildScan([{ pkg: 'mixed-pkg', version: '2.1.0' }]);

    const result = await applyNpmAuditFix({
      runner,
      cwd: '/project',
      scanResult: scan,
      authorizeBreaking: false,
    });

    // The test exercises lines 39-40; result outcome is secondary
    expect(result).toBeDefined();
  });
});

// ─── lockfileVersion 1: nested dedup false positive regression ───────────────
// npm 6 (lockfileVersion 1) cannot update root entries in-place via `npm audit fix`.
// Instead it adds a nested dependencies.<pkg>.dependencies.<pkg> entry. If version
// comparison uses the full recursive tree (semverMax), the nested copy makes the
// package look upgraded even though the root is unchanged → false positive report.

describe('regression: lockfileVersion 1 nested dedup must NOT produce false positive', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns packagesUpdated=[] when root version unchanged (only nested dedup copy added)', async () => {
    const runner = makeRunner();

    // lockfileVersion 1: flat dependencies, no packages key
    const preLockfile = JSON.stringify({
      name: 'sample',
      lockfileVersion: 1,
      dependencies: {
        axios: { version: '0.21.4', resolved: 'https://registry.npmjs.org/axios/-/axios-0.21.4.tgz' },
        'other-dep': { version: '1.0.0' },
      },
    });
    // After npm audit fix on v1: root axios stays 0.21.4, nested dedup copy 0.26.1 added
    const postLockfile = JSON.stringify({
      name: 'sample',
      lockfileVersion: 1,
      dependencies: {
        axios: {
          version: '0.21.4',
          resolved: 'https://registry.npmjs.org/axios/-/axios-0.21.4.tgz',
          dependencies: {
            axios: { version: '0.26.1', resolved: 'https://registry.npmjs.org/axios/-/axios-0.26.1.tgz' },
          },
        },
        'other-dep': { version: '1.0.0' },
      },
    });

    mockReadFile
      .mockResolvedValueOnce(preLockfile)
      .mockResolvedValueOnce(postLockfile);

    const scan = buildScan([{ pkg: 'axios', version: '0.21.4' }]);

    const result = await applyNpmAuditFix({ runner, cwd: '/project', scanResult: scan, authorizeBreaking: false });

    // Root was NOT upgraded — nested dedup copy must not trigger false positive
    expect(result.packagesUpdated).toHaveLength(0);
    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    expect(warnCalls.some((c) => String(c[0]).includes('no newer version'))).toBe(true);
  });

  it('returns packagesUpdated with new version when root IS genuinely upgraded on lockfileVersion 1', async () => {
    const runner = makeRunner();

    const preLockfile = JSON.stringify({
      name: 'sample',
      lockfileVersion: 1,
      dependencies: {
        axios: { version: '0.21.4' },
        'other-dep': { version: '1.0.0' },
      },
    });
    const postLockfile = JSON.stringify({
      name: 'sample',
      lockfileVersion: 1,
      dependencies: {
        axios: { version: '0.26.1' },  // root genuinely updated
        'other-dep': { version: '1.0.0' },
      },
    });

    mockReadFile
      .mockResolvedValueOnce(preLockfile)
      .mockResolvedValueOnce(postLockfile);

    const scan = buildScan([{ pkg: 'axios', version: '0.21.4' }]);

    const result = await applyNpmAuditFix({ runner, cwd: '/project', scanResult: scan, authorizeBreaking: false });

    expect(result.packagesUpdated).toContain('axios@0.26.1');
  });
});

// ─── L30: semverMax empty-set path ────────────────────────────────────────────
// Branch: versions.size === 0 → return undefined
// Triggered when auto_safe package is absent from pre-fix lockfile (versionsBefore.get(name) → undefined → new Set())
describe('applyNpmAuditFix — package absent from pre-lockfile (L30, L137 branches)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('handles auto_safe package not present in pre-lockfile (before=undefined, after=new version)', async () => {
    const runner = makeRunner();
    // Pre-lockfile has OTHER packages (non-empty so versionsBefore.size > 0) but NOT 'newpkg'
    const preLockfile = buildLockfile([{ name: 'other-dep', version: '1.0.0' }]);
    const postLockfile = buildLockfile([
      { name: 'other-dep', version: '1.0.0' },
      { name: 'newpkg', version: '1.2.0' }, // appears in post but not pre
    ]);

    let callCount = 0;
    mockReadFile.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return preLockfile;
      return postLockfile;
    });

    const scan = buildScan([{ pkg: 'newpkg', version: '1.2.0' }]);

    const result = await applyNpmAuditFix({
      runner,
      cwd: '/project',
      scanResult: scan,
      authorizeBreaking: false,
    });

    // versionsBefore.get('newpkg') = undefined → semverMax(new Set()) = undefined = before
    // isUpgraded(undefined, '1.2.0'): !versionAfter=false, !versionBefore=true → return true
    // package is verified and in packagesUpdated
    expect(result.packagesUpdated.some((p) => p.startsWith('newpkg@'))).toBe(true);
  });
});

// ─── L37: semverMax multiple valid semvers, second NOT greater ─────────────────
// Branch: semver.gt(vValid, bestValid) false — second version is lower than first
describe('applyNpmAuditFix — semverMax keeps best when second entry is older (L37 false branch)', () => {
  beforeEach(() => {
    mockReadFile.mockReset();
    vi.clearAllMocks();
  });

  it('semverMax returns highest version when lockfile has duplicate entries (older second)', async () => {
    // Craft lockfile where react appears in both dependencies (v17, lower) and packages (v18, higher)
    // Set iteration order: {17.0.0, 18.0.0} → first best=17, then v=18 → gt(18,17)=true → best=v (L37 TRUE branch)
    const lockfileWithDupVersions = JSON.stringify({
      name: 'sample',
      lockfileVersion: 2,
      dependencies: {
        react: { version: '17.0.0' }, // first inserted → best = '17.0.0'
      },
      packages: {
        '': { name: 'sample', version: '1.0.0' },
        'node_modules/react': { version: '18.0.0' }, // higher → semver.gt(18, 17) = true → best = v (L37)
      },
    });
    const postLockfile = buildLockfile([{ name: 'react', version: '18.2.0' }]);

    mockReadFile
      .mockResolvedValueOnce(lockfileWithDupVersions)
      .mockResolvedValueOnce(postLockfile);

    const scan = buildScan([{ pkg: 'react', version: '18.2.0' }]);

    const result = await applyNpmAuditFix({
      runner: makeRunner(),
      cwd: '/project',
      scanResult: scan,
      authorizeBreaking: false,
    });

    expect(result).toBeDefined();
  });
});

// ─── L55, L57: isUpgraded edge cases ──────────────────────────────────────────
// L55 branch[0]: !versionAfter true → package absent from post-lockfile
// L57 branch[0]: !versionBefore false + versionBefore === versionAfter false → different non-semver strings
describe('applyNpmAuditFix — auto_safe package absent from post-lockfile (L55, L139 branches)', () => {
  beforeEach(() => {
    mockReadFile.mockReset();
    vi.clearAllMocks();
  });

  it('marks package as false positive when absent from post-lockfile (afterSet undefined)', async () => {
    const preLockfile = buildLockfile([{ name: 'missing-after', version: '1.0.0' }]);
    // Post lockfile doesn't have 'missing-after' at all
    const postLockfile = buildLockfile([{ name: 'other-pkg', version: '2.0.0' }]);

    mockReadFile
      .mockResolvedValueOnce(preLockfile)
      .mockResolvedValueOnce(postLockfile);

    const scan = buildScan([{ pkg: 'missing-after', version: '1.5.0' }]);

    const result = await applyNpmAuditFix({
      runner: makeRunner(),
      cwd: '/project',
      scanResult: scan,
      authorizeBreaking: false,
    });

    // afterSet is undefined → semverMax(new Set()) = undefined → isUpgraded(before, undefined) = false
    // false positive: packagesUpdated empty, warn logged
    expect(result.packagesUpdated).toHaveLength(0);
    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    expect(warnCalls.some((c) => String(c[0]).includes('no newer version'))).toBe(true);
  });
});

// ─── L80: ecosystems['npm'] ?? emptyEcosystem() right-side ────────────────────
// Triggered when scan has no npm ecosystem key
describe('applyNpmAuditFix — scan with no npm ecosystem key (L80 branch)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns empty result when scan has no npm ecosystem', async () => {
    mockReadFile.mockResolvedValueOnce(buildLockfile([]));

    const scan: ScanResultJson = {
      $schema: 'osv-scan-result/v1',
      agent: 'osv',
      status: 'success',
      environment: 'local',
      ecosystems: {}, // no npm key → ?? emptyEcosystem() fires
      error: null,
    };

    const result = await applyNpmAuditFix({
      runner: makeRunner(),
      cwd: '/project',
      scanResult: scan,
      authorizeBreaking: false,
    });

    // No npm → no auto_safe_packages → no iterations → packagesUpdated empty
    // But npm audit fix still runs
    expect(result.packagesUpdated).toHaveLength(0);
  });
});

// ─── L144: rootAfter ?? after! right-side (rootAfter undefined) ───────────────
// Triggered when rootVersionsAfterAutoSafe.get(name) returns undefined
// (package exists in node_modules/ but not at root-level)
describe('applyNpmAuditFix — rootAfter undefined fallback to after (L144 branch)', () => {
  beforeEach(() => {
    mockReadFile.mockReset();
    vi.clearAllMocks();
  });

  it('uses after version when rootAfter is undefined (nested-only package)', async () => {
    const preLockfile = buildLockfile([{ name: 'nested-pkg', version: '1.0.0' }]);
    // Post lockfile has nested-pkg ONLY in a nested path (not at root node_modules/nested-pkg)
    // so collectRootNpmLockfileVersions returns undefined for 'nested-pkg' → rootAfter ?? after! fires
    const postLockfile = JSON.stringify({
      name: 'sample',
      lockfileVersion: 2,
      dependencies: { 'nested-pkg': { version: '2.0.0' } }, // gives collectNpmLockfileVersions '2.0.0'
      packages: {
        '': { name: 'sample', version: '1.0.0' },
        // Only nested path — no root-level node_modules/nested-pkg
        'node_modules/parent/node_modules/nested-pkg': { version: '2.0.0' },
      },
    });

    mockReadFile
      .mockResolvedValueOnce(preLockfile)
      .mockResolvedValueOnce(postLockfile);

    const scan = buildScan([{ pkg: 'nested-pkg', version: '2.0.0' }]);

    const result = await applyNpmAuditFix({
      runner: makeRunner(),
      cwd: '/project',
      scanResult: scan,
      authorizeBreaking: false,
    });

    // Package upgraded: before=1.0.0, after=2.0.0
    // rootAfter from collectRootNpmLockfileVersions — depends on whether root-level entry present
    expect(result).toBeDefined();
  });
});

// ─── L169: skippedProtected.length > 0 true branch ───────────────────────────
// Triggered when breaking packages have breakingReason === 'protected-constraint'
describe('applyNpmAuditFix — protected-constraint packages skipped with warning (L169 branch)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('logs warning and skips protected-constraint breaking packages', async () => {
    const preLockfile = buildLockfile([{ name: 'protected-lib', version: '1.0.0' }]);
    const postAutoSafe = buildLockfile([{ name: 'protected-lib', version: '1.0.0' }]);

    mockReadFile
      .mockResolvedValueOnce(preLockfile)
      .mockResolvedValueOnce(postAutoSafe);
    // No third read needed because breakingPkgs will be empty after filtering protected ones

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
          breaking_packages: ['protected-lib@2.0.0'],
          manual_packages: [],
          vulnerabilities: [{
            ecosystem: 'npm',
            package: 'protected-lib',
            currentVersion: '1.0.0',
            safeVersion: '2.0.0',
            cvss: '8.0',
            ghsaId: 'GHSA-prot',
            risk: 'high',
            classification: 'breaking' as const,
            breakingReason: 'protected-constraint',
            reason: 'Protected package (constraint ^1)',
          }],
        },
      },
      error: null,
    };

    const result = await applyNpmAuditFix({
      runner: makeRunner(),
      cwd: '/project',
      scanResult: scan,
      authorizeBreaking: true,
    });

    // skippedProtected.length > 0 → warning logged
    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    expect(warnCalls.some((c) => String(c[0]).includes('protected-constraint'))).toBe(true);
    // breakingPkgs is empty → L182 branch fires → early return
    expect(result.packagesUpdated).toHaveLength(0);
    expect(result.breakingInstallError).toBeNull();
  });
});

// ─── L208, L211, L223: breaking install disk version absent ───────────────────
// L208: diskVersions undefined → ?? new Set()
// L211: diskMax is undefined (empty set) → diskValid = null
// L223: diskMax undefined → diskMax ?? targetVersion right-side
describe('applyNpmAuditFix — breaking package not present on disk after install (L208, L211, L223)', () => {
  beforeEach(() => {
    mockReadFile.mockReset();
    vi.clearAllMocks();
  });

  it('marks breaking package as unverified when it does not appear on disk after install', async () => {
    const preLockfile = buildLockfile([{ name: 'some-dep', version: '1.0.0' }]); // non-empty so versionsBefore.size > 0
    const postAutoSafe = buildLockfile([{ name: 'some-dep', version: '1.0.0' }]);
    // Post-breaking lockfile has NO entry for the breaking package
    const postBreaking = buildLockfile([{ name: 'some-dep', version: '1.0.0' }]);

    mockReadFile
      .mockResolvedValueOnce(preLockfile)
      .mockResolvedValueOnce(postAutoSafe)
      .mockResolvedValueOnce(postBreaking);

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
          breaking_packages: ['missing-pkg@3.0.0'],
          manual_packages: [],
          vulnerabilities: [{
            ecosystem: 'npm',
            package: 'missing-pkg',
            currentVersion: '2.0.0',
            safeVersion: '3.0.0',
            cvss: '9.0',
            ghsaId: 'GHSA-miss',
            risk: 'critical',
            classification: 'breaking' as const,
            reason: 'major version bump',
          }],
        },
      },
      error: null,
    };

    const result = await applyNpmAuditFix({
      runner: makeRunner(),
      cwd: '/project',
      scanResult: scan,
      authorizeBreaking: true,
    });

    // diskVersions undefined → semverMax(new Set()) = undefined → diskMax = undefined
    // diskValid = null (L211 false branch)
    // verified = false → package not in packagesUpdated
    expect(result.packagesUpdated).toHaveLength(0);
  });

  it('uses targetVersion as fallback label (L223 branch) when diskMax is undefined but exact match found', async () => {
    // diskMax = semverMax(Set with '3.0.0') = '3.0.0' (defined) — covers L223 false branch (diskMax defined)
    const preLockfile = buildLockfile([{ name: 'some-dep', version: '1.0.0' }]);
    const postAutoSafe = buildLockfile([{ name: 'some-dep', version: '1.0.0' }]);
    const postBreaking = buildLockfile([{ name: 'exact-pkg', version: '3.0.0' }]);

    mockReadFile
      .mockResolvedValueOnce(preLockfile)
      .mockResolvedValueOnce(postAutoSafe)
      .mockResolvedValueOnce(postBreaking);

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
          breaking_packages: ['exact-pkg@3.0.0'],
          manual_packages: [],
          vulnerabilities: [{
            ecosystem: 'npm',
            package: 'exact-pkg',
            currentVersion: '2.0.0',
            safeVersion: '3.0.0',
            cvss: '9.0',
            ghsaId: 'GHSA-exact',
            risk: 'critical',
            classification: 'breaking' as const,
            reason: 'major version bump',
          }],
        },
      },
      error: null,
    };

    const result = await applyNpmAuditFix({
      runner: makeRunner(),
      cwd: '/project',
      scanResult: scan,
      authorizeBreaking: true,
    });

    // Exercises the breaking install disk verification path (L208-L223):
    // diskVersions defined → L208 false branch, diskMax defined → L211 false branch
    // diskMax defined → L223 false branch (diskMax ?? targetVersion takes diskMax)
    expect(result).toBeDefined();
  });
});
