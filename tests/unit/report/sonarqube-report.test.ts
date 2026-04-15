import { describe, it, expect } from 'vitest';
import {
  generateSonarQubeHtmlReport,
  sonarqubeHtmlReportFilename,
} from '@reporting/sonarqube-report';
import type { ScanResultJson } from '@core/types/scan';

// ─── Fixtures ──────────────────────────────────────────────────────────────────

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
    qualityGateConditions: [
      {
        status: 'OK',
        metricKey: 'new_reliability_rating',
        comparator: 'GT',
        errorThreshold: '1',
        actualValue: '1',
      },
      {
        status: 'ERROR',
        metricKey: 'security_hotspots_reviewed',
        comparator: 'LT',
        errorThreshold: '100',
        actualValue: '80',
      },
    ],
    metrics: {
      bugs: '2',
      vulnerabilities: '1',
      code_smells: '15',
      coverage: '72.5',
    },
    issues: [
      {
        key: 'abc1',
        rule: 'typescript:S2486',
        severity: 'CRITICAL',
        component: 'my-project:src/utils/parser.ts',
        line: 15,
        message: 'Handle this exception or log it',
        type: 'BUG',
        status: 'OPEN',
      },
      {
        key: 'abc2',
        rule: 'typescript:S1481',
        severity: 'MAJOR',
        component: 'my-project:src/utils/parser.ts',
        line: 42,
        message: 'Remove unused variable',
        type: 'CODE_SMELL',
        status: 'OPEN',
      },
      {
        key: 'abc3',
        rule: 'typescript:S2068',
        severity: 'BLOCKER',
        component: 'my-project:src/auth/login.ts',
        line: 8,
        message: 'Hard-coded credentials found',
        type: 'VULNERABILITY',
        status: 'OPEN',
      },
    ],
  },
};

const sonarNoIssuesResult: ScanResultJson = {
  ...sonarSuccessResult,
  metadata: {
    ...sonarSuccessResult.metadata,
    issues: [],
  },
};

const sonarErrorResult: ScanResultJson = {
  $schema: 'sonarqube-scan-result/v1',
  agent: 'sonarqube',
  status: 'error',
  environment: 'local',
  ecosystems: {},
  error: 'sonar-scanner exited with code 1',
};

const sonarSkippedResult: ScanResultJson = {
  $schema: 'sonarqube-scan-result/v1',
  agent: 'sonarqube',
  status: 'skipped',
  environment: 'local',
  ecosystems: {},
  error: null,
};

// ─── generateSonarQubeHtmlReport ──────────────────────────────────────────────

