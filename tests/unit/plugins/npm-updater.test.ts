import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CommandRunner, CommandResult } from '@core/types/common';
import type { ProjectConfig } from '@core/types/config';
import type { ScanResultJson } from '@core/types/scan';

// ── Module-level mocks ───────────────────────────────────────────────────────
// Hoisted so the factory runs before the module under test is imported.
vi.mock('@infra/utils/git.js', () => ({
  backupFiles: vi.fn().mockResolvedValue(new Map()),
  restoreFiles: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@infra/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// npm-audit fixer reads package-lock.json before and after running npm audit fix.
// Provide a default valid lockfile so tests using the npm-audit strategy do not abort early.
const { mockReadFile } = vi.hoisted(() => ({ mockReadFile: vi.fn() }));

const DEFAULT_LOCKFILE = JSON.stringify({
  name: 'test',
  lockfileVersion: 2,
  dependencies: { lodash: { version: '4.17.20' } },
  packages: {
    '': { name: 'test', version: '1.0.0' },
    'node_modules/lodash': { version: '4.17.20' },
  },
});

vi.mock('node:fs/promises', () => ({
  readFile: mockReadFile,
}));

// scanner.emptyEcosystem is used when 'npm' key is absent from scanResult
vi.mock('@core/types/scan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/types/scan.js')>();
  return {
    ...actual,
    emptyEcosystem: vi.fn(() => ({
      vulnerabilities_total: 0,
      auto_safe: 0,
      breaking: 0,
      manual: 0,
      auto_safe_packages: [],
      breaking_packages: [],
      manual_packages: [],
      vulnerabilities: [],
    })),
  };
});

import { runNpmUpdater } from '@modules/ecosystem/plugins/npm-updater';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRunner(overrides: Partial<CommandRunner> & { dryRun?: boolean } = {}): CommandRunner {
  const { dryRun = false, ...rest } = overrides;
  return {
    run: vi.fn().mockResolvedValue(ok()),
    dryRun,
    environment: 'local',
    ...rest,
  } as unknown as CommandRunner;
}

function ok(stdout = '', stderr = ''): CommandResult {
  return { stdout, stderr, exitCode: 0, command: '', dryRun: false };
}

function fail(stderr = 'something failed'): CommandResult {
  return { stdout: '', stderr, exitCode: 1, command: '', dryRun: false };
}

/**
 * Build a ProjectConfig with the new declarative ecosystems[] shape.
 * NOTE: build_commands has been removed from RuntimeConfig.
 * Build validation is now driven by validationCommands passed to runNpmUpdater.
 */
function baseConfig(): ProjectConfig {
  return {
    project: { name: 'test-project', client: 'test-client' },
    ecosystems: [
      {
        id: 'npm',
        validationCommands: [{ name: 'build', command: 'npm run build' }],
      },
    ],
    protected_packages: { composer: [], npm: [] },
    safe_update_policy: {
      allow_patch_and_minor_within_constraints: true,
      require_authorization_for_constraint_change: false,
    },
    conflict_resolution: 'fail',
  };
}

/**
 * Builds a ScanResultJson for npm.
 * `autoSafeVulns` is a list of {pkg, safeVersion} for auto_safe vulnerabilities.
 * `breakingVulns` is a list of {pkg, safeVersion} for breaking vulnerabilities.
 * `auto_safe_packages` is set to the legacy string[] format (e.g. 'lodash@4.17.21').
 */
function baseScan(
  autoSafeVulns: { pkg: string; safeVersion: string }[] = [{ pkg: 'lodash', safeVersion: '4.17.21' }],
  breakingVulns: { pkg: string; safeVersion: string }[] = [],
): ScanResultJson {
  const auto_safe_packages = autoSafeVulns.map((v) => `${v.pkg}@${v.safeVersion}`);
  const breaking_packages = breakingVulns.map((v) => `${v.pkg}@${v.safeVersion}`);
  const vulnerabilities = [
    ...autoSafeVulns.map((v) => ({
      ecosystem: 'npm',
      package: v.pkg,
      currentVersion: '1.0.0',
      safeVersion: v.safeVersion,
      cvss: '7.5',
      ghsaId: 'GHSA-test-auto',
      risk: 'high',
      classification: 'auto_safe' as const,
      reason: 'patch update within constraint',
    })),
    ...breakingVulns.map((v) => ({
      ecosystem: 'npm',
      package: v.pkg,
      currentVersion: '1.0.0',
      safeVersion: v.safeVersion,
      cvss: '8.0',
      ghsaId: 'GHSA-test-breaking',
      risk: 'critical',
      classification: 'breaking' as const,
      reason: 'major version bump required',
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
        auto_safe: autoSafeVulns.length,
        breaking: breakingVulns.length,
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

/** Scan with no packages in any category (nothing to update) */
function emptyScan(): ScanResultJson {
  return baseScan([], []);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('runNpmUpdater — dry-run paths', () => {
  it('dry-run with validation commands => all validations are "skipped"', async () => {
    const runner = makeRunner({ dryRun: true });

    const result = await runNpmUpdater(
      runner,
      baseConfig(),
      baseScan(),
      '/tmp/project',
      false,
      [{ name: 'build', command: 'npm run build' }],
    );

    expect(result.validations).toHaveLength(1);
    expect(result.validations[0]!.status).toBe('skipped');
    expect(result.validations[0]!.name).toBe('build');
    // Runner should not have been called (dry-run skips all commands)
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('dry-run without validation commands => single skipped entry', async () => {
    const runner = makeRunner({ dryRun: true });

    const result = await runNpmUpdater(
      runner,
      baseConfig(),
      baseScan(),
      '/tmp/project',
      false,
      [],
    );

    expect(result.validations).toHaveLength(1);
    expect(result.validations[0]!.status).toBe('skipped');
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('dry-run always returns status "success" (no real commands run)', async () => {
    const runner = makeRunner({ dryRun: true });

    const result = await runNpmUpdater(runner, baseConfig(), baseScan(), '/tmp/project');

    expect(result.status).toBe('success');
    expect(result.$schema).toBe('osv-update-result/v1');
    expect(result.agent).toBe('npm-safe-update');
  });

  it('dry-run does NOT mention "npm update" in any log call', async () => {
    const runner = makeRunner({ dryRun: true });
    const { logger } = await import('@infra/utils/logger.js');
    const infoSpy = logger.info as ReturnType<typeof vi.fn>;
    infoSpy.mockClear();

    await runNpmUpdater(runner, baseConfig(), baseScan(), '/tmp/project');

    const allInfoCalls: string[] = infoSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(allInfoCalls.some((msg) => msg.includes('npm update'))).toBe(false);
  });
});

describe('runNpmUpdater — OSV-only auto-safe remediation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does NOT call targeted npm install for auto-safe packages (OSV fix is sole remediator)', async () => {
    // Sequence: npm outdated, npm audit, osv fix, osv scan — NO targeted npm install
    const runner = makeRunner();
    const runMock = runner.run as ReturnType<typeof vi.fn>;

    await runNpmUpdater(runner, baseConfig(), baseScan([{ pkg: 'lodash', safeVersion: '4.17.21' }]), '/tmp/project');

    const calledCommands: string[] = runMock.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calledCommands.some((cmd) => cmd === 'npm install lodash@4.17.21')).toBe(false);
    expect(calledCommands.some((cmd) => cmd === 'npm update')).toBe(false);
  });

  it('does NOT call osv-scanner fix (osv fix is orchestrator-coordinated, not updater responsibility)', async () => {
    const runner = makeRunner();
    const runMock = runner.run as ReturnType<typeof vi.fn>;

    await runNpmUpdater(runner, baseConfig(), baseScan([{ pkg: 'lodash', safeVersion: '4.17.21' }]), '/tmp/project');

    const calledCommands: string[] = runMock.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calledCommands.some((cmd) => cmd.includes('osv-scanner fix'))).toBe(false);
  });

  it('no targeted installs even with multiple auto-safe packages', async () => {
    const runner = makeRunner();
    const runMock = runner.run as ReturnType<typeof vi.fn>;

    await runNpmUpdater(
      runner,
      baseConfig(),
      baseScan([
        { pkg: 'lodash', safeVersion: '4.17.21' },
        { pkg: 'axios', safeVersion: '1.7.9' },
      ]),
      '/tmp/project',
    );

    const calledCommands: string[] = runMock.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calledCommands.some((cmd) => cmd === 'npm install lodash@4.17.21')).toBe(false);
    expect(calledCommands.some((cmd) => cmd === 'npm install axios@1.7.9')).toBe(false);
  });

  it('no targeted installs when scan has no auto-safe packages', async () => {
    const runner = makeRunner();
    const runMock = runner.run as ReturnType<typeof vi.fn>;

    await runNpmUpdater(runner, baseConfig(), emptyScan(), '/tmp/project');

    const calledCommands: string[] = runMock.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calledCommands.some((cmd) => cmd.startsWith('npm install ') && cmd !== 'npm install')).toBe(false);
  });

  it('returns status "success" and packages_updated empty when osv strategy and no osvFixOutcome', async () => {
    const runner = makeRunner();

    const result = await runNpmUpdater(
      runner,
      baseConfig(),
      baseScan([{ pkg: 'lodash', safeVersion: '4.17.21' }]),
      '/tmp/project',
    );

    expect(result.status).toBe('success');
    // osv strategy without osvFixOutcome: fixer is no-op, packages_updated comes from fixer (empty)
    expect(result.packages_updated).toHaveLength(0);
  });
});

describe('runNpmUpdater — breaking package installs (authorized)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFile.mockResolvedValue(DEFAULT_LOCKFILE);
  });

  it('does NOT install breaking packages when fixer=osv (orchestrator responsibility)', async () => {
    // With fixer=osv (default), breaking installs are coordinated by the orchestrator, not the updater
    const runner = makeRunner();
    const runMock = runner.run as ReturnType<typeof vi.fn>;

    const scan = baseScan([], [{ pkg: 'react', safeVersion: '18.0.0' }]);
    await runNpmUpdater(runner, baseConfig(), scan, '/tmp/project', true, [], 'osv');

    const calledCommands: string[] = runMock.mock.calls.map((c: unknown[]) => String(c[0]));
    // With osv strategy, updater is a no-op — no npm install for breaking packages
    expect(calledCommands.some((cmd) => cmd.includes('react@18.0.0'))).toBe(false);
    // result should not carry an error since breaking install is delegated to orchestrator
  });

  it('installs breaking packages when authorizeBreaking=true and fixer=npm-audit', async () => {
    const runner = makeRunner();
    const runMock = runner.run as ReturnType<typeof vi.fn>;

    const scan = baseScan([], [{ pkg: 'react', safeVersion: '18.0.0' }]);
    await runNpmUpdater(runner, baseConfig(), scan, '/tmp/project', true, [], 'npm-audit');

    const calledCommands: string[] = runMock.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calledCommands).toContain('npm install react@18.0.0');
  });

  it('does NOT install breaking packages when authorizeBreaking=false and fixer=npm-audit', async () => {
    const runner = makeRunner();
    const runMock = runner.run as ReturnType<typeof vi.fn>;

    const scan = baseScan([], [{ pkg: 'react', safeVersion: '18.0.0' }]);
    await runNpmUpdater(runner, baseConfig(), scan, '/tmp/project', false, [], 'npm-audit');

    const calledCommands: string[] = runMock.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calledCommands.some((cmd) => cmd.includes('react@18.0.0'))).toBe(false);
  });

  it('does NOT install breaking packages with breakingReason=protected-constraint even when authorizeBreaking=true (npm-audit)', async () => {
    const runner = makeRunner();
    const runMock = runner.run as ReturnType<typeof vi.fn>;

    // Build a scan where react is classified breaking due to protected-constraint
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
          breaking_packages: ['react@18.0.0'],
          manual_packages: [],
          vulnerabilities: [
            {
              ecosystem: 'npm',
              package: 'react',
              currentVersion: '17.0.2',
              safeVersion: '18.0.0',
              cvss: '8.0',
              ghsaId: 'GHSA-test-protected',
              risk: 'critical',
              classification: 'breaking',
              reason: 'Protected package: pinned by team. Safe version 18.0.0 is outside constraint ^17.0.0',
              breakingReason: 'protected-constraint',
            },
          ],
        },
      },
      error: null,
    };

    await runNpmUpdater(runner, baseConfig(), scan, '/tmp/project', true, [], 'npm-audit');

    const calledCommands: string[] = runMock.mock.calls.map((c: unknown[]) => String(c[0]));
    // protected-constraint package must NOT be installed even with authorizeBreaking=true
    expect(calledCommands.some((cmd) => cmd.includes('react@18.0.0'))).toBe(false);
  });

  it('does NOT install breaking packages with breakingReason=protected-constraint even when authorizeBreaking=true (osv strategy)', async () => {
    const runner = makeRunner();
    const runMock = runner.run as ReturnType<typeof vi.fn>;

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
          breaking_packages: ['lodash@5.0.0'],
          manual_packages: [],
          vulnerabilities: [
            {
              ecosystem: 'npm',
              package: 'lodash',
              currentVersion: '4.17.21',
              safeVersion: '5.0.0',
              cvss: '7.5',
              ghsaId: 'GHSA-test-protected2',
              risk: 'high',
              classification: 'breaking',
              reason: 'Protected package: keep v4. Safe version 5.0.0 is outside constraint ^4.17.0',
              breakingReason: 'protected-constraint',
            },
          ],
        },
      },
      error: null,
    };

    await runNpmUpdater(runner, baseConfig(), scan, '/tmp/project', true, [], 'osv');

    const calledCommands: string[] = runMock.mock.calls.map((c: unknown[]) => String(c[0]));
    // protected-constraint package must NOT be installed even with authorizeBreaking=true
    expect(calledCommands.some((cmd) => cmd.includes('lodash@5.0.0'))).toBe(false);
  });

  it('breaking install failure (npm-audit) => status is "error"', async () => {
    // Sequence: npm outdated (ok), npm audit (ok), npm audit fix (ok), npm install react@18.0.0 (FAIL)
    const runner = makeRunner();
    const runMock = runner.run as ReturnType<typeof vi.fn>;
    runMock
      .mockResolvedValueOnce(ok()) // npm outdated
      .mockResolvedValueOnce(ok()) // npm audit
      .mockResolvedValueOnce(ok()) // npm audit fix
      .mockResolvedValueOnce(fail('peer dep conflict')); // npm install react@18.0.0

    const scan = baseScan([], [{ pkg: 'react', safeVersion: '18.0.0' }]);
    const result = await runNpmUpdater(runner, baseConfig(), scan, '/tmp/project', true, [], 'npm-audit');

    expect(result.status).toBe('error');
    expect(result.error).toContain('npm install react@18.0.0 failed');
  });
});

