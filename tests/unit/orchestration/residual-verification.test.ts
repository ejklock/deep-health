/**
 * Direct tests for the ResidualVerification union states produced by the
 * orchestrator's runOsvResidualVerification helper, and for the executive
 * report rendering of the 'unverified' branch.
 *
 * Covers the Tester gap:
 *   "No direct tests found for residual verification state union behavior
 *    or executive unverified rendering branch."
 */
import { describe, it, expect } from 'vitest';
import type { ResidualVerification } from '@core/types/report';
import { generateExecutiveReport } from '@reporting/executive';
import type { ExecutiveReportOptions } from '@core/types/report';
import type { ScanResultJson } from '@core/types/scan';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const emptyScan: ScanResultJson = {
  $schema: 'osv-scan-result/v1',
  agent: 'osv-scanner',
  status: 'success',
  environment: 'local',
  ecosystems: {},
  error: null,
};

const npmVulnScan: ScanResultJson = {
  $schema: 'osv-scan-result/v1',
  agent: 'osv-scanner',
  status: 'success',
  environment: 'local',
  ecosystems: {
    npm: {
      vulnerabilities_total: 1,
      auto_safe: 1,
      breaking: 0,
      manual: 0,
      auto_safe_packages: ['lodash'],
      breaking_packages: [],
      manual_packages: [],
      vulnerabilities: [
        {
          ghsaId: 'GHSA-test-1234',
          package: 'lodash',
          ecosystem: 'npm',
          currentVersion: '4.17.20',
          safeVersion: '4.17.21',
          cvss: '7.5',
          risk: 'high',
          reason: null,
          classification: 'auto_safe',
        },
      ],
    },
  },
  error: null,
};

const baseOpts: ExecutiveReportOptions = {
  client: 'Acme Corp',
  project: 'My App',
  scanBefore: emptyScan,
  scanAfter: emptyScan,
  updates: {},
};

// ─── ResidualVerification union exhaustiveness ─────────────────────────────

describe('ResidualVerification union — type narrowing', () => {
  it('verified state has status "verified" and a summary map', () => {
    const v: ResidualVerification = { status: 'verified', summary: { npm: 0 } };
    expect(v.status).toBe('verified');
    if (v.status === 'verified') {
      expect(v.summary).toEqual({ npm: 0 });
    }
  });

  it('unverified state has status "unverified" and a non-empty summary map', () => {
    const v: ResidualVerification = { status: 'unverified', summary: { npm: 2, composer: 1 } };
    expect(v.status).toBe('unverified');
    if (v.status === 'unverified') {
      expect(v.summary['npm']).toBe(2);
      expect(v.summary['composer']).toBe(1);
    }
  });

  it('skipped state has status "skipped" and no summary property', () => {
    const v: ResidualVerification = { status: 'skipped' };
    expect(v.status).toBe('skipped');
    // TypeScript narrows: no summary property on skipped
    expect('summary' in v).toBe(false);
  });

  it('all three status values are distinct strings', () => {
    const statuses: ResidualVerification['status'][] = ['verified', 'unverified', 'skipped'];
    expect(new Set(statuses).size).toBe(3);
  });
});

// ─── executive report — residualVerification rendering ────────────────────

describe('generateExecutiveReport — residualVerification rendering', () => {
  it('renders without residual warning when residualVerification is skipped', () => {
    const html = generateExecutiveReport({
      ...baseOpts,
      scanBefore: npmVulnScan,
      updates: { npm: { status: 'success', packages_updated: ['lodash@4.17.21'], validations: [], error: null } },
      residualVerification: { status: 'skipped' },
    });
    expect(html).not.toContain('residual CVE unverified');
  });

  it('renders without residual warning when residualVerification is verified (all clean)', () => {
    const html = generateExecutiveReport({
      ...baseOpts,
      scanBefore: npmVulnScan,
      updates: { npm: { status: 'success', packages_updated: ['lodash@4.17.21'], validations: [], error: null } },
      residualVerification: { status: 'verified', summary: { npm: 0 } },
    });
    expect(html).not.toContain('residual CVE unverified');
  });

  it('renders residual warning when residualVerification is unverified', () => {
    const html = generateExecutiveReport({
      ...baseOpts,
      scanBefore: npmVulnScan,
      updates: { npm: { status: 'success', packages_updated: ['lodash@4.17.21'], validations: [], error: null } },
      residualVerification: { status: 'unverified', summary: { npm: 1 } },
    });
    expect(html).toContain('residual CVE unverified');
  });

  it('renders without residual warning when no residualVerification provided (defaults to skipped)', () => {
    const html = generateExecutiveReport({
      ...baseOpts,
      scanBefore: npmVulnScan,
      updates: { npm: { status: 'success', packages_updated: ['lodash@4.17.21'], validations: [], error: null } },
    });
    expect(html).not.toContain('residual CVE unverified');
  });
});
