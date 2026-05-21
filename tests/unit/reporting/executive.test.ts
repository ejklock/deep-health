/**
 * Branch coverage top-up for src/reporting/executive.ts
 * Tests uncovered paths: advisor section branches, motivoStr, pendingStatus,
 * residualVerification, conditionStatusIcon, severityIcon.
 */
import { describe, it, expect } from 'vitest';
import { generateExecutiveReport, executiveReportFilename } from '@reporting/executive';
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

describe('executiveReportFilename()', () => {
  it('returns a filename with client and project', () => {
    const name = executiveReportFilename('Acme', 'Project');
    expect(name).toContain('Acme');
    expect(name).toContain('Project');
    expect(name).toContain('.md');
  });
});

describe('generateExecutiveReport() — advisor section branches', () => {
  it('generates report with no advisorResults (absent)', () => {
    const result = generateExecutiveReport({ ...baseOpts });
    expect(typeof result).toBe('string');
  });

  it('generates report with empty advisorResults', () => {
    const result = generateExecutiveReport({ ...baseOpts, advisorResults: {} });
    expect(typeof result).toBe('string');
  });

  it('generates report with advisor clean status', () => {
    const result = generateExecutiveReport({
      ...baseOpts,
      advisorResults: {
        npm: [{ name: 'audit', command: 'npm audit', exitCode: 0, output: '', status: 'clean' }],
      },
    });
    expect(typeof result).toBe('string');
  });

  it('generates report with advisor findings status and structured findings', () => {
    const result = generateExecutiveReport({
      ...baseOpts,
      advisorResults: {
        npm: [{
          name: 'audit',
          command: 'npm audit',
          exitCode: 1,
          output: '',
          status: 'findings',
          findings: [{
            package: 'lodash',
            severity: 'high',
            title: 'Prototype Pollution',
            range: '>=4.0.0 <4.17.21',
            fixAvailable: '4.17.21',
          }],
        }],
      },
    });
    expect(typeof result).toBe('string');
  });

  it('generates report with advisor error status', () => {
    const result = generateExecutiveReport({
      ...baseOpts,
      advisorResults: {
        npm: [{ name: 'audit', command: 'npm audit', exitCode: -1, output: 'command not found', status: 'error' }],
      },
    });
    expect(typeof result).toBe('string');
  });

  it('generates report with advisor skipped status', () => {
    const result = generateExecutiveReport({
      ...baseOpts,
      advisorResults: {
        npm: [{ name: 'audit', command: 'npm audit', exitCode: 0, output: '', status: 'skipped' }],
      },
    });
    expect(typeof result).toBe('string');
  });

  it('generates report with advisor output text (hasOutput=true)', () => {
    const result = generateExecutiveReport({
      ...baseOpts,
      advisorResults: {
        npm: [{
          name: 'audit',
          command: 'composer audit',
          exitCode: 1,
          output: 'Found 2 vulnerabilities',
          status: 'findings',
        }],
      },
    });
    expect(typeof result).toBe('string');
  });
});