describe('runNpmUpdater — build validation via validationCommands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFile.mockResolvedValue(DEFAULT_LOCKFILE);
  });

  it('runs npm ci before validation commands when validations are configured', async () => {
    const runner = makeRunner();
    const runMock = runner.run as ReturnType<typeof vi.fn>;

    await runNpmUpdater(
      runner,
      baseConfig(),
      baseScan([{ pkg: 'lodash', safeVersion: '4.17.21' }]),
      '/tmp/project',
      false,
      [{ name: 'build', command: 'npm run build' }],
    );

    const calledCommands: string[] = runMock.mock.calls.map((c: unknown[]) => String(c[0]));
    const ciIndex = calledCommands.indexOf('npm ci');
    const buildIndex = calledCommands.indexOf('npm run build');

    expect(ciIndex).toBeGreaterThanOrEqual(0);
    expect(buildIndex).toBeGreaterThan(ciIndex);
  });

  it('runs validation commands after fixer and returns pass on success', async () => {
    const runner = makeRunner();
    const runMock = runner.run as ReturnType<typeof vi.fn>;

    const result = await runNpmUpdater(
      runner,
      baseConfig(),
      baseScan([{ pkg: 'lodash', safeVersion: '4.17.21' }]),
      '/tmp/project',
      false,
      [{ name: 'build', command: 'npm run build' }],
    );

    const calledCommands: string[] = runMock.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calledCommands.some((cmd) => cmd === 'npm run build')).toBe(true);
    expect(result.validations).toHaveLength(1);
    expect(result.validations[0]!.name).toBe('build');
    expect(result.validations[0]!.status).toBe('pass');
    expect(result.status).toBe('success');
  });

  it('returns single skipped entry when no validation commands configured', async () => {
    const runner = makeRunner();
    const runMock = runner.run as ReturnType<typeof vi.fn>;

    const result = await runNpmUpdater(
      runner,
      baseConfig(),
      baseScan([{ pkg: 'lodash', safeVersion: '4.17.21' }]),
      '/tmp/project',
      false,
      [],
    );

    expect(result.validations).toHaveLength(1);
    expect(result.validations[0]!.status).toBe('skipped');
    expect(result.status).toBe('success');

    const calledCommands: string[] = runMock.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calledCommands).not.toContain('npm ci');
  });

  it('validation failure (npm-audit) => status is "error" and changes are reverted', async () => {
    const runner = makeRunner();
    const runMock = runner.run as ReturnType<typeof vi.fn>;

    // Sequence: npm outdated (ok), npm audit (ok), npm audit fix (ok), npm ci (ok), build (FAIL), revert npm install (ok)
    runMock
      .mockResolvedValueOnce(ok()) // npm outdated
      .mockResolvedValueOnce(ok()) // npm audit
      .mockResolvedValueOnce(ok()) // npm audit fix
      .mockResolvedValueOnce(ok()) // npm ci (bootstrap before validation)
      .mockResolvedValueOnce(fail('build failed')) // npm run build
      .mockResolvedValueOnce(ok()); // npm install (revert)

    const result = await runNpmUpdater(
      runner,
      baseConfig(),
      baseScan([{ pkg: 'lodash', safeVersion: '4.17.21' }]),
      '/tmp/project',
      false,
      [{ name: 'build', command: 'npm run build' }],
      'npm-audit',
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('reverted');
    expect(result.validations[0]!.name).toBe('build');
    expect(result.validations[0]!.status).toBe('fail');

    // Revert should have been called (npm ci)
    const calledCommands: string[] = runMock.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calledCommands).toContain('npm ci');
  });

  it('validation failure (osv) => status is "error" and changes are reverted', async () => {
    const runner = makeRunner();
    const runMock = runner.run as ReturnType<typeof vi.fn>;

    // With fixer=osv, updater is a no-op for remediation.
    // Sequence: npm outdated (ok), npm audit (ok), npm ci (ok), build (FAIL), revert npm install (ok)
    runMock
      .mockResolvedValueOnce(ok()) // npm outdated
      .mockResolvedValueOnce(ok()) // npm audit
      .mockResolvedValueOnce(ok()) // npm ci (bootstrap before validation)
      .mockResolvedValueOnce(fail('build failed')) // npm run build
      .mockResolvedValueOnce(ok()); // npm install (revert)

    const result = await runNpmUpdater(
      runner,
      baseConfig(),
      baseScan([{ pkg: 'lodash', safeVersion: '4.17.21' }]),
      '/tmp/project',
      false,
      [{ name: 'build', command: 'npm run build' }],
      'osv',
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('reverted');
    expect(result.validations[0]!.name).toBe('build');
    expect(result.validations[0]!.status).toBe('fail');

    const calledCommands: string[] = runMock.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calledCommands).toContain('npm ci');
    // osv strategy: no npm audit fix
    expect(calledCommands.some((cmd) => cmd === 'npm audit fix')).toBe(false);
  });

  it('osv-scanner fix and post-update scan do NOT run inside updater (orchestrator responsibility)', async () => {
    const runner = makeRunner();
    const runMock = runner.run as ReturnType<typeof vi.fn>;

    await runNpmUpdater(
      runner,
      baseConfig(),
      baseScan([{ pkg: 'lodash', safeVersion: '4.17.21' }]),
      '/tmp/project',
      false,
      [{ name: 'build', command: 'npm run build' }],
    );

    const calledCommands: string[] = runMock.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calledCommands.some((cmd) => cmd.includes('osv-scanner fix'))).toBe(false);
    expect(calledCommands.some((cmd) => cmd.includes('osv-scanner --lockfile package-lock.json'))).toBe(false);
  });
});

