import type { ScanResultJson } from './scan';
import type { UpdateResultJson } from './update';
import type { PhaseStatus } from './common';
import type { SupportedLocale } from './locale';

export interface ConsolidatedReport {
  projectName: string;
  date: string;
  environment: string;
  scan: ScanResultJson;
  /** Update results keyed by plugin id (e.g. 'npm', 'composer') */
  updates: Record<string, UpdateResultJson>;
  overallStatus: PhaseStatus;
  locale?: SupportedLocale;
  /**
   * Per-engine raw scan results for multi-source reporting.
   * Optional — reports gracefully omit engine sections when this map is absent
   * or the engine is not present. Key is the engine id (e.g. 'sonarqube').
   */
  engineResults?: Record<string, ScanResultJson>;
}

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
}
