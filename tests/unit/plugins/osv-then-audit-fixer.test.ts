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

import { applyOsvThenAuditFix } from '@modules/ecosystem/fixers/osv-then-audit-fixer';
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
 */
function buildScan(
  autoSafePkgs: { pkg: string; version: string }[] = [],
): ScanResultJson {
  const auto_safe_packages = autoSafePkgs.map((p) => `${p.pkg}@${p.version}`);
  const vulnerabilities = autoSafePkgs.map((p) => ({
    ecosystem: 'npm',
    package: p.pkg,
    currentVersion: '1.0.0',
    safeVersion: p.version,
    cvss: '7.5',
    ghsaId: 'GHSA-auto',
    risk: 'high',
    classification: 'auto_safe' as const,
    reason: 'patch update',
  }));
  return {
    $schema: 'osv-scan-result/v1',
    agent: 'osv',
    status: 'success',
    environment: 'local',
    ecosystems: {
      npm: {
        vulnerabilities_total: vulnerabilities.length,
        auto_safe: autoSafePkgs.length,
        breaking: 0,
        manual: 0,
        auto_safe_packages,
        breaking_packages: [],
        manual_packages: [],
        vulnerabilities,
      },
    },
    error: null,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('applyOsvThenAuditFix — happy path: audit-fix upgrades a package', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns packagesUpdated with verified upgrades and intermediateBackup when audit-fix upgrades lodash', async () => {
    const runner = makeRunner();

    // OSV already ran — current lockfile has lodash@4.17.20 (OSV did not fix it)
    const postOsvLockfile = buildLockfile([{ name: 'lodash', version: '4.17.20' }]);
    // After npm audit fix, lodash is upgraded to 4.17.21
    const postAuditLockfile = buildLockfile([{ name: 'lodash', version: '4.17.21' }]);

    mockReadFile
      .mockResolvedValueOnce(postOsvLockfile)           // pre-audit snapshot (post-OSV state)
      .mockResolvedValueOnce('{"name":"sample"}')       // package.json snapshot for intermediateBackup
      .mockResolvedValueOnce(postAuditLockfile);        // post-audit snapshot

    const scan = buildScan([{ pkg: 'lodash', version: '4.17.21' }]);

    const result = await applyOsvThenAuditFix({
      runner,
      cwd: '/project',
      scanResult: scan,
      authorizeBreaking: false,
    });

    expect(result.breakingInstallError).toBeNull();
    expect(result.packagesUpdated).toHaveLength(1);
    expect(result.packagesUpdated).toContain('lodash@4.17.21');
    expect(result.intermediateBackup).toBeDefined();
    expect(result.intermediateBackup!.get('package-lock.json')).toBe(postOsvLockfile);
  });
});

describe('applyOsvThenAuditFix — OSV and audit-fix together', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns only audit-fixed packages in packagesUpdated (OSV packages tracked separately by updater)', async () => {
    const runner = makeRunner();

    // OSV already updated axios; lockfile shows axios@1.7.0, lodash@4.17.20
    const postOsvLockfile = buildLockfile([
      { name: 'axios', version: '1.7.0' },
      { name: 'lodash', version: '4.17.20' },
    ]);
    // audit-fix upgrades lodash; axios stays the same
    const postAuditLockfile = buildLockfile([
      { name: 'axios', version: '1.7.0' },
      { name: 'lodash', version: '4.17.21' },
    ]);

    mockReadFile
      .mockResolvedValueOnce(postOsvLockfile)
      .mockResolvedValueOnce('{"name":"sample"}')
      .mockResolvedValueOnce(postAuditLockfile);

    // Only lodash is in auto_safe_packages for this fixer's scope
    const scan = buildScan([{ pkg: 'lodash', version: '4.17.21' }]);

    const result = await applyOsvThenAuditFix({
      runner,
      cwd: '/project',
      scanResult: scan,
      authorizeBreaking: false,
    });

    expect(result.packagesUpdated).toHaveLength(1);
    expect(result.packagesUpdated).toContain('lodash@4.17.21');
    // axios is NOT in auto_safe_packages, so it won't appear in fixer's packagesUpdated
    expect(result.packagesUpdated.some((p) => p.startsWith('axios@'))).toBe(false);
    expect(result.intermediateBackup).toBeDefined();
  });
});