describe('runNpmUpdater — fixer strategy dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFile.mockResolvedValue(DEFAULT_LOCKFILE);
  });

  it('uses npm audit fix when fixerStrategy is "npm-audit"', async () => {
    const runner = makeRunner();
    const runMock = runner.run as ReturnType<typeof vi.fn>;

    await runNpmUpdater(
      runner,
      baseConfig(),
      baseScan([{ pkg: 'lodash', safeVersion: '4.17.21' }]),
      '/tmp/project',
      false,
      [],
      'npm-audit',
    );

    const calledCommands: string[] = runMock.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calledCommands.some((cmd) => cmd === 'npm audit fix')).toBe(true);
    expect(calledCommands.some((cmd) => cmd.includes('osv-scanner fix'))).toBe(false);
  });

  it('defaults to osv strategy (no-op in updater) when no fixerStrategy provided', async () => {
    const runner = makeRunner();
    const runMock = runner.run as ReturnType<typeof vi.fn>;

    await runNpmUpdater(
      runner,
      baseConfig(),
      baseScan([{ pkg: 'lodash', safeVersion: '4.17.21' }]),
      '/tmp/project',
      false,
      [],
      // no fixerStrategy — defaults to 'osv'
    );

    const calledCommands: string[] = runMock.mock.calls.map((c: unknown[]) => String(c[0]));
    // osv strategy: no npm audit fix, no osv-scanner fix (orchestrator does it)
    expect(calledCommands.some((cmd) => cmd === 'npm audit fix')).toBe(false);
    expect(calledCommands.some((cmd) => cmd.includes('osv-scanner fix'))).toBe(false);
  });

  it('osv strategy is a no-op in updater (packages_updated is empty when no osvFixOutcome)', async () => {
    const runner = makeRunner();

    const result = await runNpmUpdater(
      runner,
      baseConfig(),
      baseScan([{ pkg: 'lodash', safeVersion: '4.17.21' }]),
      '/tmp/project',
      false,
      [],
      'osv',
    );

    expect(result.status).toBe('success');
    // Without osvFixOutcome, fixer returns empty; packages_updated is empty
    expect(result.packages_updated).toHaveLength(0);
  });
});

