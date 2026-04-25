/**
 * Edge case and branch coverage tests for ExternalScannerAdapter.
 *
 * Covers:
 * - Unknown ecosystem (not in registry) → empty protected list used
 * - safeVersion null → manual with reason 'No safe version available'
 * - cvss field present → used over severity in entry.cvss
 * - cvss field absent → severity used as fallback for entry.cvss
 * - Multiple vulns in same ecosystem → counters accumulate correctly
 * - branch null in ctx → result.branch is null
 * - branch non-null in ctx → result.branch matches ctx.branch
 */
import { describe, it, expect, vi } from 'vitest';
import { ExternalScannerAdapter } from '@modules/scanner/external-adapter';
import type { RawVulnerability } from '@modules/scanner/external-adapter';
import type { ScannerEngineContext } from '@modules/scanner/types';
import { EcosystemRegistry } from '@modules/ecosystem/registry';
import type { EcosystemPlugin } from '@modules/ecosystem/types';
import type { ProjectConfig } from '@core/types/config';

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

function makeMockPlugin(): EcosystemPlugin {
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
    getProtectedPackages: () => [],
    runUpdater: vi.fn() as any,
    postUpdateOsvVerify: 'never',
  };
}

function makeCtx(overrides: Partial<ScannerEngineContext> = {}): ScannerEngineContext {
  const registry = new EcosystemRegistry();
  registry.register(makeMockPlugin());

  return {
    runner: {
      run: vi.fn(),
      runArgs: vi.fn(),
    } as any,
    config: {} as ProjectConfig,
    cwd: '/tmp/project',
    ecosystemRegistry: registry,
    branch: 'main',
    ...overrides,
  };
}

// ─── Unknown ecosystem ────────────────────────────────────────────────────────

describe('ExternalScannerAdapter branches — unknown ecosystem', () => {
  it('uses empty protected list when ecosystem not found in registry', async () => {
    const engine = new TestEngine();
    engine.stubbedVulns = [
      {
        ecosystem: 'PyPI',  // not registered in the mock registry
        package: 'requests',
        currentVersion: '2.28.0',
        safeVersion: '2.31.0',
        severity: 'HIGH',
        advisoryId: 'CVE-2023-xxxxx',
      },
    ];

    // Registry only has 'npm' — 'PyPI' will not be found
    const ctx = makeCtx();
    const result = await engine.scan(ctx);

    // Should still produce a result — unknown ecosystem uses empty protected list
    const eco = result.ecosystems['PyPI']!;
    expect(eco).toBeDefined();
    expect(eco.vulnerabilities_total).toBe(1);
    // Minor bump: auto_safe (no protected constraint to block it)
    expect(eco.auto_safe).toBe(1);
  });
});

// ─── safeVersion null → manual ────────────────────────────────────────────────

describe('ExternalScannerAdapter branches — safeVersion null', () => {
  it('classifies as manual with reason "No safe version available"', async () => {
    const engine = new TestEngine();
    engine.stubbedVulns = [
      {
        ecosystem: 'npm',
        package: 'broken-pkg',
        currentVersion: '2.0.0',
        safeVersion: null,
        severity: 'CRITICAL',
        advisoryId: 'GHSA-no-fix-available',
      },
    ];

    const ctx = makeCtx();
    const result = await engine.scan(ctx);

    const eco = result.ecosystems['npm']!;
    expect(eco.manual).toBe(1);
    expect(eco.vulnerabilities[0]!.classification).toBe('manual');
    expect(eco.vulnerabilities[0]!.reason).toBe('No safe version available');
  });
});

// ─── cvss field present ───────────────────────────────────────────────────────

describe('ExternalScannerAdapter branches — cvss field present', () => {
  it('uses vuln.cvss over vuln.severity for entry.cvss when both are present', async () => {
    const engine = new TestEngine();
    engine.stubbedVulns = [
      {
        ecosystem: 'npm',
        package: 'some-pkg',
        currentVersion: '1.0.0',
        safeVersion: '1.0.1',
        severity: 'HIGH',
        cvss: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
        advisoryId: 'GHSA-cvss-test',
      },
    ];

    const ctx = makeCtx();
    const result = await engine.scan(ctx);

    const entry = result.ecosystems['npm']!.vulnerabilities[0]!;
    expect(entry.cvss).toBe('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H');
    expect(entry.cvss).not.toBe('HIGH');
  });
});

// ─── cvss field absent ────────────────────────────────────────────────────────

describe('ExternalScannerAdapter branches — cvss field absent', () => {
  it('falls back to vuln.severity for entry.cvss when cvss is undefined', async () => {
    const engine = new TestEngine();
    engine.stubbedVulns = [
      {
        ecosystem: 'npm',
        package: 'another-pkg',
        currentVersion: '3.0.0',
        safeVersion: '3.0.1',
        severity: 'MEDIUM',
        // cvss intentionally omitted
        advisoryId: 'GHSA-no-cvss',
      },
    ];

    const ctx = makeCtx();
    const result = await engine.scan(ctx);

    const entry = result.ecosystems['npm']!.vulnerabilities[0]!;
    expect(entry.cvss).toBe('MEDIUM');
  });
});

// ─── Multiple vulns same ecosystem ───────────────────────────────────────────

describe('ExternalScannerAdapter branches — multiple vulns same ecosystem', () => {
  it('accumulates counters correctly across multiple vulns in the same ecosystem', async () => {
    const engine = new TestEngine();
    engine.stubbedVulns = [
      {
        ecosystem: 'npm',
        package: 'pkg-auto',
        currentVersion: '1.0.0',
        safeVersion: '1.1.0',
        severity: 'HIGH',
        advisoryId: 'GHSA-auto',
      },
      {
        ecosystem: 'npm',
        package: 'pkg-break',
        currentVersion: '2.0.0',
        safeVersion: '3.0.0',
        severity: 'CRITICAL',
        advisoryId: 'GHSA-break',
      },
      {
        ecosystem: 'npm',
        package: 'pkg-manual',
        currentVersion: '5.0.0',
        safeVersion: null,
        severity: 'LOW',
        advisoryId: 'GHSA-manual',
      },
    ];

    const ctx = makeCtx();
    const result = await engine.scan(ctx);

    const eco = result.ecosystems['npm']!;
    expect(eco.vulnerabilities_total).toBe(3);
    expect(eco.auto_safe).toBe(1);
    expect(eco.breaking).toBe(1);
    expect(eco.manual).toBe(1);
    expect(eco.auto_safe_packages).toContain('pkg-auto@1.0.0');
    expect(eco.breaking_packages).toContain('pkg-break@2.0.0');
    expect(eco.manual_packages).toContain('pkg-manual@5.0.0');
  });
});

// ─── branch null in ctx ───────────────────────────────────────────────────────

describe('ExternalScannerAdapter branches — branch null', () => {
  it('sets result.branch to null when ctx.branch is null', async () => {
    const engine = new TestEngine();
    engine.stubbedVulns = [];

    const ctx = makeCtx({ branch: null });
    const result = await engine.scan(ctx);

    expect(result.branch).toBeNull();
  });
});

// ─── branch non-null in ctx ───────────────────────────────────────────────────

describe('ExternalScannerAdapter branches — branch non-null', () => {
  it('sets result.branch to ctx.branch when branch is provided', async () => {
    const engine = new TestEngine();
    engine.stubbedVulns = [];

    const ctx = makeCtx({ branch: 'release/2.0.0' });
    const result = await engine.scan(ctx);

    expect(result.branch).toBe('release/2.0.0');
  });
});