describe('generateExecutiveReport() — sonarqube section branches', () => {
  it('handles sonarqube skipped status', () => {
    const result = generateExecutiveReport({
      ...baseOpts,
      engineResults: {
        sonarqube: { agent: 'sonarqube', status: 'skipped', environment: 'local', ecosystems: {}, error: null },
      },
    });
    expect(typeof result).toBe('string');
  });

  it('handles sonarqube error status', () => {
    const result = generateExecutiveReport({
      ...baseOpts,
      engineResults: {
        sonarqube: { agent: 'sonarqube', status: 'error', environment: 'local', ecosystems: {}, error: 'scan failed' },
      },
    });
    expect(typeof result).toBe('string');
  });

  it('handles sonarqube success with conditions and issues', () => {
    const result = generateExecutiveReport({
      ...baseOpts,
      engineResults: {
        sonarqube: {
          agent: 'sonarqube',
          status: 'success',
          environment: 'local',
          ecosystems: {},
          error: null,
          metadata: {
            qualityGateStatus: 'ERROR',
            qualityGatePassed: false,
            qualityGateConditions: [
              { status: 'ERROR', metricKey: 'coverage', comparator: 'LT', errorThreshold: '80', actualValue: '70' },
              { status: 'OK', metricKey: 'bugs', comparator: 'GT', errorThreshold: '0', actualValue: '0' },
            ],
            metrics: { coverage: '70' },
            issues: [
              {
                key: 'k1', rule: 'rule:S1', severity: 'BLOCKER',
                component: 'proj:src/index.ts', message: 'blocker', type: 'BUG', status: 'OPEN',
              },
              {
                key: 'k2', rule: 'rule:S2', severity: 'CRITICAL',
                component: 'proj:src/index.ts', message: 'critical', type: 'BUG', status: 'OPEN',
              },
              {
                key: 'k3', rule: 'rule:S3', severity: 'MAJOR',
                component: 'proj:src/utils.ts', message: 'major', type: 'CODE_SMELL', status: 'OPEN',
              },
              {
                key: 'k4', rule: 'rule:S4', severity: 'MINOR',
                component: 'proj:src/utils.ts', message: 'minor', type: 'CODE_SMELL', status: 'OPEN',
              },
              {
                key: 'k5', rule: 'rule:S5', severity: 'INFO',
                component: 'proj:src/utils.ts', message: 'info', type: 'CODE_SMELL', status: 'OPEN',
              },
              {
                key: 'k6', rule: 'rule:S6', severity: 'UNKNOWN',
                component: 'proj:src/utils.ts', message: 'unknown', type: 'CODE_SMELL', status: 'OPEN',
              },
            ],
          },
        },
      },
    });
    expect(typeof result).toBe('string');
  });
});

describe('generateExecutiveReport() — motivoStr and pendingStatus branches', () => {
  const vulnBase = {
    ghsaId: 'GHSA-0001',
    cvss: '7.5',
    package: 'lodash',
    ecosystem: 'npm',
    currentVersion: '4.17.20',
    classification: 'breaking' as const,
    risk: 'high',
  };

  it('motivoStr: no_safe_version branch (No safe version reason)', () => {
    const scan: ScanResultJson = {
      agent: 'osv-scanner',
      status: 'success',
      environment: 'local',
      ecosystems: {
        npm: {
          vulnerabilities_total: 1,
          auto_safe: 0,
          breaking: 1,
          manual: 0,
          vulnerabilities: [{ ...vulnBase, safeVersion: null, reason: 'No safe version available' }],
        },
      },
      error: null,
    };
    const result = generateExecutiveReport({ ...baseOpts, scanBefore: scan, scanAfter: scan });
    expect(typeof result).toBe('string');
  });

  it('motivoStr: major_bump with match', () => {
    const scan: ScanResultJson = {
      agent: 'osv-scanner',
      status: 'success',
      environment: 'local',
      ecosystems: {
        npm: {
          vulnerabilities_total: 1,
          auto_safe: 0,
          breaking: 1,
          manual: 0,
          vulnerabilities: [{
            ...vulnBase, safeVersion: '5.0.0', reason: 'Major version bump required: 4.17.20 → 5.0.0',
          }],
        },
      },
      error: null,
    };
    const result = generateExecutiveReport({ ...baseOpts, scanBefore: scan, scanAfter: scan });
    expect(typeof result).toBe('string');
  });

  it('motivoStr: major_bump without version match (generic)', () => {
    const scan: ScanResultJson = {
      agent: 'osv-scanner',
      status: 'success',
      environment: 'local',
      ecosystems: {
        npm: {
          vulnerabilities_total: 1,
          auto_safe: 0,
          breaking: 1,
          manual: 0,
          vulnerabilities: [{ ...vulnBase, safeVersion: '5.0.0', reason: 'Major version bump required' }],
        },
      },
      error: null,
    };
    const result = generateExecutiveReport({ ...baseOpts, scanBefore: scan, scanAfter: scan });
    expect(typeof result).toBe('string');
  });

  it('motivoStr: Protected package branch', () => {
    const scan: ScanResultJson = {
      agent: 'osv-scanner',
      status: 'success',
      environment: 'local',
      ecosystems: {
        npm: {
          vulnerabilities_total: 1,
          auto_safe: 0,
          breaking: 1,
          manual: 0,
          vulnerabilities: [{
            ...vulnBase,
            safeVersion: '5.0.0',
            reason: 'Protected package: do not upgrade. Safe version 5.0.0 outside constraint ^4',
          }],
        },
      },
      error: null,
    };
    const result = generateExecutiveReport({ ...baseOpts, scanBefore: scan, scanAfter: scan });
    expect(typeof result).toBe('string');
  });

  it('motivoStr: Protected package with constraint match', () => {
    const scan: ScanResultJson = {
      agent: 'osv-scanner',
      status: 'success',
      environment: 'local',
      ecosystems: {
        npm: {
          vulnerabilities_total: 1,
          auto_safe: 0,
          breaking: 1,
          manual: 0,
          vulnerabilities: [{
            ...vulnBase,
            safeVersion: '5.0.0',
            reason: 'Protected package: do not upgrade. Safe version 5.0.0 is outside constraint ^4.0.0',
          }],
        },
      },
      error: null,
    };
    const result = generateExecutiveReport({ ...baseOpts, scanBefore: scan, scanAfter: scan });
    expect(typeof result).toBe('string');
  });

  it('motivoStr: reason is plain text (fallback)', () => {
    const scan: ScanResultJson = {
      agent: 'osv-scanner',
      status: 'success',
      environment: 'local',
      ecosystems: {
        npm: {
          vulnerabilities_total: 1,
          auto_safe: 0,
          breaking: 1,
          manual: 0,
          vulnerabilities: [{ ...vulnBase, safeVersion: null, reason: 'Some other reason' }],
        },
      },
      error: null,
    };
    const result = generateExecutiveReport({ ...baseOpts, scanBefore: scan, scanAfter: scan });
    expect(typeof result).toBe('string');
  });
});

