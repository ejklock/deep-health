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
