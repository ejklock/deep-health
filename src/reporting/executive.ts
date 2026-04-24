import type { ExecutiveReportOptions, ResidualVerification } from '@core/types/report';
import type { AdvisorResult, AdvisorFinding } from '@core/types/report';
import type { ScanResultJson, VulnerabilityEntry, SonarQubeQualityGateCondition, SonarQubeIssue } from '@core/types/scan';
import type { Locale } from './i18n/index';
import type { ExecLocale } from './i18n/types';
import { defaultRegistry } from '@modules/ecosystem/index';
import { getLocale } from './i18n/index';
import { render } from './renderer';
import executiveTemplate from './templates/executive.hbs';

// ── helpers ─────────────────────────────────────────────────────────────────

function monthName(date: Date): string {
  return date.toLocaleString('en-US', { month: 'long' });
}

function ghsaLink(id: string): string {
  return id ? `[${id}](https://osv.dev/${id})` : '—';
}

function parsePackageName(ref: string): string {
  const at = ref.lastIndexOf('@');
  return at > 0 ? ref.slice(0, at) : ref;
}

function parsePackageVersion(ref: string): string | undefined {
  const at = ref.lastIndexOf('@');
  return at > 0 ? ref.slice(at + 1) : undefined;
}

function uniqueCount(vulns: VulnerabilityEntry[]): number {
  return new Set(vulns.map((v) => v.package)).size;
}

function motivoStr(vuln: VulnerabilityEntry, locale: Locale): string {
  const r = vuln.reason;
  if (!r || r.includes('No safe version') || r.includes('Cannot parse')) {
    return locale.reason.no_safe_version;
  }
  if (r.includes('Major version bump')) {
    const match = r.match(/(\S+)\s*→\s*(\S+)/);
    return match
      ? locale.reason.major_bump(match[2]!)
      : locale.reason.major_bump_generic;
  }
  if (r.includes('Protected package')) {
    const constraintMatch = r.match(/constraint\s+(\S+)/);
    return locale.reason.protected_constraint(constraintMatch?.[1] ?? 'configured constraint');
  }
  return r;
}

function pendingStatus(vuln: VulnerabilityEntry, locale: Locale): string {
  const r = vuln.reason;
  if (!r || r.includes('No safe version') || r.includes('Cannot parse')) return locale.status.no_fix;
  if (r.includes('Major version bump')) return locale.status.needs_auth;
  return locale.status.pending;
}

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