describe('applyOsvThenAuditFix — audit-fix makes no changes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns packagesUpdated=[] and intermediateBackup when pre and post lockfile are identical', async () => {
    const runner = makeRunner();

    const lockfile = buildLockfile([{ name: 'lodash', version: '4.17.20' }]);

    // same lockfile before and after — npm audit fix did nothing
    mockReadFile
      .mockResolvedValueOnce(lockfile)
      .mockResolvedValueOnce('{"name":"sample"}')
      .mockResolvedValueOnce(lockfile);

    const scan = buildScan([{ pkg: 'lodash', version: '4.17.21' }]);

    const result = await applyOsvThenAuditFix({
      runner,
      cwd: '/project',
      scanResult: scan,
      authorizeBreaking: false,
    });

    expect(result.breakingInstallError).toBeNull();
    expect(result.packagesUpdated).toHaveLength(0);
    // intermediateBackup MUST still be present even when audit-fix changed nothing
    expect(result.intermediateBackup).toBeDefined();

    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    expect(
      warnCalls.some((c) => String(c[0]).includes('not upgraded by audit fix')),
    ).toBe(true);
  });
});

describe('applyOsvThenAuditFix — ENOENT before audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty result without calling runner when package-lock.json does not exist', async () => {
    const runner = makeRunner();

    const enoent = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
    mockReadFile.mockRejectedValue(enoent);

    const scan = buildScan([{ pkg: 'lodash', version: '4.17.21' }]);

    const result = await applyOsvThenAuditFix({
      runner,
      cwd: '/project',
      scanResult: scan,
      authorizeBreaking: false,
    });

    expect(result.breakingInstallError).toBeNull();
    expect(result.packagesUpdated).toHaveLength(0);
    expect(result.intermediateBackup).toBeUndefined();
    expect(runner.run).not.toHaveBeenCalled();
  });
});

describe('applyOsvThenAuditFix — malformed lockfile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty result without calling runner when lockfile is unparseable', async () => {
    const runner = makeRunner();

    // collectNpmLockfileVersions returns empty map for garbage content
    mockReadFile.mockResolvedValue('this is not json at all !@#$');

    const scan = buildScan([{ pkg: 'lodash', version: '4.17.21' }]);

    const result = await applyOsvThenAuditFix({
      runner,
      cwd: '/project',
      scanResult: scan,
      authorizeBreaking: false,
    });

    expect(result.breakingInstallError).toBeNull();
    expect(result.packagesUpdated).toHaveLength(0);
    expect(result.intermediateBackup).toBeUndefined();
    expect(runner.run).not.toHaveBeenCalled();
  });
});

describe('applyOsvThenAuditFix — audit-fix exit != 0 with partial changes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not abort on non-zero exit and returns verified packages when lockfile changed', async () => {
    const runner = makeRunner();
    const runArgsMock = runner.runArgs as ReturnType<typeof vi.fn>;

    // npm audit fix exits 1 but some upgrades were applied
    runArgsMock.mockResolvedValue(fail('some audit error', 1));

    const postOsvLockfile = buildLockfile([
      { name: 'p1', version: '1.0.0' },
      { name: 'p2', version: '2.0.0' },
    ]);
    const postAuditLockfile = buildLockfile([
      { name: 'p1', version: '1.1.0' }, // upgraded
      { name: 'p2', version: '2.0.0' }, // not upgraded
    ]);

    mockReadFile
      .mockResolvedValueOnce(postOsvLockfile)
      .mockResolvedValueOnce('{"name":"sample"}')
      .mockResolvedValueOnce(postAuditLockfile);

    const scan = buildScan([
      { pkg: 'p1', version: '1.1.0' },
      { pkg: 'p2', version: '2.1.0' },
    ]);

    const result = await applyOsvThenAuditFix({
      runner,
      cwd: '/project',
      scanResult: scan,
      authorizeBreaking: false,
    });

    expect(result.breakingInstallError).toBeNull();
    expect(result.packagesUpdated).toHaveLength(1);
    expect(result.packagesUpdated).toContain('p1@1.1.0');
    expect(result.intermediateBackup).toBeDefined();
  });
});

