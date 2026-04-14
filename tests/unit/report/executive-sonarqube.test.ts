import { describe, it, expect } from 'vitest';
import { generateExecutiveReport } from '@reporting/executive';
import type { ExecutiveReportOptions } from '@core/types/report';
import type { ScanResultJson } from '@core/types/scan';

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

describe('generateExecutiveReport — advisorResults section', () => {
  it('does NOT render advisor section when advisorResults is absent', () => {
    const report = generateExecutiveReport(baseOpts);
    expect(report).not.toContain('Advisor');
  });

  it('renders advisor section when advisorResults are provided', () => {
    const report = generateExecutiveReport({
      ...baseOpts,
      advisorResults: {
        npm: [
          {
            name: 'audit',
            command: 'npm audit',
            exitCode: 0,
            output: 'found 0 vulnerabilities',
            status: 'pass',
          },
        ],
      },
    });
    expect(report).toContain('Advisor');
    expect(report).toContain('audit');
    expect(report).toContain('found 0 vulnerabilities');
  });

  it('renders fail status for failed advisors', () => {
    const report = generateExecutiveReport({
      ...baseOpts,
      advisorResults: {
        composer: [
          {
            name: 'audit',
            command: 'composer audit',
            exitCode: 1,
            output: 'Found 2 vulnerabilities',
            status: 'fail',
          },
        ],
      },
    });
    expect(report).toContain('Advisor');
    expect(report).toContain('audit');
    expect(report).toContain('Found 2 vulnerabilities');
  });

  it('renders advisor section in en locale', () => {
    const report = generateExecutiveReport({
      ...baseOpts,
      locale: 'en',
      advisorResults: {
        npm: [
          {
            name: 'audit',
            command: 'npm audit',
            exitCode: 0,
            output: 'clean',
            status: 'pass',
          },
        ],
      },
    });
    expect(report).toContain('Advisor');
    expect(report).toContain('pass');
    expect(report).toContain('clean');
  });
});

describe('generateExecutiveReport — generic validations rendering', () => {
  it('renders all passing validation entries in evidence section', () => {
    const scanWithVulns: ScanResultJson = {
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
          auto_safe_packages: ['lodash@4.17.20'],
          breaking_packages: [],
          manual_packages: [],
          vulnerabilities: [
            {
              ghsaId: 'GHSA-1234',
              cvss: '5.0',
              package: 'lodash',
              currentVersion: '4.17.20',
              safeVersion: '4.17.21',
              ecosystem: 'npm',
              classification: 'auto_safe',
              risk: 'medium',
            },
          ],
        },
      },
      error: null,
    };

    const report = generateExecutiveReport({
      ...baseOpts,
      scanBefore: scanWithVulns,
      updates: {
        npm: {
          $schema: 'osv-update-result/v1',
          agent: 'npm-safe-update',
          status: 'success',
          packages_updated: ['lodash@4.17.21'],
          packages_skipped: [],
          packages_pending_breaking: [],
          validations: [
            { name: 'build', status: 'pass', detail: 'Build passed in 12s' },
            { name: 'lint', status: 'pass', detail: 'No lint errors' },
          ],
          error: null,
        },
      },
    });

    // Both validation names should appear
    expect(report).toContain('build');
    expect(report).toContain('lint');
    // Both details should appear
    expect(report).toContain('Build passed in 12s');
    expect(report).toContain('No lint errors');
  });
});
