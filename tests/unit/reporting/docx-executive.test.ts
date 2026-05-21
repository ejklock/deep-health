/**
 * Tests for src/reporting/docx-executive.ts
 * AC3: generateExecutiveReportDocx returns Buffer
 * AC4: DOCX tables have correct structure
 * AC6: executiveReportDocxFilename returns .docx extension
 */
import { describe, it, expect } from 'vitest';
import { generateExecutiveReportDocx, executiveReportDocxFilename } from '@reporting/docx-executive';
import { executiveReportFilename } from '@reporting/executive';
import type { ExecutiveReportOptions } from '@core/types/report';
import type { ScanResultJson } from '@core/types/scan';

const emptyScan: ScanResultJson = {
  agent: 'osv-scanner',
  status: 'success',
  environment: 'local',
  ecosystems: {},
  error: null,
};

const baseOpts: ExecutiveReportOptions = {
  client: 'Acme',
  project: 'Project',
  scanBefore: emptyScan,
  scanAfter: emptyScan,
  updates: {},
};

// ── executiveReportDocxFilename ───────────────────────────────────────────────

describe('executiveReportDocxFilename()', () => {
  it('returns a filename with .docx extension', () => {
    const name = executiveReportDocxFilename('Acme', 'Project');
    expect(name).toMatch(/\.docx$/);
  });

  it('includes client and project in the filename', () => {
    const name = executiveReportDocxFilename('Acme Corp', 'MyApp');
    expect(name).toContain('Acme Corp');
    expect(name).toContain('MyApp');
  });

  it('follows the [Client Project] Security Report - YYYY-MM - Month.docx pattern', () => {
    const name = executiveReportDocxFilename('Client', 'Project');
    expect(name).toMatch(/^\[Client Project\] Security Report - \d{4}-\d{2} - \w+\.docx$/);
  });

  it('produces a different extension than the markdown filename', () => {
    const md = executiveReportFilename('C', 'P');
    const docx = executiveReportDocxFilename('C', 'P');
    expect(md).toMatch(/\.md$/);
    expect(docx).toMatch(/\.docx$/);
    // Same base name except extension
    expect(docx.replace('.docx', '')).toBe(md.replace('.md', ''));
  });
});

// ── generateExecutiveReportDocx ───────────────────────────────────────────────

describe('generateExecutiveReportDocx()', () => {
  it('returns a Promise<Buffer>', async () => {
    const result = await generateExecutiveReportDocx(baseOpts);
    expect(Buffer.isBuffer(result)).toBe(true);
  });

  it('returns a non-empty Buffer', async () => {
    const result = await generateExecutiveReportDocx(baseOpts);
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns a valid OOXML zip (starts with PK header bytes)', async () => {
    const result = await generateExecutiveReportDocx(baseOpts);
    // DOCX files are ZIP archives; ZIP magic bytes are 50 4B 03 04
    expect(result[0]).toBe(0x50); // 'P'
    expect(result[1]).toBe(0x4b); // 'K'
  });

  it('produces a Buffer for an empty scan (no vulnerabilities)', async () => {
    const result = await generateExecutiveReportDocx({ ...baseOpts });
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.length).toBeGreaterThan(1000);
  });

  it('produces a Buffer when vulnerabilities are present', async () => {
    const scanWithVulns: ScanResultJson = {
      agent: 'osv-scanner',
      status: 'success',
      environment: 'local',
      ecosystems: {
        npm: {
          vulnerabilities_total: 1,
          auto_safe: 0,
          breaking: 1,
          manual: 0,
          auto_safe_packages: [],
          breaking_packages: ['lodash'],
          manual_packages: [],
          vulnerabilities: [
            {
              ecosystem: 'npm',
              package: 'lodash',
              currentVersion: '4.17.11',
              ghsaId: 'GHSA-1234-abcd-5678',
              cvss: '7.5',
              risk: 'High',
              safeVersion: null,
              classification: 'breaking',
              reason: 'Major version bump 4 → 5',
            },
          ],
        },
      },
      error: null,
    };

    const opts: ExecutiveReportOptions = {
      ...baseOpts,
      scanBefore: scanWithVulns,
    };

    const result = await generateExecutiveReportDocx(opts);
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.length).toBeGreaterThan(1000);
  });

  it('produces a Buffer when vulnerabilities are fixed (auto_safe + updates)', async () => {
    const scanWithFixed: ScanResultJson = {
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
              ecosystem: 'npm',
              package: 'lodash',
              currentVersion: '4.17.11',
              ghsaId: 'GHSA-abcd-1234-efgh',
              cvss: '5.0',
              risk: 'Medium',
              safeVersion: '4.17.21',
              classification: 'auto_safe',
              reason: null,
            },
          ],
        },
      },
      error: null,
    };

    const opts: ExecutiveReportOptions = {
      ...baseOpts,
      scanBefore: scanWithFixed,
      updates: {
        npm: {
          ecosystem: 'npm',
          packages_updated: ['lodash@4.17.21'],
          packages_skipped: [],
          packages_failed: [],
          validations: [{ name: 'tests', status: 'pass', detail: '42 tests passed' }],
        },
      },
    };

    const result = await generateExecutiveReportDocx(opts);
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.length).toBeGreaterThan(1000);
  });

  it('handles branch and scanner engines metadata', async () => {
    const result = await generateExecutiveReportDocx({
      ...baseOpts,
      branch: 'main',
      scannerEngines: ['osv', 'sonarqube'],
    });
    expect(Buffer.isBuffer(result)).toBe(true);
  });

  it('handles pt-br locale without throwing', async () => {
    const result = await generateExecutiveReportDocx({
      ...baseOpts,
      locale: 'pt-br',
    });
    expect(Buffer.isBuffer(result)).toBe(true);
  });
});

