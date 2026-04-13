import type { PhaseStatus } from './common.js';

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
}
