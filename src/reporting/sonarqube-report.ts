import type { ScanResultJson } from '@core/types/scan';
import { render } from './renderer';
import sonarqubeHtmlTemplate from './templates/sonarqube-report-html.hbs';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function monthName(date: Date): string {
  return date.toLocaleString('en-US', { month: 'long' });
}

function severityClass(severity: string): string {
  switch (severity.toUpperCase()) {
    case 'BLOCKER':
    case 'CRITICAL': return 'critical';
    case 'MAJOR': return 'major';
    case 'MINOR': return 'minor';
    case 'INFO': return 'info';
    default: return 'unknown';
  }
}

function conditionStatusIcon(status: string): string {
  return status === 'OK' ? '✅' : status === 'ERROR' ? '❌' : '⚠️';
}

function qualityGateBadgeClass(status: string): string {
  if (status === 'OK') return 'qg-ok';
  if (status === 'ERROR') return 'qg-error';
  return 'qg-warn';
}

// ─── HTML report generator ────────────────────────────────────────────────────

/**
 * Generate a standalone SonarQube HTML report.
 * Returns null when SonarQube results are absent, skipped, or engineResults is undefined.
 *
 * @param engineResults  Aggregated engine results from the orchestrator.
 * @param client         Client name (used in header and filename).
 * @param project        Project name (used in header and filename).
 */
export function generateSonarQubeHtmlReport(
  engineResults: Record<string, ScanResultJson> | undefined,
  client: string,
  project: string,
): string | null {
  if (!engineResults) return null;

  const sonarResult = engineResults['sonarqube'];
  if (!sonarResult) return null;
  if (sonarResult.status === 'skipped') return null;

  const now = new Date();
  const periodLabel = `${monthName(now)} ${now.getFullYear()}`;
  const exportedAt = now.toISOString().replace('T', ' ').slice(0, 19);

  // ── Error case ──────────────────────────────────────────────────────────────
  if (sonarResult.status === 'error') {
    const warning = sonarResult.error ?? 'SonarQube scan failed';
    return render(sonarqubeHtmlTemplate, {
      project,
      client,
      periodLabel,
      exportedAt,
      clientLabel: 'Client',
      exportedAtLabel: 'Generated',
      qualityGateLabel: 'Quality Gate',
      conditionsLabel: 'Quality Gate Conditions',
      metricsLabel: 'Metrics',
      issuesLabel: 'Issues',
      noIssuesLabel: 'No issues found.',
      warning,
      qualityGateStatus: null,
      hasConditions: false,
      conditions: [],
      metrics: null,
      noIssues: false,
      issuesByFile: null,
      issueCountSuffix: null,
    });
  }

  // ── Success case ────────────────────────────────────────────────────────────
  const meta = sonarResult.metadata;

  // Quality gate
  const rawQgStatus = meta?.qualityGateStatus;
  const rawQgPassed = meta?.qualityGatePassed;
  const qgDisplayStatus = rawQgStatus
    ? (rawQgStatus === 'OK' ? 'PASSED' : rawQgStatus === 'ERROR' ? 'FAILED' : rawQgStatus)
    : null;
  const qgBadgeClass = rawQgStatus ? qualityGateBadgeClass(rawQgStatus) : 'qg-warn';

  // Conditions
  const rawConditions = meta?.qualityGateConditions;
  const conditions = (rawConditions ?? []).map((c) => ({
    statusIcon: conditionStatusIcon(c.status),
    isOk: c.status === 'OK',
    metricKey: c.metricKey,
    comparator: c.comparator,
    errorThreshold: c.errorThreshold ?? '—',
    actualValue: c.actualValue ?? '—',
  }));

  // Metrics
  const rawMetrics = meta?.metrics;
  const metrics = rawMetrics ? Object.entries(rawMetrics).map(([key, value]) => ({ key, value })) : null;

  // Issues grouped by file
  const rawIssues = meta?.issues;

  const fileMap = new Map<string, Array<{ severity: string; severityClass: string; rule: string; line: string; message: string }>>();
  for (const issue of rawIssues ?? []) {
    const colon = issue.component.indexOf(':');
    const file = colon >= 0 ? issue.component.slice(colon + 1) : issue.component;
    const entry = {
      severity: issue.severity,
      severityClass: severityClass(issue.severity),
      rule: issue.rule,
      line: issue.line !== undefined ? String(issue.line) : '—',
      message: issue.message,
    };
    const arr = fileMap.get(file) ?? [];
    arr.push(entry);
    fileMap.set(file, arr);
  }

  const issuesByFile = fileMap.size > 0
    ? [...fileMap.entries()].map(([file, issues]) => ({ file, issues }))
    : null;

  const totalIssues = rawIssues?.length ?? 0;
  const noIssues = rawIssues !== undefined && totalIssues === 0;

  return render(sonarqubeHtmlTemplate, {
    project,
    client,
    periodLabel,
    exportedAt,
    clientLabel: 'Client',
    exportedAtLabel: 'Generated',
    qualityGateLabel: 'Quality Gate',
    conditionsLabel: 'Quality Gate Conditions',
    metricsLabel: 'Metrics',
    issuesLabel: 'Issues',
    noIssuesLabel: 'No issues found.',
    warning: null,
    qualityGateStatus: qgDisplayStatus,
    qualityGateBadgeClass: qgBadgeClass,
    hasConditions: conditions.length > 0,
    conditions,
    metrics,
    noIssues,
    issuesByFile,
    issueCountSuffix: totalIssues > 0 ? `${totalIssues} found` : null,
    // suppress unused warning via assignment
    _qualityGatePassed: rawQgPassed,
  });
}

// ─── Filename ─────────────────────────────────────────────────────────────────

/**
 * Filename for the standalone SonarQube HTML report.
 * Follows the same convention as the executive report:
 *   "[Client Project] SonarQube Report - YYYY-MM - Month.html"
 */
export function sonarqubeHtmlReportFilename(client: string, project: string): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `[${client} ${project}] SonarQube Report - ${year}-${month} - ${monthName(now)}.html`;
}
