import { describe, it, expect } from 'vitest';
import { generateConsolidatedReport } from '@reporting/consolidated';
import type { ConsolidatedReport } from '@core/types/report';

const mockReport: ConsolidatedReport = {
  projectName: 'Test Project',
  date: '2026-03-26',
  environment: 'docker',
  scan: {
    $schema: 'osv-scan-result/v1',
    agent: 'osv-scanner',
    status: 'success',
    environment: 'docker',
    ecosystems: {
      composer: {
        vulnerabilities_total: 2,
        auto_safe: 1,
        breaking: 1,
        manual: 0,
        auto_safe_packages: ['vendor/pkg@1.2.3'],
        breaking_packages: ['laravel/framework@10.0.0'],
        manual_packages: [],
        vulnerabilities: [],
      },
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
  updates: {
    npm: {
      $schema: 'osv-update-result/v1',
      agent: 'npm-safe-update',
      status: 'success',
      packages_updated: ['lodash@4.17.21'],
      packages_skipped: [],
      packages_pending_breaking: [],
      validations: [
        { name: 'build', status: 'pass', detail: 'Frontend and backend builds passed' },
      ],
      error: null,
    },
    composer: {
      $schema: 'osv-update-result/v1',
      agent: 'composer-safe-update',
      status: 'success',
      packages_updated: ['vendor/pkg@1.2.4'],
      packages_skipped: [],
      packages_pending_breaking: ['laravel/framework@10.0.0'],
      validations: [
        { name: 'tests', status: 'pass', detail: '42 tests passed, 0 failed' },
      ],
      error: null,
    },
  },
  overallStatus: 'success',
};

describe('generateConsolidatedReport', () => {
  it('includes project name', () => {
    const report = generateConsolidatedReport(mockReport);
    expect(report).toContain('Test Project');
  });

  it('includes date', () => {
    const report = generateConsolidatedReport(mockReport);
    expect(report).toContain('2026-03-26');
  });

  it('includes vulnerability totals', () => {
    const report = generateConsolidatedReport(mockReport);
    expect(report).toContain('Total');
  });

  it('lists updated npm packages', () => {
    const report = generateConsolidatedReport(mockReport);
    expect(report).toContain('lodash@4.17.21');
  });

  it('lists updated composer packages', () => {
    const report = generateConsolidatedReport(mockReport);
    expect(report).toContain('vendor/pkg@1.2.4');
  });

  it('includes pending breaking changes', () => {
    const report = generateConsolidatedReport(mockReport);
    expect(report).toContain('laravel/framework@10.0.0');
    expect(report).toContain('sim, confirmo breaking changes');
  });

  it('shows test pass status', () => {
    const report = generateConsolidatedReport(mockReport);
    expect(report).toContain('PASS');
  });

  it('renders validationDetail from canonical validations[] entries', () => {
    const report = generateConsolidatedReport(mockReport);
    // Composer detail from validations[name=tests].detail
    expect(report).toContain('42 tests passed, 0 failed');
    // npm detail from validations[name=build].detail
    expect(report).toContain('Frontend and backend builds passed');
    // The template must NOT expose raw Handlebars field lookups
    expect(report).not.toContain('update.tests_detail');
    expect(report).not.toContain('update.build_detail');
  });

  it('renders all validation entries generically (not just first)', () => {
    const reportWithMultipleValidations: ConsolidatedReport = {
      ...mockReport,
      updates: {
        ...mockReport.updates,
        npm: {
          ...mockReport.updates.npm!,
          validations: [
            { name: 'build', status: 'pass', detail: 'Build passed' },
            { name: 'lint', status: 'fail', detail: 'Lint errors found' },
            { name: 'test', status: 'pass' },
          ],
        },
      },
    };
    const report = generateConsolidatedReport(reportWithMultipleValidations);
    // All three validation names must appear
    expect(report).toContain('build');
    expect(report).toContain('lint');
    expect(report).toContain('test');
    // Details must appear
    expect(report).toContain('Build passed');
    expect(report).toContain('Lint errors found');
    // Both PASS and FAIL statuses
    expect(report).toContain('PASS');
    expect(report).toContain('FAIL');
  });

  it('renders advisor section when advisorResults are provided', () => {
    const reportWithAdvisors: ConsolidatedReport = {
      ...mockReport,
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
        composer: [
          {
            name: 'audit',
            command: 'composer audit',
            exitCode: 1,
            output: 'Found 1 vulnerability',
            status: 'fail',
          },
        ],
      },
    };
    const report = generateConsolidatedReport(reportWithAdvisors);
    // Section header
    expect(report).toContain('Advisor');
    // Advisor name
    expect(report).toContain('audit');
    // Status indicators
    expect(report).toContain('pass');
    // Advisor output
    expect(report).toContain('found 0 vulnerabilities');
    expect(report).toContain('Found 1 vulnerability');
  });

  it('does not render advisor section when advisorResults are absent', () => {
    const report = generateConsolidatedReport(mockReport);
    // Should not contain advisor section header
    expect(report).not.toContain('Advisor Analysis');
  });

  it('renders validation section without errors when validations[] has entries', () => {
    const reportWithAdditionalValidations: ConsolidatedReport = {
      ...mockReport,
      updates: {
        ...mockReport.updates,
        npm: {
          ...mockReport.updates.npm!,
          validations: [
            { name: 'build', status: 'pass', detail: 'All good' },
            { name: 'lint', status: 'skipped' },
          ],
        },
      },
    };
    const report = generateConsolidatedReport(reportWithAdditionalValidations);
    expect(report).toContain('PASS');
    expect(report).toContain('All good');
  });
});

describe('generateConsolidatedReport — branch and scanner engine metadata', () => {
  it('renders branch label when branch is provided', () => {
    const report = generateConsolidatedReport({ ...mockReport, branch: 'main' });
    expect(report).toContain('main');
    expect(report).toContain('Branch');
  });

  it('does not render branch line when branch is absent', () => {
    const report = generateConsolidatedReport(mockReport);
    expect(report).not.toContain('Branch:');
  });

  it('does not render branch line when branch is null', () => {
    const report = generateConsolidatedReport({ ...mockReport, branch: null });
    expect(report).not.toContain('Branch:');
  });

  it('renders scanner engines when scannerEngines is provided', () => {
    const report = generateConsolidatedReport({ ...mockReport, scannerEngines: ['osv', 'sonarqube'] });
    expect(report).toContain('osv, sonarqube');
    expect(report).toContain('Scanners');
  });

  it('does not render scanner engines line when scannerEngines is absent', () => {
    const report = generateConsolidatedReport(mockReport);
    expect(report).not.toContain('Scanners:');
  });

  it('does not render scanner engines line when scannerEngines is empty array', () => {
    const report = generateConsolidatedReport({ ...mockReport, scannerEngines: [] });
    expect(report).not.toContain('Scanners:');
  });

  it('renders both branch and scannerEngines when both are provided', () => {
    const report = generateConsolidatedReport({
      ...mockReport,
      branch: 'develop',
      scannerEngines: ['osv'],
    });
    expect(report).toContain('develop');
    expect(report).toContain('osv');
  });
});