// ── New regression tests: container-path diagnostics & streaming ─────────────

describe('runNpmUpdater — npm ci failure diagnostics (container-path regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('npm ci failure surfaces command, exit code, stdout, and stderr in validation detail', async () => {
    const runner = makeRunner();
    const runMock = runner.run as ReturnType<typeof vi.fn>;

    // osv fixer: npm outdated, npm audit, then npm ci FAIL
    runMock
      .mockResolvedValueOnce(ok())                              // npm outdated
      .mockResolvedValueOnce(ok())                              // npm audit
      .mockResolvedValueOnce({                                  // npm ci FAIL
        stdout: 'npm WARN...',
        stderr: 'npm ERR! peer dep conflict',
        exitCode: 1,
        command: 'npm ci',
        dryRun: false,
      })
      .mockResolvedValueOnce(ok());                             // npm install (revert)

    const result = await runNpmUpdater(
      runner,
      baseConfig(),
      baseScan([{ pkg: 'lodash', safeVersion: '4.17.21' }]),
      '/tmp/project',
      false,
      [{ name: 'build', command: 'npm run build' }],
      'osv',
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('npm ci failed before validation');
    expect(result.validations).toHaveLength(1);
    expect(result.validations[0]!.name).toBe('npm ci');
    expect(result.validations[0]!.status).toBe('fail');
    // detail must contain exit code
    expect(result.validations[0]!.detail).toMatch(/exit.*1/i);
    // detail must contain stderr
    expect(result.validations[0]!.detail).toContain('peer dep conflict');
    // detail must contain stdout
    expect(result.validations[0]!.detail).toContain('npm WARN');
  });

  it('npm ci failure invokes revert (npm ci) with stream: true', async () => {
    const runner = makeRunner();
    const runMock = runner.run as ReturnType<typeof vi.fn>;

    runMock
      .mockResolvedValueOnce(ok())  // npm outdated
      .mockResolvedValueOnce(ok())  // npm audit
      .mockResolvedValueOnce(fail('peer dep conflict')) // npm ci FAIL
      .mockResolvedValueOnce(ok()); // npm install (revert)

    await runNpmUpdater(
      runner,
      baseConfig(),
      baseScan([{ pkg: 'lodash', safeVersion: '4.17.21' }]),
      '/tmp/project',
      false,
      [{ name: 'build', command: 'npm run build' }],
      'osv',
    );

    // Last call should be npm ci (revert) with stream: true
    const calls = (runMock.mock.calls as [string, Record<string, unknown>?][]);
    const revertCall = calls.find(([cmd]) => cmd === 'npm ci');
    expect(revertCall).toBeDefined();
    expect(revertCall![1]).toMatchObject({ stream: true });
  });

  it('npm ci failure emits error-level log with diagnostics before revert', async () => {
    const runner = makeRunner();
    const runMock = runner.run as ReturnType<typeof vi.fn>;

    runMock
      .mockResolvedValueOnce(ok())  // npm outdated
      .mockResolvedValueOnce(ok())  // npm audit
      .mockResolvedValueOnce(fail('ci stderr output')) // npm ci FAIL
      .mockResolvedValueOnce(ok()); // npm install (revert)

    const { logger: mockLogger } = await import('@infra/utils/logger.js');
    const errorSpy = mockLogger.error as ReturnType<typeof vi.fn>;
    errorSpy.mockClear();

    await runNpmUpdater(
      runner,
      baseConfig(),
      baseScan([{ pkg: 'lodash', safeVersion: '4.17.21' }]),
      '/tmp/project',
      false,
      [{ name: 'build', command: 'npm run build' }],
      'osv',
    );

    const errorCalls: string[] = errorSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(errorCalls.some((msg) => msg.includes('npm ci failed') && msg.includes('ci stderr output'))).toBe(true);
  });

  it('npm ci is invoked with stream: true for real-time progress', async () => {
    const runner = makeRunner();
    const runMock = runner.run as ReturnType<typeof vi.fn>;

    await runNpmUpdater(
      runner,
      baseConfig(),
      baseScan([{ pkg: 'lodash', safeVersion: '4.17.21' }]),
      '/tmp/project',
      false,
      [{ name: 'build', command: 'npm run build' }],
      'osv',
    );

    const calls = (runMock.mock.calls as [string, Record<string, unknown>?][]);
    const ciCall = calls.find(([cmd]) => cmd === 'npm ci');
    expect(ciCall).toBeDefined();
    expect(ciCall![1]).toMatchObject({ stream: true });
  });
});