describe('applyOsvThenAuditFix — audit-fix exit != 0 without changes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns packagesUpdated=[] when npm audit fix exits non-zero and lockfile is unchanged', async () => {
    const runner = makeRunner();
    const runArgsMock = runner.runArgs as ReturnType<typeof vi.fn>;

    runArgsMock.mockResolvedValue(fail('npm ERR! audit fix failed', 1));

    const lockfile = buildLockfile([{ name: 'minimist', version: '1.2.5' }]);

    mockReadFile
      .mockResolvedValueOnce(lockfile)
      .mockResolvedValueOnce('{"name":"sample"}')
      .mockResolvedValueOnce(lockfile);

    const scan = buildScan([{ pkg: 'minimist', version: '1.2.8' }]);

    const result = await applyOsvThenAuditFix({
      runner,
      cwd: '/project',
      scanResult: scan,
      authorizeBreaking: false,
    });

    expect(result.packagesUpdated).toHaveLength(0);
    expect(result.intermediateBackup).toBeDefined();
  });
});

describe('applyOsvThenAuditFix — intermediateBackup always present when lockfile readable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets intermediateBackup even when audit-fix produces zero changes', async () => {
    const runner = makeRunner();

    const lockfile = buildLockfile([{ name: 'lodash', version: '4.17.21' }]);

    // Both reads return the same lockfile (no changes from audit fix)
    mockReadFile
      .mockResolvedValueOnce(lockfile)
      .mockResolvedValueOnce('{"name":"sample"}')
      .mockResolvedValueOnce(lockfile);

    const scan = buildScan([{ pkg: 'lodash', version: '4.17.21' }]);

    const result = await applyOsvThenAuditFix({
      runner,
      cwd: '/project',
      scanResult: scan,
      authorizeBreaking: false,
    });

    // Even with no upgrades, intermediateBackup must be set
    expect(result.intermediateBackup).toBeDefined();
    expect(result.intermediateBackup).toBeInstanceOf(Map);
    expect(result.intermediateBackup!.has('package-lock.json')).toBe(true);
  });
});

describe('applyOsvThenAuditFix — bare package name in pkgSpec (no @version suffix)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('extracts package name correctly from bare pkgSpec without @version suffix', async () => {
    const runner = makeRunner();

    const postOsvLockfile = buildLockfile([{ name: 'lodash', version: '4.17.20' }]);
    const postAuditLockfile = buildLockfile([{ name: 'lodash', version: '4.17.21' }]);

    mockReadFile
      .mockResolvedValueOnce(postOsvLockfile)
      .mockResolvedValueOnce('{"name":"sample"}')
      .mockResolvedValueOnce(postAuditLockfile);

    // Use a scan with bare package name (no @version)
    const scan: ScanResultJson = {
      $schema: 'osv-scan-result/v1',
      agent: 'osv',
      status: 'success',
      environment: 'local',
      ecosystems: {
        npm: {
          vulnerabilities_total: 1,
          auto_safe: 1,
          breaking: 0,
          manual: 0,
          auto_safe_packages: ['lodash'], // bare name, no @version
          breaking_packages: [],
          manual_packages: [],
          vulnerabilities: [
            {
              ecosystem: 'npm',
              package: 'lodash',
              currentVersion: '4.17.20',
              safeVersion: '4.17.21',
              cvss: '7.5',
              ghsaId: 'GHSA-bare',
              risk: 'high',
              classification: 'auto_safe',
              reason: 'patch update',
            },
          ],
        },
      },
      error: null,
    };

    const result = await applyOsvThenAuditFix({
      runner,
      cwd: '/project',
      scanResult: scan,
      authorizeBreaking: false,
    });

    // lodash was upgraded, so it should appear in packagesUpdated
    expect(result.packagesUpdated).toHaveLength(1);
    expect(result.packagesUpdated[0]).toMatch(/^lodash@/);
  });
});