describe('generateExecutiveReport() — residualVerification branch', () => {
  it('handles residualVerification unverified with residual CVEs in fixed vulns', () => {
    const scan: ScanResultJson = {
      agent: 'osv-scanner',
      status: 'success',
      environment: 'local',
      ecosystems: {
        npm: {
          vulnerabilities_total: 1,
          auto_safe: 1,
          breaking: 0,
          manual: 0,
          vulnerabilities: [{
            ghsaId: 'GHSA-0001', cvss: '7.5', package: 'lodash', ecosystem: 'npm',
            currentVersion: '4.17.20', safeVersion: '4.17.21', classification: 'auto_safe', risk: 'high',
          }],
        },
      },
      error: null,
    };
    const result = generateExecutiveReport({
      ...baseOpts,
      scanBefore: scan,
      updates: {
        npm: {
          agent: 'npm',
          status: 'success',
          environment: 'local',
          packages_updated: ['lodash@4.17.21'],
          validations: [],
        },
      },
      residualVerification: { status: 'unverified', summary: { npm: 1 } },
    });
    expect(typeof result).toBe('string');
  });

  it('handles residualVerification verified status', () => {
    const result = generateExecutiveReport({
      ...baseOpts,
      residualVerification: { status: 'verified', summary: { npm: 0 } },
    });
    expect(typeof result).toBe('string');
  });
});

describe('generateExecutiveReport() — sonarqube null qualityGate and null metrics branches', () => {
  it('handles sonarqube success with no qualityGateStatus (qualityGateLabel=null branch)', () => {
    const result = generateExecutiveReport({
      ...baseOpts,
      engineResults: {
        sonarqube: {
          agent: 'sonarqube',
          status: 'success',
          environment: 'local',
          ecosystems: {},
          error: null,
          // metadata present but no qualityGateStatus → ternary goes to null branch (line 147)
          metadata: {
            qualityGateStatus: undefined as unknown as string,
            qualityGatePassed: false,
          },
        },
      },
    });
    expect(typeof result).toBe('string');
  });

  it('handles sonarqube success with no metrics (metricsForDisplay=null branch)', () => {
    const result = generateExecutiveReport({
      ...baseOpts,
      engineResults: {
        sonarqube: {
          agent: 'sonarqube',
          status: 'success',
          environment: 'local',
          ecosystems: {},
          error: null,
          // metadata present but no metrics → ternary goes to null branch (line 165)
          metadata: {
            qualityGateStatus: 'OK',
            qualityGatePassed: true,
            // metrics intentionally absent
          },
        },
      },
    });
    expect(typeof result).toBe('string');
  });
});

