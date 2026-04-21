import type { ScanResultJson } from '@core/types/scan';
import type { SonarQubeQualityGateCondition, SonarQubeIssue } from '@core/types/scan';

// ─── Export types ──────────────────────────────────────────────────────────────

export type SonarQubeQualityGateConditionExport = SonarQubeQualityGateCondition;

export type SonarQubeIssueExport = SonarQubeIssue & {
  /** Relative file path extracted from component string */
  file: string;
};

export interface SonarQubeMetricsExport {
  bugs?: string;
  vulnerabilities?: string;
  code_smells?: string;
  coverage?: string;
  duplicated_lines_density?: string;
  security_hotspots?: string;
  [key: string]: string | undefined;
}

/**
 * Detailed SonarQube export payload.
 * Written as a standalone JSON artifact when SonarQube ran successfully.
 */
export interface SonarQubeDetailedExport {
  $schema: 'sonarqube-export/v1';
  exportedAt: string;
  /** The SonarQube agent that produced this result */
  agent: string;
  /** Overall scan status: 'success' | 'error' | 'skipped' */
  status: string;
  qualityGate: {
    status: string;
    passed: boolean;
    conditions: SonarQubeQualityGateConditionExport[];
  } | null;
  metrics: SonarQubeMetricsExport | null;
  issues: SonarQubeIssueExport[] | null;
  error: string | null;
}

// ─── Builder ───────────────────────────────────────────────────────────────────

/**
 * Build a detailed SonarQube export from the raw engine result.
 *
 * Returns null if:
 * - The engine result is undefined (SonarQube not configured / not in engineResults)
 * - Status is 'skipped'
 *
 * For status='error', returns an export with only the error field populated.
 */
export function buildSonarQubeExport(
  engineResults: Record<string, ScanResultJson> | undefined,
): SonarQubeDetailedExport | null {
  if (!engineResults) return null;

  const result = engineResults['sonarqube'];
  if (!result) return null;
  if (result.status === 'skipped') return null;

  const now = new Date().toISOString();

  if (result.status === 'error') {
    return {
      $schema: 'sonarqube-export/v1',
      exportedAt: now,
      agent: result.agent,
      status: 'error',
      qualityGate: null,
      metrics: null,
      issues: null,
      error: result.error ?? 'unknown error',
    };
  }

  // Extract quality gate
  const qualityGateStatus = result.metadata?.qualityGateStatus;
  const qualityGatePassed = result.metadata?.qualityGatePassed;
  const rawConditions = result.metadata?.qualityGateConditions;

  const qualityGate = qualityGateStatus
    ? {
        status: qualityGateStatus,
        passed: qualityGatePassed ?? qualityGateStatus === 'OK',
        conditions: rawConditions ?? [],
      }
    : null;

  // Extract metrics
  const rawMetrics = result.metadata?.metrics;
  const metrics: SonarQubeMetricsExport | null = rawMetrics ? { ...rawMetrics } : null;

  // Extract issues — normalize component to file path
  const rawIssues = result.metadata?.issues;

  const issues: SonarQubeIssueExport[] | null = rawIssues
    ? rawIssues.map((issue) => {
        const colon = issue.component.indexOf(':');
        const file = colon >= 0 ? issue.component.slice(colon + 1) : issue.component;
        return { ...issue, file };
      })
    : null;

  return {
    $schema: 'sonarqube-export/v1',
    exportedAt: now,
    agent: result.agent,
    status: result.status,
    qualityGate,
    metrics,
    issues,
    error: result.error,
  };
}

/**
 * Determine the filename for the SonarQube export JSON.
 * Naming mirrors the project/date artifact convention.
 */
export function sonarQubeExportFilename(projectName: string, date: string): string {
  return `sonarqube-export-${projectName.toLowerCase().replace(/\s+/g, '-')}-${date}.json`;
}
