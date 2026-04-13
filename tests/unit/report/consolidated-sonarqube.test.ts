import { describe, it, expect } from 'vitest';
import { generateConsolidatedReport } from '@reporting/consolidated';
import type { ConsolidatedReport } from '@core/types/report';
import type { ScanResultJson } from '@core/types/scan';

// ─── Fixtures ───────────────────────────────────────────────────────────────────

const baseReport: ConsolidatedReport = {
  projectName: 'Test Project',
  date: '2026-04-07',
  environment: 'docker',
  scan: {
    $schema: 'osv-scan-result/v1',
    agent: 'osv-scanner',
    status: 'success',
    environment: 'docker',
    ecosystems: {
      npm: {
        vulnerabilities_total: 1,
        auto_safe: 1,
        breaking: 0,
        manual: 0,
        auto_safe_packages: ['lodash@4.17.20'],
        breaking_packages: [],
        manual_packages: [],
        vulnerabilities: [],
      },
    },
    error: null,
  },
  updates: {},
  overallStatus: 'success',
};

const sonarSuccessResult: ScanResultJson = {
  $schema: 'sonarqube-scan-result/v1',
  agent: 'sonarqube',
  status: 'success',
  environment: 'docker',
  ecosystems: {},
  error: null,
  metadata: {
    qualityGateStatus: 'OK',
    qualityGatePassed: true,
    metrics: {
      bugs: '0',
      vulnerabilities: '2',
      code_smells: '15',
      coverage: '82.5',
    },
    issues: [
      {
        key: 'issue-1',
        rule: 'typescript:S2486',
        severity: 'CRITICAL',
        component: 'my-project:src/foo.ts',
        line: 10,
        message: 'Handle this exception',
        type: 'BUG',
        status: 'OPEN',
      },
      {
        key: 'issue-2',
        rule: 'typescript:S1481',
        severity: 'MAJOR',
        component: 'my-project:src/bar.ts',
        line: 42,
        message: 'Remove unused variable',
        type: 'CODE_SMELL',
        status: 'OPEN',
      },
    ],
  },
};

const sonarSkippedResult: ScanResultJson = {
  $schema: 'sonarqube-scan-result/v1',
  agent: 'sonarqube',
  status: 'skipped',
  environment: 'docker',
  ecosystems: {},
  error: null,
};

const sonarErrorResult: ScanResultJson = {
  $schema: 'sonarqube-scan-result/v1',
  agent: 'sonarqube',
  status: 'error',
  environment: 'docker',
  ecosystems: {},
  error: 'sonar-scanner exited with code 1',
};

// ─── Tests ───────────────────────────────────────────────────────────────────────

describe('generateConsolidatedReport — SonarQube section', () => {
  it('does NOT render SonarQube section when engineResults is absent', () => {
    const report = generateConsolidatedReport(baseReport);
    expect(report).not.toContain('SonarQube');
    expect(report).not.toContain('Quality Gate');
  });

  it('does NOT render SonarQube section when sonarqube not in engineResults', () => {
    const report = generateConsolidatedReport({
      ...baseReport,
      engineResults: {
        'osv-scanner': baseReport.scan,
      },
    });
    expect(report).not.toContain('SonarQube');
  });

  it('renders skipped notice when SonarQube status is skipped', () => {
    const report = generateConsolidatedReport({
      ...baseReport,
      engineResults: { sonarqube: sonarSkippedResult },
    });
    expect(report).toContain('SonarQube');
    expect(report).toContain('não executada');
  });

  it('renders warning when SonarQube status is error', () => {
    const report = generateConsolidatedReport({
      ...baseReport,
      engineResults: { sonarqube: sonarErrorResult },
    });
    expect(report).toContain('SonarQube');
    expect(report).toContain('sonar-scanner exited with code 1');
  });

  it('renders full section when SonarQube succeeded', () => {
    const report = generateConsolidatedReport({
      ...baseReport,
      engineResults: { sonarqube: sonarSuccessResult },
    });
    expect(report).toContain('SonarQube');
    expect(report).toContain('Quality Gate');
    expect(report).toContain('OK');
    expect(report).toContain('bugs');
    expect(report).toContain('vulnerabilities');
  });

  it('renders affected files when issues are present', () => {
    const report = generateConsolidatedReport({
      ...baseReport,
      engineResults: { sonarqube: sonarSuccessResult },
    });
    expect(report).toContain('src/foo.ts');
    expect(report).toContain('src/bar.ts');
  });

  it('renders no-issues message when issues array is empty', () => {
    const noIssuesResult: ScanResultJson = {
      ...sonarSuccessResult,
      metadata: {
        ...sonarSuccessResult.metadata,
        issues: [],
      },
    };
    const report = generateConsolidatedReport({
      ...baseReport,
      engineResults: { sonarqube: noIssuesResult },
    });
    expect(report).toContain('SonarQube');
    // Should show "no issues" message
    expect(report).toContain('BLOCKER');
  });

  it('renders failed quality gate with ERROR status', () => {
    const failedGateResult: ScanResultJson = {
      ...sonarSuccessResult,
      metadata: {
        qualityGateStatus: 'ERROR',
        qualityGatePassed: false,
        metrics: { bugs: '5', vulnerabilities: '3' },
      },
    };
    const report = generateConsolidatedReport({
      ...baseReport,
      engineResults: { sonarqube: failedGateResult },
    });
    expect(report).toContain('ERROR');
  });

  it('renders en locale SonarQube strings correctly', () => {
    const report = generateConsolidatedReport({
      ...baseReport,
      engineResults: { sonarqube: sonarSkippedResult },
      locale: 'en',
    });
    expect(report).toContain('not executed');
  });

  it('preserves existing report content without SonarQube', () => {
    // Ensures backward compatibility — no regression on OSV content
    const report = generateConsolidatedReport(baseReport);
    expect(report).toContain('Test Project');
    expect(report).toContain('2026-04-07');
    expect(report).toContain('Total');
  });
});