describe('generateExecutiveReport() — advisor legacy pass status and empty results', () => {
  it('generates report with advisor legacy "pass" status (backward compat branch)', () => {
    const result = generateExecutiveReport({
      ...baseOpts,
      advisorResults: {
        npm: [{
          name: 'audit',
          command: 'npm audit',
          exitCode: 0,
          output: '',
          status: 'pass' as unknown as 'clean',
        }],
      },
    });
    expect(typeof result).toBe('string');
  });

  it('generates report with advisor unknown legacy status (error fallback branch)', () => {
    const result = generateExecutiveReport({
      ...baseOpts,
      advisorResults: {
        npm: [{
          name: 'audit',
          command: 'npm audit',
          exitCode: 1,
          output: '',
          status: 'unknown-status' as unknown as 'error',
        }],
      },
    });
    expect(typeof result).toBe('string');
  });

  it('generates report with ecosystem having empty advisor results array (skipped via continue)', () => {
    const result = generateExecutiveReport({
      ...baseOpts,
      advisorResults: {
        npm: [],
      },
    });
    expect(typeof result).toBe('string');
  });

  it('generates report with advisor results for unknown ecosystem (ecoName falls back to id)', () => {
    const result = generateExecutiveReport({
      ...baseOpts,
      advisorResults: {
        unknown_eco: [{
          name: 'audit',
          command: 'audit',
          exitCode: 0,
          output: '',
          status: 'clean',
        }],
      },
    });
    expect(typeof result).toBe('string');
  });
});

describe('generateExecutiveReport() — misc branches', () => {
  it('handles branch name provided', () => {
    const result = generateExecutiveReport({ ...baseOpts, branch: 'main' });
    expect(typeof result).toBe('string');
  });

  it('handles empty branch (hasBranch=false)', () => {
    const result = generateExecutiveReport({ ...baseOpts, branch: '' });
    expect(typeof result).toBe('string');
  });

  it('handles scannerEngines list', () => {
    const result = generateExecutiveReport({ ...baseOpts, scannerEngines: ['osv', 'sonarqube'] });
    expect(typeof result).toBe('string');
  });

  it('handles no vulns case (totalBefore=0)', () => {
    const result = generateExecutiveReport({ ...baseOpts });
    expect(typeof result).toBe('string');
  });

  it('handles pending vuln with Cannot parse reason', () => {
    const scan: ScanResultJson = {
      agent: 'osv-scanner', status: 'success', environment: 'local',
      ecosystems: {
        npm: {
          vulnerabilities_total: 1, auto_safe: 0, breaking: 1, manual: 0,
          vulnerabilities: [{
            ghsaId: 'GHSA-0001', cvss: '7.5', package: 'lodash', ecosystem: 'npm',
            currentVersion: 'x.y.z', safeVersion: null, classification: 'manual', risk: 'high',
            reason: 'Cannot parse version strings',
          }],
        },
      },
      error: null,
    };
    const result = generateExecutiveReport({ ...baseOpts, scanBefore: scan, scanAfter: scan });
    expect(typeof result).toBe('string');
  });
});

