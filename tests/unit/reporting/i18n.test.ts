/**
 * Tests for src/reporting/i18n — getLocale, buildLocale
 * Covers all branches in loader.ts.
 */
import { describe, it, expect } from 'vitest';
import { getLocale } from '@reporting/i18n/index';
import { buildLocale } from '@reporting/i18n/loader';
import type { RawLocale } from '@reporting/i18n/raw-locale';

const rawEn: RawLocale = {
  months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  pkg_count: {
    one: '{{vulnCount}} vuln in {{pkgCount}} pkg ({{ecosystem}}){{namesSuffix}}',
    other: '{{vulnCount}} vulns in {{pkgCount}} pkgs ({{ecosystem}}){{namesSuffix}}',
  },
  reason: {
    no_safe_version: 'No safe version available',
    major_bump: 'Major bump to {{version}}',
    major_bump_generic: 'Major bump required',
    protected_constraint: 'Protected by constraint {{constraint}}',
  },
  status: {
    no_fix: 'No fix',
    needs_auth: 'Needs auth',
    pending: 'Pending',
  },
  exec: {
    report_title: 'Security Report',
    label_client: 'Client',
    label_project: 'Project',
    label_period: 'Period',
    section_task: 'Task',
    task_title: 'Security Audit',
    task_description: 'Description',
    section_resolution: 'Resolution',
    no_vulns: 'No vulnerabilities',
    found_and_fixed: 'Found and fixed',
    pending_intro: 'Pending',
    table_fixed_header: '| Package |',
    table_pending_header: '| Package |',
    section_evidence_before: 'Before',
    table_before_header: '| Package |',
    scan_summary: 'Found {{total}} vulns: {{ecoLabels}}',
    section_evidence_after: 'After',
    ecosystem_evidence_title: '{{ecoLabel}} — post-fix',
    table_after_header: '| Package |',
    scan_after_summary_generic: '{{total}} remaining: {{ecoLabels}}',
    tests_verified_intro: 'Tests verified',
    validation_verified: '{{validationLabel}}: {{detail}}',
    section_summary: 'Summary',
    all_fixed: 'All fixed',
    pending_needs_action_intro: 'Needs action',
    pending_manual: 'Manual',
    fixed_version: 'Fixed to {{version}}',
    sonarqube_title: 'SonarQube',
    sonarqube_quality_gate: 'Quality Gate: {{status}}',
    sonarqube_conditions: 'Conditions',
    sonarqube_metrics: 'Metrics',
    sonarqube_issues_by_file: 'Issues by File',
    sonarqube_no_issues: 'No issues',
    sonarqube_issue_count: '{{n}} issues found',
    sonarqube_skipped: 'Skipped',
    sonarqube_warning: 'Warning: {{message}}',
    advisors_title: 'Advisors',
    advisor_header: 'Advisor: {{name}}',
    advisor_pass: 'Pass',
    advisor_fail: 'Fail',
    advisor_skipped: 'Skipped',
    advisor_clean: 'Clean',
    advisor_findings: 'Findings',
    advisor_error: 'Error',
    advisor_output: 'Output: {{output}}',
    advisor_findings_label: 'Findings',
    advisor_no_findings: 'No findings',
    advisor_col_ecosystem: 'Ecosystem',
    advisor_col_advisor: 'Advisor',
    advisor_col_status: 'Status',
    advisor_col_findings: 'Findings',
    label_branch: 'Branch',
    label_scanners: 'Scanners',
  },
};

describe('getLocale()', () => {
  it('returns pt-br locale by default', () => {
    const locale = getLocale();
    expect(locale).toBeDefined();
    expect(locale.months).toHaveLength(12);
  });

  it('returns en locale when requested', () => {
    const locale = getLocale('en');
    expect(locale).toBeDefined();
    expect(typeof locale.exec.report_title).toBe('string');
  });

  it('returns pt-br locale when explicitly requested', () => {
    const locale = getLocale('pt-br');
    expect(locale).toBeDefined();
  });
});

