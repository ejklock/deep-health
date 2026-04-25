/**
 * Branch coverage top-up for src/reporting/sonarqube-report.ts
 * Targets uncovered branches (lines 28-30, 91).
 */
import { describe, it, expect } from 'vitest';
import { generateSonarQubeHtmlReport, sonarqubeHtmlReportFilename } from '@reporting/sonarqube-report';
import type { ScanResultJson } from '@core/types/scan';

describe('generateSonarQubeHtmlReport() — branch coverage', () => {
  it('returns null when engineResults is undefined', () => {
    expect(generateSonarQubeHtmlReport(undefined, 'Client', 'Project')).toBeNull();
  });

  it('returns null when sonarqube key is absent', () => {
    expect(generateSonarQubeHtmlReport({}, 'Client', 'Project')).toBeNull();
  });

  it('returns null when status is skipped', () => {
    const result: ScanResultJson = {
      agent: 'sonarqube', status: 'skipped', environment: 'local', ecosystems: {}, error: null,
    };
    expect(generateSonarQubeHtmlReport({ sonarqube: result }, 'Client', 'Project')).toBeNull();
  });

  it('returns HTML string for error status', () => {
    const result: ScanResultJson = {
      agent: 'sonarqube', status: 'error', environment: 'local', ecosystems: {}, error: 'scan failed',
    };
    const html = generateSonarQubeHtmlReport({ sonarqube: result }, 'Client', 'Project');
    expect(typeof html).toBe('string');
    expect(html).toContain('scan failed');
  });

  it('uses default error message when error field is null on error status', () => {
    const result: ScanResultJson = {
      agent: 'sonarqube', status: 'error', environment: 'local', ecosystems: {}, error: null,
    };
    const html = generateSonarQubeHtmlReport({ sonarqube: result }, 'Client', 'Project');
    expect(html).toContain('SonarQube scan failed');
  });

  it('returns HTML string for success status with quality gate data', () => {
    const result: ScanResultJson = {
      agent: 'sonarqube',
      status: 'success',
      environment: 'local',
      ecosystems: {},
      error: null,
      metadata: {
        qualityGateStatus: 'OK',
        qualityGatePassed: true,
        qualityGateConditions: [
          { status: 'OK', metricKey: 'coverage', comparator: 'LT', errorThreshold: '80', actualValue: '90' },
          { status: 'ERROR', metricKey: 'bugs', comparator: 'GT', errorThreshold: '0', actualValue: '2' },
        ],
        metrics: { bugs: '2', coverage: '90' },
        issues: [
          {
            key: 'k1', rule: 'rule:S1', severity: 'CRITICAL',
            component: 'my-project:src/index.ts', message: 'msg', type: 'BUG', status: 'OPEN', line: 10,
          },
          {
            key: 'k2', rule: 'rule:S2', severity: 'BLOCKER',
            component: 'src/file.ts', // no colon
            message: 'blocker', type: 'BUG', status: 'OPEN',
          },
        ],
      },
    };
    const html = generateSonarQubeHtmlReport({ sonarqube: result }, 'Client', 'Project');
    expect(typeof html).toBe('string');
  });

  it('handles success with no metadata (all absent)', () => {
    const result: ScanResultJson = {
      agent: 'sonarqube', status: 'success', environment: 'local', ecosystems: {}, error: null,
    };
    const html = generateSonarQubeHtmlReport({ sonarqube: result }, 'Client', 'Project');
    expect(typeof html).toBe('string');
  });

  it('returns HTML string for success status with ERROR quality gate (covers lines 28-29)', () => {
    const result: ScanResultJson = {
      agent: 'sonarqube',
      status: 'success',
      environment: 'local',
      ecosystems: {},
      error: null,
      metadata: {
        qualityGateStatus: 'ERROR',
        qualityGatePassed: false,
        qualityGateConditions: [],
        metrics: {},
        issues: [],
      },
    };
    const html = generateSonarQubeHtmlReport({ sonarqube: result }, 'Client', 'Project');
    expect(html).toContain('qg-error');
  });

  it('returns HTML string for success status with WARN quality gate (covers line 29-30)', () => {
    const result: ScanResultJson = {
      agent: 'sonarqube',
      status: 'success',
      environment: 'local',
      ecosystems: {},
      error: null,
      metadata: {
        qualityGateStatus: 'WARN',
        qualityGatePassed: false,
        qualityGateConditions: [],
        metrics: {},
        issues: [],
      },
    };
    const html = generateSonarQubeHtmlReport({ sonarqube: result }, 'Client', 'Project');
    expect(html).toContain('qg-warn');
  });

  it('handles success with empty issues array (noIssues=true)', () => {
    const result: ScanResultJson = {
      agent: 'sonarqube', status: 'success', environment: 'local', ecosystems: {}, error: null,
      metadata: { issues: [] },
    };
    const html = generateSonarQubeHtmlReport({ sonarqube: result }, 'Client', 'Project');
    expect(typeof html).toBe('string');
  });

  it('severity MAJOR/MINOR/INFO/unknown triggers correct CSS class (lines 16-18, default)', () => {
    const result: ScanResultJson = {
      agent: 'sonarqube',
      status: 'success',
      environment: 'local',
      ecosystems: {},
      error: null,
      metadata: {
        issues: [
          { key: 'k1', rule: 'r', severity: 'MAJOR',   component: 'src/a.ts', message: 'm', type: 'BUG', status: 'OPEN' },
          { key: 'k2', rule: 'r', severity: 'MINOR',   component: 'src/b.ts', message: 'm', type: 'BUG', status: 'OPEN' },
          { key: 'k3', rule: 'r', severity: 'INFO',    component: 'src/c.ts', message: 'm', type: 'BUG', status: 'OPEN' },
          { key: 'k4', rule: 'r', severity: 'UNKNOWN', component: 'src/d.ts', message: 'm', type: 'BUG', status: 'OPEN' },
        ],
      },
    };
    const html = generateSonarQubeHtmlReport({ sonarqube: result }, 'Client', 'Project');
    expect(html).toContain('major');
    expect(html).toContain('minor');
    expect(html).toContain('info');
    expect(html).toContain('unknown');
  });

  it('condition with status != OK and != ERROR emits ⚠️ icon (line 23 third branch)', () => {
    const result: ScanResultJson = {
      agent: 'sonarqube',
      status: 'success',
      environment: 'local',
      ecosystems: {},
      error: null,
      metadata: {
        qualityGateStatus: 'WARN',
        qualityGatePassed: false,
        qualityGateConditions: [
          { status: 'WARN', metricKey: 'coverage', comparator: 'LT', errorThreshold: '80', actualValue: '70' },
        ],
        issues: [],
      },
    };
    const html = generateSonarQubeHtmlReport({ sonarqube: result }, 'Client', 'Project');
    expect(html).toContain('⚠️');
  });

  it('condition missing errorThreshold and actualValue uses "—" fallback (lines 101-102)', () => {
    const result: ScanResultJson = {
      agent: 'sonarqube',
      status: 'success',
      environment: 'local',
      ecosystems: {},
      error: null,
      metadata: {
        qualityGateStatus: 'ERROR',
        qualityGatePassed: false,
        qualityGateConditions: [
          { status: 'ERROR', metricKey: 'bugs', comparator: 'GT' } as any,
        ],
        issues: [],
      },
    };
    const html = generateSonarQubeHtmlReport({ sonarqube: result }, 'Client', 'Project');
    expect(html).toContain('—');
  });
});

describe('sonarqubeHtmlReportFilename()', () => {
  it('returns a filename containing client and project names', () => {
    const name = sonarqubeHtmlReportFilename('Acme', 'MyProject');
    expect(name).toContain('Acme');
    expect(name).toContain('MyProject');
    expect(name).toContain('.html');
  });
});
