import type { ScanResultJson } from './scan';
import type { UpdateResultJson } from './update';
import type { SupportedLocale } from './locale';

/** A single structured finding from a structured advisor (e.g. npm audit --json) */
export interface AdvisorFinding {
  /** Package name affected */
  package: string;
  /** Severity label (e.g. 'high', 'critical', 'moderate', 'low') */
  severity: string;
  /** Short title or description of the vulnerability */
  title: string;
  /** Semver range of affected versions */
  range?: string;
  /** Suggested fix version, if any */
  fixAvailable?: string;
}

/** Result produced by an advisor command execution */
export interface AdvisorResult {
  name: string;
  command: string;
  /** Exit code of the advisor command */
  exitCode: number;
  /**
   * Advisor status:
   * - 'clean':    command ran successfully and found no issues.
   * - 'findings': command completed and reported issues (e.g. vulnerabilities found).
   * - 'error':    command failed to execute or produced an unrecoverable error.
   * - 'skipped':  advisor was intentionally not run.
   */
  status: 'clean' | 'findings' | 'error' | 'skipped';
  /** Raw output summary (last N lines of stdout; may be empty for structured advisors) */
  output: string;
  /**
   * Structured findings parsed from JSON output advisors (e.g. npm audit --json).
   * Present only when `format: 'json'` was set in AdvisorConfig and parsing succeeded.
   */
  findings?: AdvisorFinding[];
}

/**
 * Residual OSV verification outcome (typed union).
 * - `verified`:   Scan ran, all ecosystems have 0 residual CVEs.
 * - `unverified`: Scan ran but ≥1 ecosystem still has CVEs remaining.
 * - `skipped`:    Scan was not run (dryRun, error, or no verify configured).
 */
export type ResidualVerification =
  | { status: 'verified'; summary: Record<string, number> }
  | { status: 'unverified'; summary: Record<string, number> }
  | { status: 'skipped' };

export interface ExecutiveReportOptions {
  client: string;
  project: string;
  scanBefore: ScanResultJson;
  scanAfter: ScanResultJson;
  /** Update results keyed by plugin id (e.g. 'npm', 'composer') */
  updates: Record<string, UpdateResultJson>;
  locale?: SupportedLocale;
  /**
   * Per-engine raw scan results for multi-source reporting.
   * Optional — reports gracefully omit engine sections when this map is absent
   * or the engine is not present. Key is the engine id (e.g. 'sonarqube').
   */
  engineResults?: Record<string, ScanResultJson>;
  /**
   * Advisor results keyed by ecosystem id.
   * Optional — present when advisors were configured and executed.
   */
  advisorResults?: Record<string, AdvisorResult[]>;
  /**
   * Git branch the scan was executed on.
   * Optional — rendered in report header when present.
   */
  branch?: string | null;
  /**
   * Summary of scanner engines used during this run.
   * Optional — rendered in report header when present.
   * Example: ['osv', 'sonarqube']
   */
  scannerEngines?: string[];
  /**
   * Residual OSV verification outcome (typed union).
   */
  residualVerification?: ResidualVerification;
}