describe('buildLocale()', () => {
  it('returns a Locale with 12 months', () => {
    const locale = buildLocale(rawEn);
    expect(locale.months).toHaveLength(12);
  });

  it('pkg_count uses "one" template when pkgCount=1', () => {
    const locale = buildLocale(rawEn);
    const result = locale.pkg_count(1, 1, 'npm');
    expect(result).toContain('1 vuln in 1 pkg');
  });

  it('pkg_count uses "other" template when pkgCount>1', () => {
    const locale = buildLocale(rawEn);
    const result = locale.pkg_count(3, 2, 'npm');
    expect(result).toContain('3 vulns in 2 pkgs');
  });

  it('pkg_count appends names suffix when names is provided', () => {
    const locale = buildLocale(rawEn);
    const result = locale.pkg_count(1, 1, 'npm', 'lodash');
    expect(result).toContain(': lodash');
  });

  it('pkg_count has no suffix when names is omitted', () => {
    const locale = buildLocale(rawEn);
    const result = locale.pkg_count(1, 1, 'npm');
    // namesSuffix should be empty
    expect(result).not.toContain(': ');
  });

  it('reason.major_bump interpolates version', () => {
    const locale = buildLocale(rawEn);
    expect(locale.reason.major_bump('2.0.0')).toContain('2.0.0');
  });

  it('reason.protected_constraint interpolates constraint', () => {
    const locale = buildLocale(rawEn);
    expect(locale.reason.protected_constraint('^1.0.0')).toContain('^1.0.0');
  });

  it('exec.scan_summary interpolates total and ecoLabels', () => {
    const locale = buildLocale(rawEn);
    const result = locale.exec.scan_summary(5, 'npm, composer');
    expect(result).toContain('5');
    expect(result).toContain('npm, composer');
  });

  it('exec.fixed_version interpolates version', () => {
    const locale = buildLocale(rawEn);
    expect(locale.exec.fixed_version('1.2.3')).toContain('1.2.3');
  });

  it('exec.sonarqube_quality_gate interpolates status', () => {
    const locale = buildLocale(rawEn);
    expect(locale.exec.sonarqube_quality_gate('OK')).toContain('OK');
  });

  it('exec.sonarqube_issue_count interpolates n', () => {
    const locale = buildLocale(rawEn);
    expect(locale.exec.sonarqube_issue_count(7)).toContain('7');
  });

  it('exec.sonarqube_warning interpolates message', () => {
    const locale = buildLocale(rawEn);
    expect(locale.exec.sonarqube_warning('scan failed')).toContain('scan failed');
  });

  it('exec.advisor_header interpolates name', () => {
    const locale = buildLocale(rawEn);
    expect(locale.exec.advisor_header('npm-audit')).toContain('npm-audit');
  });

  it('exec.advisor_output interpolates output', () => {
    const locale = buildLocale(rawEn);
    expect(locale.exec.advisor_output('some output')).toContain('some output');
  });

  it('exec.validation_verified interpolates label and detail', () => {
    const locale = buildLocale(rawEn);
    expect(locale.exec.validation_verified('tests', 'passed')).toContain('tests');
    expect(locale.exec.validation_verified('tests', 'passed')).toContain('passed');
  });
});

describe('interp ?? empty string fallback (line 5)', () => {
  it('substitutes empty string when template variable key is missing from vars', () => {
    const locale = buildLocale(rawEn);
    // pkg_count uses interp internally — if namesSuffix has a missing key via a custom raw
    // Simplest: call a function that calls interp with a missing key.
    // We can do this by directly calling buildLocale with a raw that has a template
    // referencing an undefined var key. But buildLocale calls interp with specific vars,
    // so instead use an existing function and verify the fallback fires gracefully.
    // The cleanest way: create a minimal raw with a custom template that has an unknown var.
    const rawWithUnknown = {
      ...rawEn,
      pkg_count: {
        one: '{{vulnCount}} vuln in {{unknownVar}} package',
        other: '{{vulnCount}} vulns in {{pkgCount}} packages',
      },
    };
    const loc = buildLocale(rawWithUnknown as any);
    const result = loc.pkg_count(1, 1, 'npm', null);
    // {{unknownVar}} not in vars → replaced with ''
    expect(result).toContain('1 vuln in  package');
  });
});
