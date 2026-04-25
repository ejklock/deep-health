/**
 * Unit tests for ExternalScannerAdapter.buildScanResult() and scan().
 *
 * Covers:
 * - auto_safe classification for minor version bumps
 * - breaking classification for major version bumps
 * - manual classification when safeVersion is null
 * - protected_packages constraint triggering breaking with 'protected-constraint'
 * - multiple ecosystems in one call
 * - empty input produces empty ecosystems {}
 * - scan() delegates to fetchVulnerabilities and buildScanResult
 * - result metadata ($schema, agent, status, error, branch)
 */
import { describe, it, expect, vi } from 'vitest';
import { ExternalScannerAdapter } from '@modules/scanner/external-adapter';
import type { RawVulnerability } from '@modules/scanner/external-adapter';
import type { ScannerEngineContext } from '@modules/scanner/types';
import { EcosystemRegistry } from '@modules/ecosystem/registry';
import type { EcosystemPlugin } from '@modules/ecosystem/types';
import type { ProjectConfig, ProtectedPackage } from '@core/types/config';

// ─── Helpers ──────────────────────────────────────────────────────────────────

class TestEngine extends ExternalScannerAdapter {
  readonly id = 'test-engine';
  readonly name = 'Test Engine';

  async assertAvailable(_ctx: ScannerEngineContext): Promise<void> {}

  async fetchVulnerabilities(_ctx: ScannerEngineContext): Promise<RawVulnerability[]> {
    return this.stubbedVulns;
  }

  stubbedVulns: RawVulnerability[] = [];
}

function makeMockPlugin(protectedPkgs: ProtectedPackage[] = []): EcosystemPlugin {
  return {
    id: 'npm',
    name: 'npm',
    lockfiles: [],
    osvEcosystems: ['npm'],
    reportLabel: 'npm',
    supportedFixers: ['npm-audit'],
    defaultValidationCommands: [],
    defaultAdvisors: [],
    buildScanArgs: () => [],
    getProtectedPackages: () => protectedPkgs,
    runUpdater: vi.fn() as any,
    postUpdateOsvVerify: 'never',
  };
}

function makeRegistry(plugin?: EcosystemPlugin): EcosystemRegistry {
  const registry = new EcosystemRegistry();
  if (plugin) {
    registry.register(plugin);
  }
  return registry;
}

function makeCtx(overrides: Partial<ScannerEngineContext> = {}): ScannerEngineContext {
  return {
    runner: {
      run: vi.fn(),
      runArgs: vi.fn(),
    } as any,
    config: {} as ProjectConfig,
    cwd: '/tmp/project',
    ecosystemRegistry: makeRegistry(makeMockPlugin()),
    branch: 'main',
    ...overrides,
  };
}

// ─── auto_safe classification ─────────────────────────────────────────────────

describe('ExternalScannerAdapter — auto_safe classification', () => {
  it('classifies a minor bump as auto_safe and increments counters', async () => {
    const engine = new TestEngine();
    engine.stubbedVulns = [
      {
        ecosystem: 'npm',
        package: 'lodash',
        currentVersion: '4.17.0',
        safeVersion: '4.17.21',
        severity: 'HIGH',
        advisoryId: 'GHSA-xxxx',
      },
    ];

    const ctx = makeCtx();
    const result = await engine.scan(ctx);

    const eco = result.ecosystems['npm']!;
    expect(eco.auto_safe).toBe(1);
    expect(eco.auto_safe_packages).toContain('lodash@4.17.0');
    expect(eco.breaking).toBe(0);
    expect(eco.manual).toBe(0);
    expect(eco.vulnerabilities_total).toBe(1);
    expect(eco.vulnerabilities[0]!.classification).toBe('auto_safe');
  });
});

// ─── breaking classification (major bump) ─────────────────────────────────────

describe('ExternalScannerAdapter — breaking classification (major bump)', () => {
  it('classifies a major bump as breaking and increments counters', async () => {
    const engine = new TestEngine();
    engine.stubbedVulns = [
      {
        ecosystem: 'npm',
        package: 'express',
        currentVersion: '4.18.0',
        safeVersion: '5.0.0',
        severity: 'CRITICAL',
        advisoryId: 'CVE-2024-xxxx',
      },
    ];

    const ctx = makeCtx();
    const result = await engine.scan(ctx);

    const eco = result.ecosystems['npm']!;
    expect(eco.breaking).toBe(1);
    expect(eco.breaking_packages).toContain('express@4.18.0');
    expect(eco.auto_safe).toBe(0);
    expect(eco.manual).toBe(0);
    expect(eco.vulnerabilities[0]!.classification).toBe('breaking');
    expect(eco.vulnerabilities[0]!.breakingReason).toBe('major-bump');
  });
});

// ─── manual classification (no safeVersion) ───────────────────────────────────

describe('ExternalScannerAdapter — manual classification (no safeVersion)', () => {
  it('classifies null safeVersion as manual and increments counters', async () => {
    const engine = new TestEngine();
    engine.stubbedVulns = [
      {
        ecosystem: 'npm',
        package: 'vulnerable-pkg',
        currentVersion: '1.0.0',
        safeVersion: null,
        severity: 'MEDIUM',
        advisoryId: 'GHSA-no-fix',
      },
    ];

    const ctx = makeCtx();
    const result = await engine.scan(ctx);

    const eco = result.ecosystems['npm']!;
    expect(eco.manual).toBe(1);
    expect(eco.manual_packages).toContain('vulnerable-pkg@1.0.0');
    expect(eco.auto_safe).toBe(0);
    expect(eco.breaking).toBe(0);
    expect(eco.vulnerabilities[0]!.classification).toBe('manual');
    expect(eco.vulnerabilities[0]!.reason).toBe('No safe version available');
  });
});