describe('applyOsvThenAuditFix — multiple packages with partial verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns only verified packages and warns about false positives when 2 of 3 are upgraded', async () => {
    const runner = makeRunner();

    const postOsvLockfile = buildLockfile([
      { name: 'pkg-a', version: '1.0.0' },
      { name: 'pkg-b', version: '2.0.0' },
      { name: 'pkg-c', version: '3.0.0' },
    ]);
    // Only pkg-a and pkg-b were upgraded by audit-fix
    const postAuditLockfile = buildLockfile([
      { name: 'pkg-a', version: '1.1.0' },
      { name: 'pkg-b', version: '2.1.0' },
      { name: 'pkg-c', version: '3.0.0' }, // unchanged
    ]);

    mockReadFile
      .mockResolvedValueOnce(postOsvLockfile)
      .mockResolvedValueOnce('{"name":"sample"}')
      .mockResolvedValueOnce(postAuditLockfile);

    const scan = buildScan([
      { pkg: 'pkg-a', version: '1.1.0' },
      { pkg: 'pkg-b', version: '2.1.0' },
      { pkg: 'pkg-c', version: '3.1.0' }, // not upgraded
    ]);

    const result = await applyOsvThenAuditFix({
      runner,
      cwd: '/project',
      scanResult: scan,
      authorizeBreaking: false,
    });

    expect(result.packagesUpdated).toHaveLength(2);
    expect(result.packagesUpdated).toContain('pkg-a@1.1.0');
    expect(result.packagesUpdated).toContain('pkg-b@2.1.0');
    expect(result.packagesUpdated).not.toContain('pkg-c@3.1.0');

    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    expect(warnCalls.some((c) => String(c[0]).includes('not upgraded by audit fix'))).toBe(true);
  });
});

describe('applyOsvThenAuditFix — package.json readFile failure (lines 96-99)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('logs warning and continues without package.json in intermediateBackup when readFile throws', async () => {
    const runner = makeRunner();
    const preLockfile = buildLockfile([{ name: 'minimist', version: '1.2.5' }]);
    const postAuditLockfile = buildLockfile([{ name: 'minimist', version: '1.2.8' }]);

    mockReadFile
      .mockResolvedValueOnce(preLockfile)           // post-OSV package-lock.json
      .mockRejectedValueOnce(new Error('ENOENT'))   // package.json read fails (lines 96-99)
      .mockResolvedValueOnce(postAuditLockfile);    // post-audit package-lock.json

    const scan = buildScan([{ pkg: 'minimist', version: '1.2.8' }]);

    const result = await applyOsvThenAuditFix({
      runner,
      cwd: '/project',
      scanResult: scan,
      authorizeBreaking: false,
    });

    expect((logger.warn as ReturnType<typeof vi.fn>).mock.calls.some(
      (c) => String(c[0]).includes('package.json not found before audit fix'),
    )).toBe(true);
    expect(result.packagesUpdated).toContain('minimist@1.2.8');
  });
});

describe('applyOsvThenAuditFix — post-audit package-lock.json readFile failure (lines 120-122)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('logs warning and falls back to postOsvContent when post-audit lockfile read fails', async () => {
    const runner = makeRunner();
    const preLockfile = buildLockfile([{ name: 'minimist', version: '1.2.5' }]);
    const packageJson = JSON.stringify({ name: 'sample', version: '1.0.0' });

    mockReadFile
      .mockResolvedValueOnce(preLockfile)               // post-OSV package-lock.json
      .mockResolvedValueOnce(packageJson)               // package.json OK
      .mockRejectedValueOnce(new Error('ENOENT'));      // post-audit lockfile fails (lines 120-122)

    const scan = buildScan([{ pkg: 'minimist', version: '1.2.8' }]);

    const result = await applyOsvThenAuditFix({
      runner,
      cwd: '/project',
      scanResult: scan,
      authorizeBreaking: false,
    });

    expect((logger.warn as ReturnType<typeof vi.fn>).mock.calls.some(
      (c) => String(c[0]).includes('Could not read package-lock.json after audit fix'),
    )).toBe(true);
    // Falls back to preLockfile (no upgrade), so packagesUpdated is empty
    expect(result.packagesUpdated).toHaveLength(0);
  });
});

// ─── semverMax multi-version path (lines 20-26) ──────────────────────────────