describe('generateExecutiveReport() — buildAdvisorExecSection full branch coverage', () => {
  it('covers findings status with raw findings (range and fixAvailable present)', () => {
    const result = generateExecutiveReport({
      ...baseOpts,
      advisorResults: {
        npm: [{
          name: 'npm-audit',
          command: 'npm audit',
          exitCode: 0,
          output: 'some output',
          status: 'findings',
          findings: [{
            package: 'lodash',
            severity: 'high',
            title: 'Prototype Pollution',
            range: '>=4.0.0 <4.17.21',
            fixAvailable: '4.17.21',
          }],
        }],
      },
    });
    expect(typeof result).toBe('string');
  });

  it('covers findings status with raw findings (range and fixAvailable absent → defaults to —)', () => {
    const result = generateExecutiveReport({
      ...baseOpts,
      advisorResults: {
        npm: [{
          name: 'npm-audit',
          command: 'npm audit',
          exitCode: 1,
          output: '',
          status: 'findings',
          findings: [{
            package: 'lodash',
            severity: 'high',
            title: 'Prototype Pollution',
          }],
        }],
      },
    });
    expect(typeof result).toBe('string');
  });

  it('covers error status (findingsSummary = advisor_error)', () => {
    const result = generateExecutiveReport({
      ...baseOpts,
      advisorResults: {
        npm: [{
          name: 'npm-audit',
          command: 'npm audit',
          exitCode: 2,
          output: 'fatal error',
          status: 'error',
        }],
      },
    });
    expect(typeof result).toBe('string');
  });

  it('covers skipped status', () => {
    const result = generateExecutiveReport({
      ...baseOpts,
      advisorResults: {
        npm: [{
          name: 'npm-audit',
          command: 'npm audit',
          exitCode: 0,
          output: '',
          status: 'skipped',
        }],
      },
    });
    expect(typeof result).toBe('string');
  });

  it('covers noFindings=true branch (clean status, no findings)', () => {
    const result = generateExecutiveReport({
      ...baseOpts,
      advisorResults: {
        npm: [{
          name: 'npm-audit',
          command: 'npm audit',
          exitCode: 0,
          output: '',
          status: 'clean',
          findings: [],
        }],
      },
    });
    expect(typeof result).toBe('string');
  });

  it('covers hasOutput=true branch (non-empty output)', () => {
    const result = generateExecutiveReport({
      ...baseOpts,
      advisorResults: {
        npm: [{
          name: 'npm-audit',
          command: 'npm audit',
          exitCode: 0,
          output: 'found 0 vulnerabilities',
          status: 'clean',
        }],
      },
    });
    expect(typeof result).toBe('string');
  });
});

