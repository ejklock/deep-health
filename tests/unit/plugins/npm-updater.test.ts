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
    runtime: {
      execution: 'local',
      docker_service: '',
    },
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

  it('calls osv-scanner fix as the sole auto-safe step', async () => {
    const runner = makeRunner();
    const runMock = runner.run as ReturnType<typeof vi.fn>;

    await runNpmUpdater(runner, baseConfig(), baseScan([{ pkg: 'lodash', safeVersion: '4.17.21' }]), '/tmp/project');

    const calledCommands: string[] = runMock.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calledCommands.some((cmd) => cmd.includes('osv-scanner fix'))).toBe(true);
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

  it('returns status "success" and packages_updated from auto_safe_packages on happy path', async () => {
    const runner = makeRunner();

    const result = await runNpmUpdater(
      runner,
      baseConfig(),
      baseScan([{ pkg: 'lodash', safeVersion: '4.17.21' }]),
      '/tmp/project',
    );

    expect(result.status).toBe('success');
    expect(result.packages_updated).toContain('lodash@4.17.21');
  });
});

describe('runNpmUpdater — breaking package installs (authorized)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('installs breaking packages when authorizeBreaking=true', async () => {
    const runner = makeRunner();
    const runMock = runner.run as ReturnType<typeof vi.fn>;

    const scan = baseScan([], [{ pkg: 'react', safeVersion: '18.0.0' }]);
    await runNpmUpdater(runner, baseConfig(), scan, '/tmp/project', true);

    const calledCommands: string[] = runMock.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calledCommands).toContain('npm install react@18.0.0');
  });

  it('does NOT install breaking packages when authorizeBreaking=false (default)', async () => {
    const runner = makeRunner();
    const runMock = runner.run as ReturnType<typeof vi.fn>;

    const scan = baseScan([], [{ pkg: 'react', safeVersion: '18.0.0' }]);
    await runNpmUpdater(runner, baseConfig(), scan, '/tmp/project'); // default: false

    const calledCommands: string[] = runMock.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calledCommands.some((cmd) => cmd.includes('react@18.0.0'))).toBe(false);
  });

  it('breaking install failure => status is "error"', async () => {
    // Sequence: npm outdated (ok), npm audit (ok), osv fix (ok), npm install react@18.0.0 (FAIL)
    const runner = makeRunner();
    const runMock = runner.run as ReturnType<typeof vi.fn>;
    runMock
      .mockResolvedValueOnce(ok()) // npm outdated
      .mockResolvedValueOnce(ok()) // npm audit
      .mockResolvedValueOnce(ok()) // osv fix
      .mockResolvedValueOnce(fail('peer dep conflict')); // npm install react@18.0.0

    const scan = baseScan([], [{ pkg: 'react', safeVersion: '18.0.0' }]);
    const result = await runNpmUpdater(runner, baseConfig(), scan, '/tmp/project', true);

    expect(result.status).toBe('error');
    expect(result.error).toContain('npm install react@18.0.0 failed');
  });
});

describe('runNpmUpdater — build validation via validationCommands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
  });

  it('validation failure => status is "error" and changes are reverted', async () => {
    const runner = makeRunner();
    const runMock = runner.run as ReturnType<typeof vi.fn>;

    // Sequence: npm outdated (ok), npm audit (ok), osv fix (ok), build (FAIL), revert npm install (ok)
    runMock
      .mockResolvedValueOnce(ok()) // npm outdated
      .mockResolvedValueOnce(ok()) // npm audit
      .mockResolvedValueOnce(ok()) // osv fix
      .mockResolvedValueOnce(fail('build failed')) // npm run build
      .mockResolvedValueOnce(ok()); // npm install (revert)

    const result = await runNpmUpdater(
      runner,
      baseConfig(),
      baseScan([{ pkg: 'lodash', safeVersion: '4.17.21' }]),
      '/tmp/project',
      false,
      [{ name: 'build', command: 'npm run build' }],
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('reverted');
    expect(result.validations[0]!.name).toBe('build');
    expect(result.validations[0]!.status).toBe('fail');

    // Revert should have been called (npm install)
    const calledCommands: string[] = runMock.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calledCommands).toContain('npm install');
  });

  it('osv-scanner fix and post-update scan still run with validation commands', async () => {
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
    expect(calledCommands.some((cmd) => cmd.includes('osv-scanner fix'))).toBe(true);
    expect(calledCommands.some((cmd) => cmd.includes('osv-scanner --lockfile package-lock.json'))).toBe(true);
  });
});

describe('runNpmUpdater — fixer strategy dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('uses osv-scanner fix when fixerStrategy is "osv" (default)', async () => {
    const runner = makeRunner();
    const runMock = runner.run as ReturnType<typeof vi.fn>;

    await runNpmUpdater(
      runner,
      baseConfig(),
      baseScan([{ pkg: 'lodash', safeVersion: '4.17.21' }]),
      '/tmp/project',
      false,
      [],
      'osv',
    );

    const calledCommands: string[] = runMock.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calledCommands.some((cmd) => cmd.includes('osv-scanner fix'))).toBe(true);
    expect(calledCommands.some((cmd) => cmd === 'npm audit fix')).toBe(false);
  });
});