interface SonarQubeExecSectionData {
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

function buildSonarQubeExecSection(
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

// ── Advisor section builder (executive) ─────────────────────────────────────

interface AdvisorFindingEntry {
  package: string;
  severity: string;
  title: string;
  range: string;
  fixAvailable: string;
}

interface AdvisorExecSectionData {
  present: boolean;
  ecosystems: Array<{
    id: string;
    name: string;
    advisors: Array<{
      name: string;
      header: string;
      statusLabel: string;
      hasOutput: boolean;
      outputBlock: string;
      hasFindings: boolean;
      noFindings: boolean;
      findings: AdvisorFindingEntry[];
    }>;
  }>;
}

function buildAdvisorExecSection(
  advisorResults: Record<string, AdvisorResult[]> | undefined,
  locale: ExecLocale,
): AdvisorExecSectionData {
  if (!advisorResults) {
    return { present: false, ecosystems: [] };
  }

  const ecosystems: AdvisorExecSectionData['ecosystems'] = [];

  for (const [ecoId, results] of Object.entries(advisorResults)) {
    if (!results || results.length === 0) continue;

    const plugin = defaultRegistry.get(ecoId);
    const ecoName = plugin?.name ?? ecoId;

    const advisors = results.map((r) => {
      let statusLbl: string;
      switch (r.status) {
        case 'clean':    statusLbl = locale.advisor_clean; break;
        case 'findings': statusLbl = locale.advisor_findings; break;
        case 'error':    statusLbl = locale.advisor_error; break;
        case 'skipped':  statusLbl = locale.advisor_skipped; break;
        // backward compat — should not occur with new code
        default: statusLbl = (r.status as string) === 'pass' ? locale.advisor_clean : locale.advisor_error;
      }

      const hasOutput = r.output.trim().length > 0;
      const outputBlock = hasOutput ? locale.advisor_output(r.output) : '';

      // Structured findings (from JSON-format advisors)
      const rawFindings: AdvisorFinding[] = r.findings ?? [];
      const hasFindings = rawFindings.length > 0;
      const noFindings = r.status === 'clean' && !hasFindings;
      const findings: AdvisorFindingEntry[] = rawFindings.map((f) => ({
        package: f.package,
        severity: f.severity,
        title: f.title,
        range: f.range ?? '—',
        fixAvailable: f.fixAvailable ?? '—',
      }));

      // Summary cell for the overview table
      let findingsSummary: string;
      if (hasFindings) {
        findingsSummary = `${rawFindings.length} finding(s)`;
      } else if (r.status === 'error') {
        findingsSummary = locale.advisor_error;
      } else {
        findingsSummary = '—';
      }

      return {
        name: r.name,
        header: locale.advisor_header(r.name),
        statusLabel: statusLbl,
        hasOutput,
        outputBlock,
        hasFindings,
        noFindings,
        findings,
        findingsSummary,
      };
    });

    ecosystems.push({ id: ecoId, name: ecoName, advisors });
  }

  return { present: ecosystems.length > 0, ecosystems };
}

// ── context builder ──────────────────────────────────────────────────────────

export function generateExecutiveReport(opts: ExecutiveReportOptions): string {
  const locale = getLocale(opts.locale);
  const now = new Date();

  // Resolve residual verification state — use the explicit union type.
  const residualVerification: ResidualVerification = opts.residualVerification ?? { status: 'skipped' };

  // Build per-ecosystem update name sets (for determining fixed vs pending)
  const plugins = defaultRegistry.getAll();

  // Map: ecosystemId -> Set of updated package names
  const updatedNamesByEco = new Map<string, Set<string>>();
  for (const plugin of plugins) {
    const update = opts.updates[plugin.id] ?? null;
    const updatedPackages = update?.packages_updated ?? [];
    updatedNamesByEco.set(plugin.id, new Set(updatedPackages.map(parsePackageName)));
  }

  // Map: ecosystemId -> Map<packageName, actualInstalledVersion>
  const installedVersionsByEco = new Map<string, Map<string, string>>();
  for (const plugin of plugins) {
    const updatedPackages = opts.updates[plugin.id]?.packages_updated ?? [];
    const versionMap = new Map<string, string>();
    for (const ref of updatedPackages) {
      const name = parsePackageName(ref);
      const version = parsePackageVersion(ref);
      if (version) versionMap.set(name, version);
    }
    installedVersionsByEco.set(plugin.id, versionMap);
  }

  const allVulnsBefore = [
    ...Object.values(opts.scanBefore.ecosystems).flatMap((e) => e.vulnerabilities),
  ];

  // Fixed vulns: auto_safe and in the updated set for their ecosystem
  const fixedVulns = allVulnsBefore
    .filter((v) => {
      const names = updatedNamesByEco.get(v.ecosystem) ?? new Set();
      return v.classification === 'auto_safe' && names.has(v.package);
    })
    .map((v) => {
      // Look up reportLabel from registry
      const plugin = defaultRegistry.findByOsvEcosystem(v.ecosystem) ?? defaultRegistry.get(v.ecosystem);
      // Render residual warning distinctly: only when verification ran and CVEs remain
      const residualCount = residualVerification.status !== 'skipped'
        ? (residualVerification.summary[v.ecosystem] ?? 0)
        : null;
      const residualWarning = residualVerification.status === 'unverified' && residualCount !== null && residualCount > 0;
      return {
        ecoLabel: plugin?.reportLabel ?? v.ecosystem,
        ghsaLink: ghsaLink(v.ghsaId),
        cvss: v.cvss,
        package: v.package,
        currentVersion: v.currentVersion,
        safeVersion: installedVersionsByEco.get(v.ecosystem)?.get(v.package) ?? v.safeVersion ?? '—',
        risk: v.risk,
        residualWarning,
      };
    });

  const pendingOriginal = allVulnsBefore.filter((v) => {
    if (v.classification !== 'auto_safe') return true;
    const names = updatedNamesByEco.get(v.ecosystem) ?? new Set();
    return !names.has(v.package);
  });

  const pendingVulns = pendingOriginal.map((v) => {
    const plugin = defaultRegistry.findByOsvEcosystem(v.ecosystem) ?? defaultRegistry.get(v.ecosystem);
    return {
      ecoLabel: plugin?.reportLabel ?? v.ecosystem,
      ghsaLink: ghsaLink(v.ghsaId),
      cvss: v.cvss,
      package: v.package,
      currentVersion: v.currentVersion,
      motivoPt: motivoStr(v, locale),
    };
  });

  // Per-plugin evidence sections
  const evidenceSections = plugins.map((plugin) => {
    const ecoScan = opts.scanBefore.ecosystems[plugin.id];
    const update = opts.updates[plugin.id] ?? null;
    const updatedNames = updatedNamesByEco.get(plugin.id) ?? new Set();

    const installedVersions = installedVersionsByEco.get(plugin.id) ?? new Map<string, string>();
    // Use the explicit verification state: only show residual warning when 'unverified'
    const residualCount = residualVerification.status !== 'skipped'
      ? (residualVerification.summary[plugin.id] ?? 0)
      : null;
    const isUnverified = residualVerification.status === 'unverified';
    const vulnsAfter = (ecoScan?.vulnerabilities ?? []).map((v) => {
      const fixed = updatedNames.has(v.package) && v.classification === 'auto_safe';
      let statusPt: string;
      if (fixed) {
        const fixedVersionLabel = locale.exec.fixed_version(installedVersions.get(v.package) ?? v.safeVersion ?? '—');
        statusPt = (isUnverified && residualCount !== null && residualCount > 0)
          ? fixedVersionLabel + ' ⚠ residual CVE unverified — post-update scan detected remaining vulnerabilities'
          : fixedVersionLabel;
      } else {
        statusPt = pendingStatus(v, locale);
      }
      return {
        ghsaId: v.ghsaId,
        cvss: v.cvss,
        package: v.package,
        statusPt,
        risk: v.risk,
      };
    });

    const hasVulns = vulnsAfter.length > 0;

    // Render all validations generically — no fixed names assumed
    const validationEntries = (update?.validations ?? [])
      .filter((v) => v.status === 'pass' && v.detail)
      .map((v) => ({
        name: v.name,
        detail: v.detail ?? '',
        verifiedMsg: locale.exec.validation_verified(v.name, v.detail ?? ''),
      }));
    const showValidations = validationEntries.length > 0;

    return {
      id: plugin.id,
      name: plugin.name,
      reportLabel: plugin.reportLabel,
      evidenceTitle: locale.exec.ecosystem_evidence_title(plugin.reportLabel),
      hasVulns,
      vulnsAfter,
      showValidations,
      validationEntries,
    };
  });

  // Summary: per-ecosystem before/after labels
  const ecoBeforeLabels = plugins
    .map((plugin) => {
      const eco = opts.scanBefore.ecosystems[plugin.id];
      const total = eco?.vulnerabilities_total ?? 0;
      const pkgCount = uniqueCount(eco?.vulnerabilities ?? []);
      return locale.pkg_count(total, pkgCount, plugin.reportLabel);
    })
    .join(', ');

  const pendingByEco = new Map<string, VulnerabilityEntry[]>();
  for (const v of pendingOriginal) {
    const arr = pendingByEco.get(v.ecosystem) ?? [];
    arr.push(v);
    pendingByEco.set(v.ecosystem, arr);
  }

  const ecoAfterLabels = plugins
    .map((plugin) => {
      const pending = pendingByEco.get(plugin.id) ?? [];
      const pkgCount = uniqueCount(pending);
      const pkgAfterNames = pkgCount === 1
        ? [...new Set(pending.map((v) => v.package))].join(', ')
        : undefined;
      return locale.pkg_count(pending.length, pkgCount, plugin.reportLabel, pkgAfterNames);
    })
    .join(', ');

  const totalBefore = allVulnsBefore.length;

  // pendingByPkg for Summary section
  const pendingByPkgMap = new Map<string, VulnerabilityEntry[]>();
  for (const v of pendingOriginal) {
    const key = `${v.ecosystem}:${v.package}`;
    const arr = pendingByPkgMap.get(key) ?? [];
    arr.push(v);
    pendingByPkgMap.set(key, arr);
  }
  const pendingByPkg = [...pendingByPkgMap.values()].map((vulns) => {
    const v = vulns[0]!;
    const maxCvss = vulns.reduce((max, x) => {
      const n = parseFloat(x.cvss);
      const m = parseFloat(max);
      return !isNaN(n) && n > (isNaN(m) ? 0 : m) ? x.cvss : max;
    }, '0');
    return {
      package: v.package,
      currentVersion: v.currentVersion,
      motivoPt: motivoStr(v, locale),
      riskLabel: 'Risk',
      risk: v.risk,
      cvssDisplay: maxCvss !== '0' ? ` CVSS ${maxCvss}` : '',
    };
  });

  // Build SonarQube section (graceful: absent when engineResults not provided)
  const sonarSection = buildSonarQubeExecSection(opts.engineResults, locale.exec);

  const context: Record<string, unknown> = {
    t: locale.exec,
    client: opts.client,
    project: opts.project,
    monthFull: locale.months[now.getMonth()],
    year: now.getFullYear(),
    branch: opts.branch ?? null,
    hasBranch: typeof opts.branch === 'string' && opts.branch.length > 0,
    scannerEngines: opts.scannerEngines && opts.scannerEngines.length > 0 ? opts.scannerEngines.join(', ') : null,
    noVulns: totalBefore === 0,
    fixedVulns,
    pendingVulns,
    allVulnsBefore: allVulnsBefore.map((v) => {
      const plugin = defaultRegistry.findByOsvEcosystem(v.ecosystem) ?? defaultRegistry.get(v.ecosystem);
      return {
        ecoLabel: plugin?.reportLabel ?? v.ecosystem,
        ghsaId: v.ghsaId,
        cvss: v.cvss,
        package: v.package,
        currentVersion: v.currentVersion,
        risk: v.risk,
      };
    }),
    totalBefore,
    scanBeforeSummary: locale.exec.scan_summary(totalBefore, ecoBeforeLabels),
    evidenceSections,
    scanAfterSummary: locale.exec.scan_after_summary_generic(pendingOriginal.length, ecoAfterLabels),
    allFixed: fixedVulns.length > 0 && pendingOriginal.length === 0,
    pendingByPkg,
    sonarSection,
  };

  return render(executiveTemplate, context);
}

export function executiveReportFilename(client: string, project: string): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `[${client} ${project}] Security Report - ${year}-${month} - ${monthName(now)}.md`;
}