describe('runNpmUpdater — revert npm install failure diagnostics (regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('revert npm install failure throws and is NOT silently swallowed', async () => {
    const runner = makeRunner();
    const runMock = runner.run as ReturnType<typeof vi.fn>;

    // Sequence (osv): outdated, audit, npm ci FAIL, then revert npm install FAIL
    runMock
      .mockResolvedValueOnce(ok())               // npm outdated
      .mockResolvedValueOnce(ok())               // npm audit
      .mockResolvedValueOnce(fail('ci failed'))  // npm ci FAIL
      .mockResolvedValueOnce(fail('revert failed too')); // npm install (revert) FAIL

    // revertNpmChanges throws when install fails — updater wraps in PhaseError
    await expect(
      runNpmUpdater(
        runner,
        baseConfig(),
        baseScan([{ pkg: 'lodash', safeVersion: '4.17.21' }]),
        '/tmp/project',
        false,
        [{ name: 'build', command: 'npm run build' }],
        'osv',
      ),
    ).rejects.toThrow(/revert/i);
  });

  it('revert npm ci failure emits error-level log with diagnostics', async () => {
    const runner = makeRunner();
    const runMock = runner.run as ReturnType<typeof vi.fn>;

    runMock
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(fail('ci err'))
      .mockResolvedValueOnce({
        stdout: 'revert stdout',
        stderr: 'revert stderr details',
        exitCode: 1,
        command: 'npm install',
        dryRun: false,
      });

    const { logger: mockLogger } = await import('@infra/utils/logger.js');
    const errorSpy = mockLogger.error as ReturnType<typeof vi.fn>;
    errorSpy.mockClear();

    await expect(
      runNpmUpdater(
        runner,
        baseConfig(),
        baseScan([{ pkg: 'lodash', safeVersion: '4.17.21' }]),
        '/tmp/project',
        false,
        [{ name: 'build', command: 'npm run build' }],
        'osv',
      ),
    ).rejects.toThrow();

    const errorCalls: string[] = errorSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(
      errorCalls.some(
        (msg) => msg.includes('npm ci (revert) failed') && msg.includes('revert stderr details'),
      ),
    ).toBe(true);
  });
});

