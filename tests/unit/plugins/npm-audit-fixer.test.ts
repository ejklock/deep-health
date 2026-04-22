import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module-level mocks ────────────────────────────────────────────────────────

vi.mock('@infra/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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
    const runMock = runner.run as ReturnType<typeof vi.fn>;

    // npm audit fix succeeds (upgrades lodash), npm install fails (nothing upgrades)
    runMock
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
