import type { ScanResultJson } from '@core/types/scan';

// ─── Export types ──────────────────────────────────────────────────────────────

export interface SonarQubeIssueExport {
  key: string;
  rule: string;
  severity: string;
  component: string;
  /** Relative file path extracted from component string */
  file: string;
  line?: number;
  message: string;
  type: string;
  status: string;
}

export interface SonarQubeMetricsExport {
  bugs?: string;
  vulnerabilities?: string;
  code_smells?: string;
  coverage?: string;
  duplicated_lines_density?: string;
  security_hotspots?: string;
  [key: string]: string | undefined;
}

export interface SonarQubeQualityGateConditionExport {
  status: string;
  metricKey: string;
  comparator: string;
  errorThreshold?: string;
  actualValue?: string;
}

/**
 * Detailed SonarQube export payload.
 * Written as JSON alongside the consolidated report when SonarQube ran successfully.
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
  const meta = result.metadata ?? {};

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
  const qualityGateStatus = meta['qualityGateStatus'] as string | undefined;
  const qualityGatePassed = meta['qualityGatePassed'] as boolean | undefined;
  const rawConditions = meta['qualityGateConditions'] as SonarQubeQualityGateConditionExport[] | undefined;

  const qualityGate = qualityGateStatus
    ? {
        status: qualityGateStatus,
        passed: qualityGatePassed ?? qualityGateStatus === 'OK',
        conditions: rawConditions ?? [],
      }
    : null;

  // Extract metrics
  const rawMetrics = meta['metrics'] as Record<string, string> | undefined;
  const metrics: SonarQubeMetricsExport | null = rawMetrics ? { ...rawMetrics } : null;

  // Extract issues — normalize component to file path
  const rawIssues = meta['issues'] as Array<{
    key: string;
    rule: string;
    severity: string;
    component: string;
    line?: number;
    message: string;
    type: string;
    status: string;
  }> | undefined;

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
 * Naming mirrors the consolidated report convention.
 */
export function sonarQubeExportFilename(projectName: string, date: string): string {
  return `sonarqube-export-${projectName.toLowerCase().replace(/\s+/g, '-')}-${date}.json`;
}
