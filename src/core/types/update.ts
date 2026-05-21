import type { PhaseStatus } from './common';

/**
 * A single validation step entry in the canonical validation model.
 * Ecosystem plugins emit one entry per validation check (e.g. 'tests', 'build', 'lint').
 */
export interface ValidationEntry {
  /** Short identifier for the validation step, e.g. 'tests', 'build', 'lint' */
  name: string;
  /** Pass/fail/skipped outcome */
  status: 'pass' | 'fail' | 'skipped';
  /** Optional human-readable detail for this step */
  detail?: string;
}

/**
 * A structured audit finding carried from an ecosystem updater to the executive report.
 * Populated by updaters that run a secondary audit step (e.g. composer osv-then-audit).
 * The report injects these as synthetic VulnerabilityEntry objects so fixed/pending
 * logic naturally includes audit-discovered packages.
 */
export interface AuditFinding {
  ecosystem: string;
  package: string;
  advisoryId: string;
  title: string;
  cve: string | null;
  affectedVersions: string;
}

export interface UpdateResultJson {
  $schema: 'osv-update-result/v1';
  agent: string;
  status: PhaseStatus;
  packages_updated: string[];
  packages_skipped: string[];
  packages_pending_breaking: string[];
  /**
   * Canonical validation steps array.
   * All ecosystem plugins populate this array with one entry per validation step.
   * Consumers (reports, gates) iterate these entries for validation status/detail.
   *
   * INVARIANT: This array must never be empty. Every code path that produces an
   * UpdateResultJson must emit at least one ValidationEntry (with status 'pass',
   * 'fail', or 'skipped'). An empty array is a contract violation and will be
   * rejected by the schema gate (validateEcosystemGate).
   *
   * Dry-run paths must use status 'skipped' — never 'pass' — because no
   * commands are actually executed.
   */
  validations: ValidationEntry[];
  error: string | null;
  /**
   * Structured audit findings from a secondary audit step (e.g. composer osv-then-audit).
   * Optional — only populated by updaters that discover packages outside the OSV scan.
   * The executive report injects these as synthetic VulnerabilityEntry objects so
   * audit-discovered packages appear correctly in the fixed/pending sections.
   */
  audit_findings?: AuditFinding[];
}