// ─── protected_packages constraint ────────────────────────────────────────────

describe('ExternalScannerAdapter — protected_packages constraint', () => {
  it('classifies as breaking with protected-constraint when safeVersion violates constraint', async () => {
    const protectedPkg: ProtectedPackage = {
      package: 'react',
      constraint: '^17.0.0',
      reason: 'React 18 requires major refactor',
    };
    const plugin = makeMockPlugin([protectedPkg]);
    const registry = makeRegistry(plugin);

    const engine = new TestEngine();
    engine.stubbedVulns = [
      {
        ecosystem: 'npm',
        package: 'react',
        currentVersion: '17.0.2',
        safeVersion: '18.2.0',
        severity: 'HIGH',
        advisoryId: 'GHSA-react-xxxx',
      },
    ];

    const ctx = makeCtx({ ecosystemRegistry: registry });
    const result = await engine.scan(ctx);

    const eco = result.ecosystems['npm']!;
    expect(eco.breaking).toBe(1);
    expect(eco.breaking_packages).toContain('react@17.0.2');
    expect(eco.vulnerabilities[0]!.classification).toBe('breaking');
    expect(eco.vulnerabilities[0]!.breakingReason).toBe('protected-constraint');
  });
});

// ─── multiple ecosystems ──────────────────────────────────────────────────────

describe('ExternalScannerAdapter — multiple ecosystems', () => {
  it('creates separate ecosystem entries for npm and packagist vulns', async () => {
    const npmPlugin = makeMockPlugin();
    const packagistPlugin: EcosystemPlugin = {
      ...makeMockPlugin(),
      id: 'composer',
      name: 'Composer',
      osvEcosystems: ['packagist'],
      reportLabel: 'PHP/Composer',
    };
    const registry = new EcosystemRegistry();
    registry.register(npmPlugin);
    registry.register(packagistPlugin);

    const engine = new TestEngine();
    engine.stubbedVulns = [
      {
        ecosystem: 'npm',
        package: 'lodash',
        currentVersion: '4.17.0',
        safeVersion: '4.17.21',
        severity: 'HIGH',
        advisoryId: 'GHSA-npm-xxx',
      },
      {
        ecosystem: 'packagist',
        package: 'symfony/http-foundation',
        currentVersion: '5.4.0',
        safeVersion: '5.4.40',
        severity: 'MEDIUM',
        advisoryId: 'GHSA-php-xxx',
      },
    ];

    const ctx = makeCtx({ ecosystemRegistry: registry });
    const result = await engine.scan(ctx);

    expect(Object.keys(result.ecosystems)).toHaveLength(2);
    expect(result.ecosystems['npm']).toBeDefined();
    expect(result.ecosystems['packagist']).toBeDefined();
    expect(result.ecosystems['npm']!.vulnerabilities_total).toBe(1);
    expect(result.ecosystems['packagist']!.vulnerabilities_total).toBe(1);
    expect(result.ecosystems['npm']!.auto_safe).toBe(1);
    expect(result.ecosystems['packagist']!.auto_safe).toBe(1);
  });
});

// ─── empty input ──────────────────────────────────────────────────────────────

describe('ExternalScannerAdapter — empty input', () => {
  it('returns empty ecosystems when fetchVulnerabilities returns []', async () => {
    const engine = new TestEngine();
    engine.stubbedVulns = [];

    const ctx = makeCtx();
    const result = await engine.scan(ctx);

    expect(Object.keys(result.ecosystems)).toHaveLength(0);
    expect(result.ecosystems).toEqual({});
  });
});

// ─── scan() delegates to buildScanResult ─────────────────────────────────────

describe('ExternalScannerAdapter — scan() delegation', () => {
  it('scan() calls fetchVulnerabilities and returns the built result', async () => {
    const engine = new TestEngine();
    const fetchSpy = vi.spyOn(engine, 'fetchVulnerabilities');
    const buildSpy = vi.spyOn(engine as any, 'buildScanResult');

    engine.stubbedVulns = [
      {
        ecosystem: 'npm',
        package: 'pkg-a',
        currentVersion: '1.0.0',
        safeVersion: '1.1.0',
        severity: 'LOW',
        advisoryId: 'GHSA-aaa',
      },
    ];

    const ctx = makeCtx();
    const result = await engine.scan(ctx);

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledWith(ctx);
    expect(buildSpy).toHaveBeenCalledOnce();
    expect(result.agent).toBe('test-engine');
  });
});

// ─── result metadata ──────────────────────────────────────────────────────────

describe('ExternalScannerAdapter — result metadata', () => {
  it('sets correct $schema, agent, status, error, and branch from ctx', async () => {
    const engine = new TestEngine();
    engine.stubbedVulns = [];

    const ctx = makeCtx({ branch: 'feature/my-feature' });
    const result = await engine.scan(ctx);

    expect(result.$schema).toBe('osv-scan-result/v1');
    expect(result.agent).toBe('test-engine');
    expect(result.status).toBe('success');
    expect(result.error).toBeNull();
    expect(result.branch).toBe('feature/my-feature');
  });
});
