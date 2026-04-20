/** Shape of a locale JSON file. All dynamic strings use {{varName}} placeholders. */
export interface RawLocale {
  months: [string, string, string, string, string, string, string, string, string, string, string, string];
  pkg_count: {
    one: string;   // vars: vulnCount, ecosystem, pkgCount, namesSuffix
    other: string; // vars: vulnCount, ecosystem, pkgCount
  };
  reason: {
    no_safe_version: string;
    major_bump: string;         // vars: version
    major_bump_generic: string;
    protected_constraint: string; // vars: constraint
  };
  status: {
    no_fix: string;
    needs_auth: string;
    pending: string;
  };
  exec: {
    label_client: string;
    label_project: string;
    label_period: string;
    section_task: string;
    task_title: string;
    task_description: string;
    section_resolution: string;
    no_vulns: string;
    found_and_fixed: string;
    pending_intro: string;
    table_fixed_header: string;
    table_pending_header: string;
    section_evidence_before: string;
    table_before_header: string;
    /** vars: total, ecoLabels */
    scan_summary: string;
    section_evidence_after: string;
    /** vars: ecoLabel — e.g. "PHP/Composer (composer.lock) — post-fix scan summary:" */
    ecosystem_evidence_title: string;
    table_after_header: string;
    /** vars: total, ecoLabels */
    scan_after_summary_generic: string;
    tests_verified_intro: string;
    /** vars: validationLabel, detail */
    validation_verified: string;
    section_summary: string;
    all_fixed: string;
    pending_needs_action_intro: string;
    pending_manual: string;
    fixed_version: string;        // vars: version
    /** SonarQube executive section */
    sonarqube_section: string;
    sonarqube_quality_gate: string;    // vars: status
    sonarqube_conditions: string;
    sonarqube_metrics: string;
    sonarqube_issues_by_file: string;
    sonarqube_no_issues: string;
    sonarqube_issue_count: string;     // vars: n
    sonarqube_skipped: string;
    sonarqube_warning: string;         // vars: message
    /** Advisors section header */
    advisors_section: string;
    /** vars: name — advisor name, e.g. "audit" */
    advisor_header: string;            // vars: name
    /** @deprecated retained for backward compat; use advisor_clean/findings/error/skipped */
    advisor_pass: string;
    /** @deprecated retained for backward compat; use advisor_clean/findings/error/skipped */
    advisor_fail: string;
    advisor_skipped: string;
    advisor_clean: string;
    advisor_findings: string;
    advisor_error: string;
    /** vars: output — truncated advisor output */
    advisor_output: string;            // vars: output
    advisor_findings_label: string;
    advisor_no_findings: string;
    /** Advisor overview table column headers */
    advisor_col_ecosystem: string;
    advisor_col_advisor: string;
    advisor_col_status: string;
    advisor_col_findings: string;
    /** Branch/engine metadata labels */
    label_branch: string;
    label_scanners: string;
  };
}
