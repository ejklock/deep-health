import type { ScanResultJson, SonarQubeQualityGateCondition, SonarQubeIssue } from '@core/types/scan';
import type { ExecLocale } from './i18n/types';

// ── SonarQube executive section builder ──────────────────────────────────────

interface SonarQubeConditionEntry {
  metricKey: string;
  status: string;
  statusIcon: string;
  comparator: string;
  errorThreshold: string;
  actualValue: string;
}

interface SonarQubeIssueEntry {
  severity: string;
  severityIcon: string;
  rule: string;
  line: string;
  message: string;
  type: string;
}

interface SonarQubeFileGroup {
  file: string;
  issues: SonarQubeIssueEntry[];
}

export interface SonarQubeExecSectionData {
  present: boolean;
  skipped: boolean;
  warning: string | null;
  qualityGate: string | null;
  hasConditions: boolean;
  conditions: SonarQubeConditionEntry[];
  conditionsLabel: string;
  metrics: Array<{ key: string; value: string }> | null;
  hasIssues: boolean;
  noIssues: boolean;
  issueCountLabel: string;
  issuesByFile: SonarQubeFileGroup[];
  issuesByFileLabel: string;
}

function severityIcon(severity: string): string {
  switch (severity.toUpperCase()) {
    case 'BLOCKER': return '🔴';
    case 'CRITICAL': return '🔴';
    case 'MAJOR': return '🟠';
    case 'MINOR': return '🟡';
    case 'INFO': return '🔵';
    default: return '⚪';
  }
}

function conditionStatusIcon(status: string): string {
  return status === 'OK' ? '✅' : status === 'ERROR' ? '❌' : '⚠️';
}

export function buildSonarQubeExecSection(
  engineResults: Record<string, ScanResultJson> | undefined,
  locale: ExecLocale,
): SonarQubeExecSectionData {
  const empty: SonarQubeExecSectionData = {
    present: false, skipped: false, warning: null, qualityGate: null,
    hasConditions: false, conditions: [], conditionsLabel: locale.sonarqube_conditions,
    metrics: null, hasIssues: false, noIssues: false,
    issueCountLabel: '', issuesByFile: [], issuesByFileLabel: locale.sonarqube_issues_by_file,
  };

  if (!engineResults) return empty;

  const sonarResult = engineResults['sonarqube'];
  if (!sonarResult) return empty;

  if (sonarResult.status === 'skipped') {
    return { ...empty, present: true, skipped: true };
  }

  if (sonarResult.status === 'error') {
    const msg = sonarResult.error ?? 'scan error';
    return { ...empty, present: true, warning: locale.sonarqube_warning(msg) };
  }

  // Quality gate label
  const qualityGateStatus = sonarResult.metadata?.qualityGateStatus;
  const qualityGateLabel = qualityGateStatus
    ? locale.sonarqube_quality_gate(
        qualityGateStatus === 'OK' ? '✅ OK' : qualityGateStatus === 'ERROR' ? '❌ ERROR' : qualityGateStatus,
      )
    : null;

  // Quality gate conditions
  const rawConditions: SonarQubeQualityGateCondition[] | undefined = sonarResult.metadata?.qualityGateConditions;
  const conditions: SonarQubeConditionEntry[] = (rawConditions ?? []).map((c) => ({
    metricKey: c.metricKey,
    status: c.status,
    statusIcon: conditionStatusIcon(c.status),
    comparator: c.comparator,
    errorThreshold: c.errorThreshold ?? '—',
    actualValue: c.actualValue ?? '—',
  }));

  // Metrics (with i18n label lookup, fallback to raw key)
  const rawMetrics = sonarResult.metadata?.metrics;
  const metricLabels = locale.sonarqube_metric_labels ?? {};
  const metricsForDisplay = rawMetrics
    ? Object.entries(rawMetrics).map(([key, value]) => ({ key: metricLabels[key] ?? key, value }))
    : null;

  // Issues grouped by file
  const rawIssues: SonarQubeIssue[] | undefined = sonarResult.metadata?.issues;

  const fileMap = new Map<string, SonarQubeIssueEntry[]>();
  for (const issue of rawIssues ?? []) {
    const colon = issue.component.indexOf(':');
    const file = colon >= 0 ? issue.component.slice(colon + 1) : issue.component;
    const entry: SonarQubeIssueEntry = {
      severity: issue.severity,
      severityIcon: severityIcon(issue.severity),
      rule: issue.rule,
      line: issue.line !== undefined ? String(issue.line) : '—',
      message: issue.message,
      type: issue.type,
    };
    const arr = fileMap.get(file) ?? [];
    arr.push(entry);
    fileMap.set(file, arr);
  }
  const issuesByFile: SonarQubeFileGroup[] = [...fileMap.entries()].map(([file, issues]) => ({ file, issues }));

  const totalIssues = rawIssues?.length ?? 0;
  const hasIssues = totalIssues > 0;
  const noIssues = rawIssues !== undefined && totalIssues === 0;

  return {
    present: true,
    skipped: false,
    warning: null,
    qualityGate: qualityGateLabel,
    hasConditions: conditions.length > 0,
    conditions,
    conditionsLabel: locale.sonarqube_conditions,
    metrics: metricsForDisplay,
    hasIssues,
    noIssues,
    issueCountLabel: hasIssues ? locale.sonarqube_issue_count(totalIssues) : '',
    issuesByFile,
    issuesByFileLabel: locale.sonarqube_issues_by_file,
  };
}
