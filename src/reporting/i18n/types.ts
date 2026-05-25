// Re-exported from the neutral types layer so reporting/i18n internals stay self-consistent.
export type { SupportedLocale } from '@core/types/locale';

export interface ExecLocale {
  report_title: string;
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
  /** Generic scan summary: total vulns + per-ecosystem labels */
  scan_summary(total: number, ecoLabels: string): string;
  section_evidence_after: string;
  /** Generic evidence section title per ecosystem. Ex: "PHP/Composer (composer.lock) — post-fix scan summary:" */
  ecosystem_evidence_title(ecoLabel: string): string;
  table_after_header: string;
  /** Generic post-fix summary: remaining vulns + per-ecosystem labels */
  scan_after_summary_generic(total: number, ecoLabels: string): string;
  tests_verified_intro: string;
  /** Generic validation verified message for any ecosystem */
  validation_verified(validationLabel: string, detail: string): string;
  section_summary: string;
  all_fixed: string;
  pending_needs_action_intro: string;
  pending_manual: string;
  fixed_version(version: string): string;
  /** SonarQube executive section */
  sonarqube_title: string;
  sonarqube_quality_gate(status: string): string;
  sonarqube_conditions: string;
  sonarqube_metrics: string;
  sonarqube_issues_by_file: string;
  sonarqube_no_issues: string;
  sonarqube_issue_count(n: number): string;
  sonarqube_skipped: string;
  sonarqube_warning(message: string): string;
  /** Optional map of known SonarQube metric keys to human-readable labels */
  sonarqube_metric_labels?: Record<string, string>;
  /** Advisor section */
  advisors_title: string;
  advisor_header(name: string): string;
  advisor_skipped: string;
  advisor_clean: string;
  advisor_findings: string;
  advisor_error: string;
  advisor_output(output: string): string;
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
}

export interface ReasonLocale {
  no_safe_version: string;
  major_bump(targetVersion: string): string;
  major_bump_generic: string;
  protected_constraint(constraint: string): string;
}

export interface StatusLocale {
  no_fix: string;
  needs_auth: string;
  pending: string;
}

export interface Locale {
  months: readonly string[];
  pkg_count(vulnCount: number, pkgCount: number, ecosystem: string, names?: string): string;
  exec: ExecLocale;
  reason: ReasonLocale;
  status: StatusLocale;
}