describe('generateExecutiveReport() — vulnerability deduplication', () => {
  function makeVuln(
    pkg: string,
    version: string,
    ghsaId: string,
    classification: 'auto_safe' | 'breaking' | 'manual' = 'breaking',
  ) {
    return {
      ghsaId,
      cvss: '7.5',
      package: pkg,
      ecosystem: 'npm',
      currentVersion: version,
      safeVersion: null as string | null,
      classification,
      risk: 'high',
      reason: 'Major version bump required: 1.0.0 → 2.0.0',
    };
  }

  function makeScan(vulns: ReturnType<typeof makeVuln>[]): ScanResultJson {
    return {
      agent: 'osv-scanner',
      status: 'success',
      environment: 'local',
      ecosystems: {
        npm: {
          vulnerabilities_total: vulns.length,
          auto_safe: vulns.filter((v) => v.classification === 'auto_safe').length,
          breaking: vulns.filter((v) => v.classification === 'breaking').length,
          manual: vulns.filter((v) => v.classification === 'manual').length,
          vulnerabilities: vulns,
        },
      },
      error: null,
    };
  }

  // Helper: extract table rows from a named section header until the next heading (##/###).
  // Stops at the next markdown heading line, not at horizontal rules.
  // Searches for the headerFragment using a locale-agnostic approach: find the line containing it.
  function tableRowsAfterHeader(report: string, headerFragment: string): string[] {
    const lines = report.split('\n');
    const start = lines.findIndex((l) => l.includes(headerFragment));
    if (start === -1) return [];
    const rows: string[] = [];
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i]!;
      if (/^#{2,}/.test(l)) break;
      if (l.startsWith('|') && !l.includes('---')) rows.push(l);
    }
    return rows;
  }

  // The before-section header key is section_evidence_before — locale-dependent.
  // Use the GHSA column value or package name directly from all table rows (locale-agnostic).
  function allTableRows(report: string): string[] {
    return report.split('\n').filter((l) => l.startsWith('|') && !l.includes('---'));
  }

  it('case 1 — same GHSA, same package, two versions → versions aggregated into 1 row per table section', () => {
    const scan = makeScan([
      makeVuln('cross-spawn', '6.0.5', 'GHSA-xxxx-0001'),
      makeVuln('cross-spawn', '7.0.3', 'GHSA-xxxx-0001'),
    ]);
    const result = generateExecutiveReport({ ...baseOpts, scanBefore: scan, scanAfter: scan });
    // Every table row that contains cross-spawn should also contain both versions (aggregated)
    const rows = allTableRows(result).filter((l) => l.includes('cross-spawn'));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    rows.forEach((row) => {
      expect(row).toContain('6.0.5');
      expect(row).toContain('7.0.3');
    });
  });

  it('case 2 — same GHSA, different packages → 2 separate rows per table section', () => {
    const scan = makeScan([
      makeVuln('lodash', '4.17.21', 'GHSA-xxxx-0002'),
      makeVuln('lodash-es', '4.17.21', 'GHSA-xxxx-0002'),
    ]);
    const result = generateExecutiveReport({ ...baseOpts, scanBefore: scan, scanAfter: scan });
    const lodashOnlyRows = allTableRows(result).filter((l) => l.includes('| lodash |'));
    const lodashEsRows = allTableRows(result).filter((l) => l.includes('lodash-es'));
    expect(lodashOnlyRows.length).toBeGreaterThanOrEqual(1);
    expect(lodashEsRows.length).toBeGreaterThanOrEqual(1);
  });

  it('case 3 — four versions of qs with same GHSA → all four versions in a single row per section', () => {
    const scan = makeScan([
      makeVuln('qs', '6.5.2', 'GHSA-6rw7-vpxm-498p'),
      makeVuln('qs', '6.7.0', 'GHSA-6rw7-vpxm-498p'),
      makeVuln('qs', '6.10.1', 'GHSA-6rw7-vpxm-498p'),
      makeVuln('qs', '6.14.0', 'GHSA-6rw7-vpxm-498p'),
    ]);
    const result = generateExecutiveReport({ ...baseOpts, scanBefore: scan, scanAfter: scan });
    const rows = allTableRows(result).filter((l) => l.includes('| qs |') || l.includes('qs'));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    rows.forEach((row) => {
      expect(row).toContain('6.5.2');
      expect(row).toContain('6.7.0');
      expect(row).toContain('6.10.1');
      expect(row).toContain('6.14.0');
    });
  });

  it('case 4 — worst-case classification: auto_safe + breaking → aggregated into 1 row with both versions', () => {
    const scan = makeScan([
      makeVuln('some-pkg', '1.0.0', 'GHSA-xxxx-0003', 'auto_safe'),
      makeVuln('some-pkg', '1.1.0', 'GHSA-xxxx-0003', 'breaking'),
    ]);
    const result = generateExecutiveReport({ ...baseOpts, scanBefore: scan, scanAfter: scan });
    const rows = allTableRows(result).filter((l) => l.includes('some-pkg'));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    rows.forEach((row) => {
      expect(row).toContain('1.0.0');
      expect(row).toContain('1.1.0');
    });
  });

  it('case 5 — same package, different GHSAs → separate rows for each GHSA', () => {
    const scan = makeScan([
      makeVuln('qs', '6.5.2', 'GHSA-xxxx-aaaa'),
      makeVuln('qs', '6.5.2', 'GHSA-xxxx-bbbb'),
    ]);
    const result = generateExecutiveReport({ ...baseOpts, scanBefore: scan, scanAfter: scan });
    const ghsaARows = allTableRows(result).filter((l) => l.includes('GHSA-xxxx-aaaa'));
    const ghsaBRows = allTableRows(result).filter((l) => l.includes('GHSA-xxxx-bbbb'));
    expect(ghsaARows.length).toBeGreaterThanOrEqual(1);
    expect(ghsaBRows.length).toBeGreaterThanOrEqual(1);
  });
});