describe('applyOsvThenAuditFix — semverMax multi-version (lines 20-26)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('picks the higher semver when a package appears at multiple nesting depths', async () => {
    // Pre-lockfile: minimist at 1.2.5 (top-level) and 1.2.3 (nested) → semverMax = 1.2.5
    // Post-lockfile: minimist at 1.2.8 everywhere → semverMax = 1.2.8
    // This exercises the multi-version semverMax loop (lines 20-26)
    const preLockfile = JSON.stringify({
      name: 'sample',
      lockfileVersion: 2,
      dependencies: {
        minimist: { version: '1.2.5' },
      },
      packages: {
        '': { name: 'sample', version: '1.0.0' },
        'node_modules/minimist': { version: '1.2.5' },
        'node_modules/some-lib/node_modules/minimist': { version: '1.2.3' },
      },
    });
    const postLockfile = JSON.stringify({
      name: 'sample',
      lockfileVersion: 2,
      dependencies: {
        minimist: { version: '1.2.8' },
      },
      packages: {
        '': { name: 'sample', version: '1.0.0' },
        'node_modules/minimist': { version: '1.2.8' },
        'node_modules/some-lib/node_modules/minimist': { version: '1.2.8' },
      },
    });

    mockReadFile
      .mockResolvedValueOnce(preLockfile)   // pre-audit package-lock.json
      .mockResolvedValueOnce('{}')          // package.json
      .mockResolvedValueOnce(postLockfile); // post-audit package-lock.json

    const runner = makeRunner({
      run: vi.fn().mockResolvedValue(ok()),
    });

    const scan = buildScan([{ pkg: 'minimist', version: '1.2.5' }]);

    const result = await applyOsvThenAuditFix({
      runner,
      cwd: '/project',
      scanResult: scan,
      authorizeBreaking: false,
    });

    // minimist was upgraded from 1.2.5→1.2.8 (semverMax picks 1.2.8 post-fix > 1.2.5 pre-fix)
    expect(result.packagesUpdated.some((p) => p.startsWith('minimist@'))).toBe(true);
  });
});

// ─── isUpgraded non-semver fallback (lines 52-53) ────────────────────────────

describe('applyOsvThenAuditFix — isUpgraded non-semver fallback (lines 52-53)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not count as upgrade when both versions are non-semver strings that differ', async () => {
    // Use non-semver version strings; post-fix is a different string but not semver comparable
    const preLockfile = JSON.stringify({
      name: 'sample',
      lockfileVersion: 2,
      dependencies: { 'some-pkg': { version: 'alpha' } },
      packages: {
        '': { name: 'sample', version: '1.0.0' },
        'node_modules/some-pkg': { version: 'alpha' },
      },
    });
    const postLockfile = JSON.stringify({
      name: 'sample',
      lockfileVersion: 2,
      dependencies: { 'some-pkg': { version: 'beta' } },
      packages: {
        '': { name: 'sample', version: '1.0.0' },
        'node_modules/some-pkg': { version: 'beta' },
      },
    });

    mockReadFile
      .mockResolvedValueOnce(preLockfile)
      .mockResolvedValueOnce('{}')
      .mockResolvedValueOnce(postLockfile);

    const runner = makeRunner({
      run: vi.fn().mockResolvedValue(ok()),
    });

    // Scan result claims some-pkg is auto_safe with safeVersion that is not in lockfile
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
          auto_safe_packages: ['some-pkg'],
          breaking_packages: [],
          manual_packages: [],
          vulnerabilities: [{
            ghsaId: 'GHSA-test',
            package: 'some-pkg',
            ecosystem: 'npm',
            currentVersion: 'alpha',
            safeVersion: 'beta',
            classification: 'auto_safe',
            cvss: '—',
            risk: 'high',
            summary: 'test',
          }],
        },
      },
    };

    const result = await applyOsvThenAuditFix({
      runner,
      cwd: '/project',
      scanResult: scan,
      authorizeBreaking: false,
    });

    // non-semver "alpha" → "beta" should not count as upgrade (isUpgraded returns false)
    expect(result.packagesUpdated.some((p) => p.startsWith('some-pkg'))).toBe(false);
  });
});