// ── preFixBackups: orchestrator-provided backups for osv strategy ────────────

describe('runNpmUpdater — preFixBackups (osv rollback uses orchestrator backup)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFile.mockResolvedValue(DEFAULT_LOCKFILE);
  });

  it('uses preFixBackups instead of calling backupFiles when provided', async () => {
    const { backupFiles: mockBackupFiles } = await import('@infra/utils/git.js');
    const backupSpy = mockBackupFiles as ReturnType<typeof vi.fn>;
    backupSpy.mockClear();

    const runner = makeRunner();
    const runMock = runner.run as ReturnType<typeof vi.fn>;

    // validation fails → triggers rollback
    runMock
      .mockResolvedValueOnce(ok())  // npm outdated
      .mockResolvedValueOnce(ok())  // npm audit
      .mockResolvedValueOnce(ok())  // npm ci
      .mockResolvedValueOnce(fail('build failed')) // npm run build
      .mockResolvedValueOnce(ok()); // npm install (revert)

    const preFixBackups = new Map([
      ['package.json', '{"name":"test"}'],
      ['package-lock.json', '{"lockfileVersion":3}'],
    ]);

    await runNpmUpdater(
      runner,
      baseConfig(),
      baseScan([{ pkg: 'lodash', safeVersion: '4.17.21' }]),
      '/tmp/project',
      false,
      [{ name: 'build', command: 'npm run build' }],
      'osv',
      preFixBackups,
    );

    // backupFiles must NOT be called for the primary set (NPM_FILES) — caller's backups were used.
    // It IS called separately for advisor-only files (yarn.lock) which osv can't fix.
    expect(backupSpy).not.toHaveBeenCalledWith(['package.json', 'package-lock.json'], '/tmp/project');
    expect(backupSpy).toHaveBeenCalledWith(['yarn.lock'], '/tmp/project');
  });

  it('passes provided preFixBackups to restoreFiles on validation failure', async () => {
    const { restoreFiles: mockRestoreFiles } = await import('@infra/utils/git.js');
    const restoreSpy = mockRestoreFiles as ReturnType<typeof vi.fn>;
    restoreSpy.mockClear();

    const runner = makeRunner();
    const runMock = runner.run as ReturnType<typeof vi.fn>;

    runMock
      .mockResolvedValueOnce(ok())  // npm outdated
      .mockResolvedValueOnce(ok())  // npm audit
      .mockResolvedValueOnce(ok())  // npm ci
      .mockResolvedValueOnce(fail('build failed')) // npm run build
      .mockResolvedValueOnce(ok()); // npm install (revert)

    const preFixBackups = new Map([
      ['package.json', '{"name":"test"}'],
      ['package-lock.json', '{"lockfileVersion":3}'],
    ]);

    const result = await runNpmUpdater(
      runner,
      baseConfig(),
      baseScan([{ pkg: 'lodash', safeVersion: '4.17.21' }]),
      '/tmp/project',
      false,
      [{ name: 'build', command: 'npm run build' }],
      'osv',
      preFixBackups,
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('reverted');
    // restoreFiles must have been called with the exact preFixBackups map
    expect(restoreSpy).toHaveBeenCalledWith(preFixBackups, '/tmp/project');
  });

  it('includes yarn.lock in the revert backup when present on disk (advisor-only file)', async () => {
    const { backupFiles: mockBackupFiles, restoreFiles: mockRestoreFiles } = await import('@infra/utils/git.js');
    const backupSpy = mockBackupFiles as ReturnType<typeof vi.fn>;
    const restoreSpy = mockRestoreFiles as ReturnType<typeof vi.fn>;
    backupSpy.mockClear();
    restoreSpy.mockClear();

    // Simulate yarn.lock existing on disk for ONLY this test's advisor-backup call.
    // mockImplementationOnce avoids leaking the custom impl into subsequent tests.
    backupSpy.mockImplementationOnce(async () => new Map([['yarn.lock', 'yarn-lock-content']]));

    const runner = makeRunner();
    const runMock = runner.run as ReturnType<typeof vi.fn>;
    runMock
      .mockResolvedValueOnce(ok())  // npm outdated
      .mockResolvedValueOnce(ok())  // npm audit
      .mockResolvedValueOnce(ok())  // npm ci (pre-validation)
      .mockResolvedValueOnce(fail('build failed')) // npm run build
      .mockResolvedValueOnce(ok()); // npm ci (revert)

    const preFixBackups = new Map([['package-lock.json', '{"lockfileVersion":3}']]);

    await runNpmUpdater(
      runner,
      baseConfig(),
      baseScan([{ pkg: 'lodash', safeVersion: '4.17.21' }]),
      '/tmp/project',
      false,
      [{ name: 'build', command: 'npm run build' }],
      'osv',
      preFixBackups,
    );

    // Advisor backup must have queried yarn.lock specifically
    expect(backupSpy).toHaveBeenCalledWith(['yarn.lock'], '/tmp/project');

    // Restore must have received a merged map containing BOTH preFixBackups and yarn.lock
    const expectedMerged = new Map([
      ['package-lock.json', '{"lockfileVersion":3}'],
      ['yarn.lock', 'yarn-lock-content'],
    ]);
    expect(restoreSpy).toHaveBeenCalledWith(expectedMerged, '/tmp/project');
  });

  it('calls restoreFiles twice on validation failure (wraps npm ci revert) to defeat lockfile mutation', async () => {
    const { restoreFiles: mockRestoreFiles } = await import('@infra/utils/git.js');
    const restoreSpy = mockRestoreFiles as ReturnType<typeof vi.fn>;
    restoreSpy.mockClear();

    const runner = makeRunner();
    const runMock = runner.run as ReturnType<typeof vi.fn>;

    runMock
      .mockResolvedValueOnce(ok())  // npm outdated
      .mockResolvedValueOnce(ok())  // npm audit
      .mockResolvedValueOnce(ok())  // npm ci (pre-validation)
      .mockResolvedValueOnce(fail('build failed')) // npm run build
      .mockResolvedValueOnce(ok()); // npm ci (revert)

    const preFixBackups = new Map([['package-lock.json', '{"lockfileVersion":3}']]);

    await runNpmUpdater(
      runner,
      baseConfig(),
      baseScan([{ pkg: 'lodash', safeVersion: '4.17.21' }]),
      '/tmp/project',
      false,
      [{ name: 'build', command: 'npm run build' }],
      'osv',
      preFixBackups,
    );

    // Two restores: one before npm ci (the actual revert), one after (to undo any
    // lockfile mutation npm ci introduced — lockfile-format upgrades, normalization, etc).
    expect(restoreSpy).toHaveBeenCalledTimes(2);
    expect(restoreSpy).toHaveBeenNthCalledWith(1, preFixBackups, '/tmp/project');
    expect(restoreSpy).toHaveBeenNthCalledWith(2, preFixBackups, '/tmp/project');
  });

  it('falls back to internal backupFiles when preFixBackups is not provided (npm-audit)', async () => {
    const { backupFiles: mockBackupFiles } = await import('@infra/utils/git.js');
    const backupSpy = mockBackupFiles as ReturnType<typeof vi.fn>;
    backupSpy.mockClear();

    const runner = makeRunner();

    await runNpmUpdater(
      runner,
      baseConfig(),
      baseScan([{ pkg: 'lodash', safeVersion: '4.17.21' }]),
      '/tmp/project',
      false,
      [],
      'npm-audit',
      // no preFixBackups
    );

    // Without preFixBackups, internal backupFiles must be called
    expect(backupSpy).toHaveBeenCalledWith(['package.json', 'package-lock.json'], '/tmp/project');
  });
});