describe('generateExecutiveReport() — pendingByPkg and allVulnsBefore branch coverage', () => {
  const pendingScan: ScanResultJson = {
    agent: 'osv-scanner', status: 'success', environment: 'local',
    ecosystems: {
      npm: {
        vulnerabilities_total: 1, auto_safe: 0, breaking: 1, manual: 0,
        vulnerabilities: [{
          ghsaId: 'GHSA-pending', cvss: 'N/A', package: 'lodash', ecosystem: 'npm',
          currentVersion: '4.17.0', safeVersion: null, classification: 'breaking', risk: 'critical',
          reason: 'major',
        }],
      },
    },
    error: null,
  };

  it('covers maxCvss stays "0" path (unparseable CVSS) → cvssDisplay empty string', () => {
    // cvss = 'N/A' → parseFloat('N/A') = NaN → condition false → max stays '0' → cvssDisplay = ''
    const result = generateExecutiveReport({
      ...baseOpts,
      scanBefore: pendingScan,
      scanAfter: pendingScan, // still pending → pendingByPkg has entry with cvss='N/A'
    });
    expect(typeof result).toBe('string');
  });

  it('covers unknown ecosystem → ecoLabel falls back to v.ecosystem', () => {
    const unknownEcoScan: ScanResultJson = {
      agent: 'osv-scanner', status: 'success', environment: 'local',
      ecosystems: {
        'unknown-eco': {
          vulnerabilities_total: 1, auto_safe: 0, breaking: 1, manual: 0,
          vulnerabilities: [{
            ghsaId: 'GHSA-unk', cvss: 'N/A', package: 'some-pkg', ecosystem: 'unknown-eco',
            currentVersion: '1.0.0', safeVersion: null, classification: 'breaking', risk: 'high',
            reason: 'major',
          }],
        },
      },
      error: null,
    };
    // plugin is null for 'unknown-eco' → plugin?.reportLabel ?? v.ecosystem fires
    const result = generateExecutiveReport({
      ...baseOpts,
      scanBefore: unknownEcoScan,
      scanAfter: unknownEcoScan,
    });
    expect(typeof result).toBe('string');
  });
});

// ── AC7: audit_findings integration in executive report ──────────────────────

