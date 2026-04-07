import { describe, it, expect } from 'vitest';
import { generateExecutiveReport } from '../../../src/report/executive.js';
import type { ExecutiveReportOptions } from '../../../src/types/report.js';
import type { ScanResultJson } from '../../../src/types/scan.js';

// ─── Fixtures ───────────────────────────────────────────────────────────────────

const emptyScan: ScanResultJson = {
  $schema: 'osv-scan-result/v1',
  agent: 'osv-scanner',
  status: 'success',
  environment: 'local',
  ecosystems: {},
  error: null,
};

const baseOpts: ExecutiveReportOptions = {
  client: 'Acme Corp',
  project: 'My App',
  scanBefore: emptyScan,
  scanAfter: emptyScan,
  updates: {},
};

const sonarSuccessResult: ScanResultJson = {
  $schema: 'sonarqube-scan-result/v1',
  agent: 'sonarqube',
  status: 'success',
  environment: 'local',
  ecosystems: {},
  error: null,
  metadata: {
    qualityGateStatus: 'OK',
    qualityGatePassed: true,
    metrics: {
      bugs: '1',
      vulnerabilities: '0',
      coverage: '75.0',
    },
  },
};

const sonarSkippedResult: ScanResultJson = {
  $schema: 'sonarqube-scan-result/v1',
  agent: 'sonarqube',
  status: 'skipped',
  environment: 'local',
  ecosystems: {},
  error: null,
};

const sonarErrorResult: ScanResultJson = {
  $schema: 'sonarqube-scan-result/v1',
  agent: 'sonarqube',
  status: 'error',
  environment: 'local',
  ecosystems: {},
  error: 'Quality gate failed: new vulnerabilities detected',
};

// ─── Tests ───────────────────────────────────────────────────────────────────────

describe('generateExecutiveReport — SonarQube section', () => {
  it('does NOT render SonarQube section when engineResults is absent', () => {
    const report = generateExecutiveReport(baseOpts);
    expect(report).not.toContain('SonarQube');
    expect(report).not.toContain('Quality Gate');
  });

  it('does NOT render SonarQube section when sonarqube not in engineResults', () => {
    const report = generateExecutiveReport({
      ...baseOpts,
      engineResults: { 'osv-scanner': emptyScan },
    });
    expect(report).not.toContain('SonarQube');
  });

  it('renders skipped notice when SonarQube status is skipped', () => {
    const report = generateExecutiveReport({
      ...baseOpts,
      engineResults: { sonarqube: sonarSkippedResult },
    });
    expect(report).toContain('SonarQube');
    expect(report).toContain('não executada');
  });

  it('renders error warning when SonarQube status is error', () => {
    const report = generateExecutiveReport({
      ...baseOpts,
      engineResults: { sonarqube: sonarErrorResult },
    });
    expect(report).toContain('SonarQube');
    expect(report).toContain('Quality gate failed');
  });

  it('renders quality gate and metrics when SonarQube succeeded', () => {
    const report = generateExecutiveReport({
      ...baseOpts,
      engineResults: { sonarqube: sonarSuccessResult },
    });
    expect(report).toContain('SonarQube');
    expect(report).toContain('Quality Gate');
    expect(report).toContain('OK');
    expect(report).toContain('bugs');
    expect(report).toContain('coverage');
  });

  it('renders en locale SonarQube strings correctly', () => {
    const report = generateExecutiveReport({
      ...baseOpts,
      engineResults: { sonarqube: sonarSkippedResult },
      locale: 'en',
    });
    expect(report).toContain('SonarQube');
    expect(report).toContain('not executed');
  });

  it('preserves core executive report content regardless of SonarQube', () => {
    const report = generateExecutiveReport(baseOpts);
    expect(report).toContain('Acme Corp');
    expect(report).toContain('My App');
    expect(report).toContain('Nenhuma vulnerabilidade');
  });
});