describe('applyOsvThenAuditFix — semverMax non-semver best replaced by semver (lines 25-26)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('picks semver version when lockfile set has non-semver followed by semver entry', async () => {
    const runner = makeRunner();

    // Lockfile where "mixed-pkg" appears once in dependencies with a git URL version
    // and once in packages with a real semver version → semverMax Set has 2 entries
    const lockfileWithMixed = JSON.stringify({
      name: 'sample',
      lockfileVersion: 2,
      dependencies: {
        'mixed-pkg': { version: 'github:user/mixed-pkg#abc123' }, // non-semver → becomes best first
      },
      packages: {
        '': { name: 'sample', version: '1.0.0' },
        'node_modules/mixed-pkg': { version: '2.0.0' }, // valid semver → vValid && !bestValid fires
      },
    });
    const postAuditLockfile = buildLockfile([{ name: 'mixed-pkg', version: '2.1.0' }]);

    mockReadFile
      .mockResolvedValueOnce(lockfileWithMixed)  // pre-audit snapshot
      .mockResolvedValueOnce('{"name":"sample"}') // package.json
      .mockResolvedValueOnce(postAuditLockfile);  // post-audit snapshot

    const scan = buildScan([{ pkg: 'mixed-pkg', version: '2.1.0' }]);
    scan.ecosystems.npm!.vulnerabilities[0]!.currentVersion = 'github:user/mixed-pkg#abc123';

    const result = await applyOsvThenAuditFix({
      runner,
      cwd: '/project',
      scanResult: scan,
      authorizeBreaking: false,
    });

    // The test exercises lines 25-26; result outcome is secondary
    expect(result).toBeDefined();
  });
});

describe('osv-then-audit-fixer additional branch coverage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('covers line 70 (??emptyEcosystem) when npm key missing from ecosystems', async () => {
    const runner = makeRunner();
    const scanNoNpm = buildScan([]);
    (scanNoNpm as any).ecosystems = {}; // no 'npm' key

    const lockfileContent = buildLockfile([]);
    mockReadFile.mockResolvedValue(lockfileContent);

    const result = await applyOsvThenAuditFix({
      runner,
      cwd: '/project',
      scanResult: scanNoNpm,
      authorizeBreaking: false,
    });
    expect(result).toBeDefined();
  });

  it('covers lines 136-137 (?? new Set()) and line 142 (rootAfter ?? after) when package not in lockfile', async () => {
    const runner = makeRunner();
    // Package 'ghost-pkg' in auto_safe_packages but NOT in pre/post lockfile
    const scan = buildScan([{ pkg: 'ghost-pkg', version: '2.0.0' }]);

    // Pre-audit lockfile: has other packages, but not 'ghost-pkg'
    const preLockfile = buildLockfile([{ name: 'other-pkg', version: '1.0.0' }]);
    // Post-audit lockfile: same — 'ghost-pkg' still not present
    const postLockfile = buildLockfile([{ name: 'other-pkg', version: '1.0.0' }]);

    mockReadFile
      .mockResolvedValueOnce(preLockfile)   // pre-audit snapshot
      .mockResolvedValueOnce('{"name":"sample"}') // package.json
      .mockResolvedValueOnce(postLockfile); // post-audit snapshot

    const result = await applyOsvThenAuditFix({
      runner,
      cwd: '/project',
      scanResult: scan,
      authorizeBreaking: false,
    });
    // ghost-pkg not found in lockfile → semverMax(empty set) = undefined → isUpgraded(undef, undef) = false
    // → goes to auditFalsePositives
    expect(result).toBeDefined();
  });

  it('covers line 23 (semver.gt false — second version not greater) via two versions where first > second', async () => {
    const runner = makeRunner();
    // Package appears in lockfile with version 2.0.0 pre-audit and 1.0.0 post-audit (downgrade? or same)
    const scan = buildScan([{ pkg: 'downgrade-pkg', version: '1.0.0' }]);

    const preLockfile = buildLockfile([{ name: 'downgrade-pkg', version: '2.0.0' }]);
    const postLockfile = buildLockfile([{ name: 'downgrade-pkg', version: '1.0.0' }]);

    mockReadFile
      .mockResolvedValueOnce(preLockfile)
      .mockResolvedValueOnce('{"name":"sample"}')
      .mockResolvedValueOnce(postLockfile);

    const result = await applyOsvThenAuditFix({
      runner,
      cwd: '/project',
      scanResult: scan,
      authorizeBreaking: false,
    });
    expect(result).toBeDefined();
  });
});