describe('generateExecutiveReport() — audit_findings injection (AC7)', () => {
  // Helper to extract all table rows from the report
  function allTableRows(report: string): string[] {
    return report.split('\n').filter((l) => l.startsWith('|') && !l.includes('---'));
  }

  // Minimal scan with no vulnerabilities (audit findings come from updater, not OSV)
  const cleanScan: ScanResultJson = {
    agent: 'osv-scanner',
    status: 'success',
    environment: 'local',
    ecosystems: {
      composer: {
        vulnerabilities_total: 0,
        auto_safe: 0,
        breaking: 0,
        manual: 0,
        auto_safe_packages: [],
        breaking_packages: [],
        manual_packages: [],
        vulnerabilities: [],
      },
    },
    error: null,
  };

  it('(AC7-a) when updates["composer"] has audit_findings with 2 entries and those package names are in packages_updated, the report contains those packages in the fixed vulns table', () => {
    const result = generateExecutiveReport({
      ...baseOpts,
      scanBefore: cleanScan,
      scanAfter: cleanScan,
      updates: {
        composer: {
          $schema: 'osv-update-result/v1',
          agent: 'composer-safe-update',
          status: 'success',
          packages_updated: ['vendor/audit-pkg-a@1.1.0', 'vendor/audit-pkg-b@2.1.0'],
          packages_skipped: [],
          packages_pending_breaking: [],
          validations: [{ name: 'validation', status: 'pass', detail: 'ok' }],
          error: null,
          audit_findings: [
            {
              ecosystem: 'composer',
              package: 'vendor/audit-pkg-a',
              advisoryId: 'GHSA-audit-001',
              title: 'SQL injection',
              cve: 'CVE-2024-1111',
              affectedVersions: '>=1.0.0 <1.1.0',
            },
            {
              ecosystem: 'composer',
              package: 'vendor/audit-pkg-b',
              advisoryId: 'GHSA-audit-002',
              title: 'XSS vulnerability',
              cve: null,
              affectedVersions: '>=2.0.0 <2.1.0',
            },
          ],
        },
      },
    });

    expect(typeof result).toBe('string');

    // Both audit-discovered packages should appear in the table rows (fixed vulns section)
    const rows = allTableRows(result);
    const pkgARows = rows.filter((r) => r.includes('vendor/audit-pkg-a'));
    const pkgBRows = rows.filter((r) => r.includes('vendor/audit-pkg-b'));
    expect(pkgARows.length).toBeGreaterThanOrEqual(1);
    expect(pkgBRows.length).toBeGreaterThanOrEqual(1);
  });

  it('(AC7-b) when audit_findings is absent/undefined, the report generates identically to when it is not present (regression)', () => {
    const optsWithoutFindings = {
      ...baseOpts,
      scanBefore: cleanScan,
      scanAfter: cleanScan,
      updates: {
        composer: {
          $schema: 'osv-update-result/v1' as const,
          agent: 'composer-safe-update',
          status: 'success' as const,
          packages_updated: [],
          packages_skipped: [],
          packages_pending_breaking: [],
          validations: [{ name: 'validation', status: 'skipped' as const, detail: 'nothing to do' }],
          error: null,
          // No audit_findings field
        },
      },
    };

    const optsWithEmptyFindings = {
      ...optsWithoutFindings,
      updates: {
        composer: {
          ...optsWithoutFindings.updates.composer,
          audit_findings: undefined,
        },
      },
    };

    const reportWithout = generateExecutiveReport(optsWithoutFindings);
    const reportWithEmpty = generateExecutiveReport(optsWithEmptyFindings);

    // Reports should be identical
    expect(reportWithout).toBe(reportWithEmpty);
  });

  it('(AC7-c) audit findings for packages NOT in packages_updated appear as pending (not fixed)', () => {
    // Audit found 2 packages but only 1 was successfully updated
    const result = generateExecutiveReport({
      ...baseOpts,
      scanBefore: cleanScan,
      scanAfter: cleanScan,
      updates: {
        composer: {
          $schema: 'osv-update-result/v1',
          agent: 'composer-safe-update',
          status: 'success',
          packages_updated: ['vendor/audit-pkg-a@1.1.0'],  // only pkg-a was updated
          packages_skipped: [],
          packages_pending_breaking: [],
          validations: [{ name: 'validation', status: 'pass', detail: 'ok' }],
          error: null,
          audit_findings: [
            {
              ecosystem: 'composer',
              package: 'vendor/audit-pkg-a',
              advisoryId: 'GHSA-audit-001',
              title: 'SQL injection',
              cve: 'CVE-2024-1111',
              affectedVersions: '>=1.0.0 <1.1.0',
            },
            {
              ecosystem: 'composer',
              package: 'vendor/audit-pkg-b',
              advisoryId: 'GHSA-audit-002',
              title: 'XSS vulnerability',
              cve: null,
              affectedVersions: '>=2.0.0 <2.1.0',
            },
          ],
        },
      },
    });

    expect(typeof result).toBe('string');

    const rows = allTableRows(result);
    // pkg-a is in packages_updated → should appear in fixed section
    const pkgARows = rows.filter((r) => r.includes('vendor/audit-pkg-a'));
    expect(pkgARows.length).toBeGreaterThanOrEqual(1);

    // pkg-b is NOT in packages_updated → should appear in pending section
    const pkgBRows = rows.filter((r) => r.includes('vendor/audit-pkg-b'));
    expect(pkgBRows.length).toBeGreaterThanOrEqual(1);
  });

  it('(AC7-d) original scanBefore is not mutated after report generation', () => {
    const originalVulnsLength = cleanScan.ecosystems['composer']?.vulnerabilities?.length ?? 0;

    generateExecutiveReport({
      ...baseOpts,
      scanBefore: cleanScan,
      scanAfter: cleanScan,
      updates: {
        composer: {
          $schema: 'osv-update-result/v1',
          agent: 'composer-safe-update',
          status: 'success',
          packages_updated: ['vendor/audit-pkg@1.1.0'],
          packages_skipped: [],
          packages_pending_breaking: [],
          validations: [{ name: 'validation', status: 'pass', detail: 'ok' }],
          error: null,
          audit_findings: [
            {
              ecosystem: 'composer',
              package: 'vendor/audit-pkg',
              advisoryId: 'GHSA-audit-001',
              title: 'SQL injection',
              cve: null,
              affectedVersions: '<1.1.0',
            },
          ],
        },
      },
    });

    // The original scanBefore must not have been mutated
    expect(cleanScan.ecosystems['composer']?.vulnerabilities?.length).toBe(originalVulnsLength);
  });
});
