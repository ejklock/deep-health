// Re-exported from the neutral types layer so report/i18n internals stay self-consistent.
export type { SupportedLocale } from '../../types/locale.js';

export interface ExecLocale {
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
  sonarqube_section: string;
  sonarqube_quality_gate(status: string): string;
  sonarqube_metrics: string;
  sonarqube_skipped: string;
  sonarqube_warning(message: string): string;
}

export interface ConsolidatedLocale {
  title(projectName: string): string;
  label_date: string;
  label_environment: string;
  section_vulns: string;
  label_total: string;
  section_fixes: string;
  ecosystem_header(name: string): string;
  no_packages_updated: string;
  section_validation: string;
  section_pending: string;
  breaking_title: string;
  breaking_authorize: string;
  no_safe_version_title: string;
  /** SonarQube consolidated section */
  sonarqube_section: string;
  sonarqube_quality_gate(status: string): string;
  sonarqube_metrics: string;
  sonarqube_affected_files: string;
  sonarqube_no_issues: string;
  sonarqube_skipped: string;
  sonarqube_warning(message: string): string;
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
  authorization_format: string;
  pkg_count(vulnCount: number, pkgCount: number, ecosystem: string, names?: string): string;
  exec: ExecLocale;
  reason: ReasonLocale;
  status: StatusLocale;
  consolidated: ConsolidatedLocale;
}