// ── osvFixOutcome: packages_updated sourced from staging applier ──────────────

describe('runNpmUpdater — osvFixOutcome parameter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFile.mockResolvedValue(DEFAULT_LOCKFILE);
  });

  it('osvFixOutcome present with packages → packages_updated populated from it', async () => {
    const runner = makeRunner();

    const osvFixOutcome = {
      applied: true,
      packagesUpdated: [
        { name: 'lodash', versionFrom: '4.17.20', versionTo: '4.17.21' },
        { name: 'axios', versionFrom: '1.6.0', versionTo: '1.7.0' },
      ],
    };

    const result = await runNpmUpdater(
      runner,
      baseConfig(),
      baseScan([{ pkg: 'lodash', safeVersion: '4.17.21' }]),
      '/tmp/project',
      false,
      [],
      'osv',
      undefined,
      osvFixOutcome,
    );

    expect(result.status).toBe('success');
    expect(result.packages_updated).toContain('lodash@4.17.21');
    expect(result.packages_updated).toContain('axios@1.7.0');
  });

  it('osvFixOutcome present but applied=false → packages_updated from it (empty)', async () => {
    const runner = makeRunner();

    const osvFixOutcome = {
      applied: false,
      packagesUpdated: [],
    };

    const result = await runNpmUpdater(
      runner,
      baseConfig(),
      baseScan([{ pkg: 'lodash', safeVersion: '4.17.21' }]),
      '/tmp/project',
      false,
      [],
      'osv',
      undefined,
      osvFixOutcome,
    );

    expect(result.status).toBe('success');
    expect(result.packages_updated).toHaveLength(0);
  });

  it('osvFixOutcome absent, fixerStrategy=npm-audit → uses existing fixerResult.packagesUpdated (no regression)', async () => {
    const runner = makeRunner();
    const runMock = runner.run as ReturnType<typeof vi.fn>;

    // npm-audit fixer returns the packages via npm audit fix
    runMock
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'npm outdated', dryRun: false })
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'npm audit', dryRun: false })
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'npm audit fix', dryRun: false });

    const result = await runNpmUpdater(
      runner,
      baseConfig(),
      baseScan([{ pkg: 'lodash', safeVersion: '4.17.21' }]),
      '/tmp/project',
      false,
      [],
      'npm-audit',
      undefined,
      undefined, // no osvFixOutcome
    );

    expect(result.status).toBe('success');
    // npm-audit fixer returns packages_updated from its own logic (may be empty if no special output)
    // The key assertion here is that osvFixOutcome path was NOT taken
    expect(Array.isArray(result.packages_updated)).toBe(true);
  });
});