// ── DOCX structure: table columns ─────────────────────────────────────────────

describe('generateExecutiveReportDocx() — table structure', () => {
  it('produces a larger DOCX when fixed vulns are present (table adds bytes)', async () => {
    const scanWithFixed: ScanResultJson = {
      agent: 'osv-scanner',
      status: 'success',
      environment: 'local',
      ecosystems: {
        npm: {
          vulnerabilities_total: 2,
          auto_safe: 2,
          breaking: 0,
          manual: 0,
          auto_safe_packages: ['pkg-a', 'pkg-b'],
          breaking_packages: [],
          manual_packages: [],
          vulnerabilities: [
            {
              ecosystem: 'npm',
              package: 'pkg-a',
              currentVersion: '1.0.0',
              ghsaId: 'GHSA-aaaa-bbbb-cccc',
              cvss: '8.1',
              risk: 'High',
              safeVersion: '1.0.1',
              classification: 'auto_safe',
              reason: null,
            },
            {
              ecosystem: 'npm',
              package: 'pkg-b',
              currentVersion: '2.0.0',
              ghsaId: 'GHSA-dddd-eeee-ffff',
              cvss: '6.5',
              risk: 'Medium',
              safeVersion: '2.0.1',
              classification: 'auto_safe',
              reason: null,
            },
          ],
        },
      },
      error: null,
    };

    const emptyResult = await generateExecutiveReportDocx(baseOpts);
    const fixedResult = await generateExecutiveReportDocx({
      ...baseOpts,
      scanBefore: scanWithFixed,
      updates: {
        npm: {
          ecosystem: 'npm',
          packages_updated: ['pkg-a@1.0.1', 'pkg-b@2.0.1'],
          packages_skipped: [],
          packages_failed: [],
          validations: [{ name: 'tests', status: 'pass', detail: 'passed' }],
        },
      },
    });

    // A DOCX with table data should be larger than one without
    expect(fixedResult.length).toBeGreaterThan(emptyResult.length);
  });

  it('produces a larger DOCX when pending vulns are present', async () => {
    const scanWithPending: ScanResultJson = {
      agent: 'osv-scanner',
      status: 'success',
      environment: 'local',
      ecosystems: {
        npm: {
          vulnerabilities_total: 1,
          auto_safe: 0,
          breaking: 1,
          manual: 0,
          auto_safe_packages: [],
          breaking_packages: ['express'],
          manual_packages: [],
          vulnerabilities: [
            {
              ecosystem: 'npm',
              package: 'express',
              currentVersion: '4.0.0',
              ghsaId: 'GHSA-xxxx-yyyy-zzzz',
              cvss: '9.8',
              risk: 'Critical',
              safeVersion: null,
              classification: 'breaking',
              reason: 'Major version bump 4 → 5',
            },
          ],
        },
      },
      error: null,
    };

    const emptyResult = await generateExecutiveReportDocx(baseOpts);
    const pendingResult = await generateExecutiveReportDocx({
      ...baseOpts,
      scanBefore: scanWithPending,
    });

    expect(pendingResult.length).toBeGreaterThan(emptyResult.length);
  });
});