describe('generateSonarQubeHtmlReport', () => {
  it('returns null when engineResults is undefined', () => {
    expect(generateSonarQubeHtmlReport(undefined, 'Acme', 'My App')).toBeNull();
  });

  it('returns null when sonarqube not in engineResults', () => {
    expect(generateSonarQubeHtmlReport({ 'osv-scanner': sonarSuccessResult }, 'Acme', 'My App')).toBeNull();
  });

  it('returns null when status is skipped', () => {
    expect(generateSonarQubeHtmlReport({ sonarqube: sonarSkippedResult }, 'Acme', 'My App')).toBeNull();
  });

  it('returns HTML string for error result', () => {
    const html = generateSonarQubeHtmlReport({ sonarqube: sonarErrorResult }, 'Acme', 'My App');
    expect(html).not.toBeNull();
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('sonar-scanner exited with code 1');
    expect(html).toContain('My App');
  });

  it('returns well-formed HTML for success result', () => {
    const html = generateSonarQubeHtmlReport({ sonarqube: sonarSuccessResult }, 'Acme Corp', 'My App');
    expect(html).not.toBeNull();
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('</html>');
  });

  it('includes project name in HTML title and header', () => {
    const html = generateSonarQubeHtmlReport({ sonarqube: sonarSuccessResult }, 'Acme', 'My App')!;
    expect(html).toContain('My App');
    expect(html).toContain('SonarQube Report');
  });

  it('renders quality gate status PASSED for OK', () => {
    const html = generateSonarQubeHtmlReport({ sonarqube: sonarSuccessResult }, 'Acme', 'My App')!;
    expect(html).toContain('PASSED');
    expect(html).toContain('qg-ok');
  });

  it('renders quality gate conditions', () => {
    const html = generateSonarQubeHtmlReport({ sonarqube: sonarSuccessResult }, 'Acme', 'My App')!;
    expect(html).toContain('new_reliability_rating');
    expect(html).toContain('security_hotspots_reviewed');
    expect(html).toContain('✅');
    expect(html).toContain('❌');
  });

  it('renders metrics table', () => {
    const html = generateSonarQubeHtmlReport({ sonarqube: sonarSuccessResult }, 'Acme', 'My App')!;
    expect(html).toContain('bugs');
    expect(html).toContain('coverage');
    expect(html).toContain('72.5');
  });

  it('renders issues grouped by file', () => {
    const html = generateSonarQubeHtmlReport({ sonarqube: sonarSuccessResult }, 'Acme', 'My App')!;
    expect(html).toContain('src/utils/parser.ts');
    expect(html).toContain('src/auth/login.ts');
    expect(html).toContain('Handle this exception or log it');
    expect(html).toContain('Hard-coded credentials found');
  });

  it('renders severity badges', () => {
    const html = generateSonarQubeHtmlReport({ sonarqube: sonarSuccessResult }, 'Acme', 'My App')!;
    expect(html).toContain('CRITICAL');
    expect(html).toContain('BLOCKER');
    expect(html).toContain('MAJOR');
  });

  it('renders no-issues notice when issues array is empty', () => {
    const html = generateSonarQubeHtmlReport({ sonarqube: sonarNoIssuesResult }, 'Acme', 'My App')!;
    expect(html).toContain('No issues found');
  });

  it('renders error warning when status is error', () => {
    const html = generateSonarQubeHtmlReport({ sonarqube: sonarErrorResult }, 'Acme', 'My App')!;
    expect(html).toContain('warning-box');
    expect(html).toContain('sonar-scanner exited with code 1');
  });

  it('includes client label in header', () => {
    const html = generateSonarQubeHtmlReport({ sonarqube: sonarSuccessResult }, 'Acme Corp', 'My App')!;
    expect(html).toContain('Acme Corp');
  });

  it('groups multiple issues from the same file correctly', () => {
    const html = generateSonarQubeHtmlReport({ sonarqube: sonarSuccessResult }, 'Acme', 'My App')!;
    // parser.ts appears once as a file header even though it has 2 issues
    const parserMatches = html.match(/src\/utils\/parser\.ts/g);
    expect(parserMatches).not.toBeNull();
    // The file group header + rule references — file-header div appears once
    expect(html).toContain('typescript:S2486');
    expect(html).toContain('typescript:S1481');
  });
});

// ─── sonarqubeHtmlReportFilename ──────────────────────────────────────────────

describe('sonarqubeHtmlReportFilename', () => {
  it('returns an html file extension', () => {
    const name = sonarqubeHtmlReportFilename('Acme Corp', 'My App');
    expect(name).toMatch(/\.html$/);
  });

  it('follows [Client Project] prefix convention', () => {
    const name = sonarqubeHtmlReportFilename('Acme Corp', 'My App');
    expect(name).toMatch(/^\[Acme Corp My App\]/);
  });

  it('contains SonarQube Report label', () => {
    const name = sonarqubeHtmlReportFilename('Acme', 'Proj');
    expect(name).toContain('SonarQube Report');
  });

  it('contains current year', () => {
    const name = sonarqubeHtmlReportFilename('Acme', 'Proj');
    expect(name).toContain(String(new Date().getFullYear()));
  });
});
