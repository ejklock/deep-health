import type { ExecutiveReportOptions } from '@core/types/report';
import type { AdvisorResult } from '@core/types/config';
import type { ScanResultJson, VulnerabilityEntry } from '@core/types/scan';
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

interface SonarQubeExecSectionData {
  present: boolean;
  skipped: boolean;
  warning: string | null;
  qualityGate: string | null;
  metrics: Array<{ key: string; value: string }> | null;
}

function buildSonarQubeExecSection(
  engineResults: Record<string, ScanResultJson> | undefined,
  locale: ExecLocale,
): SonarQubeExecSectionData {
  if (!engineResults) {
    return { present: false, skipped: false, warning: null, qualityGate: null, metrics: null };
  }

  const sonarResult = engineResults['sonarqube'];
  if (!sonarResult) {
    return { present: false, skipped: false, warning: null, qualityGate: null, metrics: null };
  }

  if (sonarResult.status === 'skipped') {
    return { present: true, skipped: true, warning: null, qualityGate: null, metrics: null };
  }

  if (sonarResult.status === 'error') {
    const msg = sonarResult.error ?? 'scan error';
    return { present: true, skipped: false, warning: locale.sonarqube_warning(msg), qualityGate: null, metrics: null };
  }

  const meta = sonarResult.metadata ?? {};
  const qualityGateStatus = meta['qualityGateStatus'] as string | undefined;
  const qualityGateLabel = qualityGateStatus
    ? locale.sonarqube_quality_gate(
        qualityGateStatus === 'OK' ? '✅ OK' : qualityGateStatus === 'ERROR' ? '❌ ERROR' : qualityGateStatus,
      )
    : null;

  const rawMetrics = meta['metrics'] as Record<string, string> | undefined;
  const metricsForDisplay = rawMetrics
    ? Object.entries(rawMetrics).map(([key, value]) => ({ key, value }))
    : null;

  return {
    present: true,
    skipped: false,
    warning: null,
    qualityGate: qualityGateLabel,
    metrics: metricsForDisplay,
  };
}

// ── Advisor section builder (executive) ─────────────────────────────────────

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
      const statusLbl = r.status === 'pass'
        ? locale.advisor_pass
        : r.status === 'fail'
          ? locale.advisor_fail
          : locale.advisor_skipped;

      const hasOutput = r.output.trim().length > 0;
      const outputBlock = hasOutput ? locale.advisor_output(r.output) : '';

      return {
        name: r.name,
        header: locale.advisor_header(r.name),
        statusLabel: statusLbl,
        hasOutput,
        outputBlock,
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

  // Build per-ecosystem update name sets (for determining fixed vs pending)
  const plugins = defaultRegistry.getAll();

  // Map: ecosystemId -> Set of updated package names
  const updatedNamesByEco = new Map<string, Set<string>>();
  for (const plugin of plugins) {
    const update = opts.updates[plugin.id] ?? null;
    const updatedPackages = update?.packages_updated ?? [];
    updatedNamesByEco.set(plugin.id, new Set(updatedPackages.map(parsePackageName)));
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
      return {
        ecoLabel: plugin?.reportLabel ?? v.ecosystem,
        ghsaLink: ghsaLink(v.ghsaId),
        cvss: v.cvss,
        package: v.package,
        currentVersion: v.currentVersion,
        safeVersion: v.safeVersion ?? '—',
        risk: v.risk,
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

    const vulnsAfter = (ecoScan?.vulnerabilities ?? []).map((v) => {
      const fixed = updatedNames.has(v.package) && v.classification === 'auto_safe';
      return {
        ghsaId: v.ghsaId,
        cvss: v.cvss,
        package: v.package,
        statusPt: fixed ? locale.exec.fixed_version(v.safeVersion ?? '—') : pendingStatus(v, locale),
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

  // Build advisor section
  const advisorSection = buildAdvisorExecSection(opts.advisorResults, locale.exec);

  const context: Record<string, unknown> = {
    t: locale.exec,
    client: opts.client,
    project: opts.project,
    monthFull: locale.months[now.getMonth()],
    year: now.getFullYear(),
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
    advisorSection,
  };

  return render(executiveTemplate, context);
}

export function executiveReportFilename(client: string, project: string): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `[${client} ${project}] Report OSV Scanner - ${year}-${month} - ${monthName(now)}.md`;
}

/**
 * Filename for the consolidated (per-run) markdown report.
 * Example: "consolidated-my-project-2026-04-14.md"
 */
export function consolidatedReportFilename(project: string, date: string): string {
  const slug = project.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `consolidated-${slug}-${date}.md`;
}

/**
 * Filename for the separate SonarQube markdown report artifact.
 * Example: "sonarqube-my-project-2026-04-14.md"
 */
export function sonarqubeReportFilename(project: string, date: string): string {
  const slug = project.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `sonarqube-${slug}-${date}.md`;
}

/**
 * Generate a standalone SonarQube markdown report artifact.
 * Returns null when SonarQube results are absent or skipped.
 *
 * This is intentionally a lightweight summary — full SonarQube data continues
 * to appear inline in the consolidated and executive reports.
 */
export function generateSonarQubeMarkdownReport(
  engineResults: Record<string, ScanResultJson> | undefined,
  project: string,
  locale?: import('@core/types/locale').SupportedLocale,
): string | null {
  const reportLocale = getLocale(locale);
  const section = buildSonarQubeExecSection(engineResults, reportLocale.exec);
  if (!section.present || section.skipped) return null;

  const lines: string[] = [];
  lines.push(`# SonarQube — ${project}`);
  lines.push('');

  if (section.warning) {
    lines.push(`> ⚠️ ${section.warning}`);
    lines.push('');
  }

  if (section.qualityGate) {
    lines.push(`**Quality Gate:** ${section.qualityGate}`);
    lines.push('');
  }

  if (section.metrics && section.metrics.length > 0) {
    lines.push('## Metrics');
    lines.push('');
    lines.push('| Metric | Value |');
    lines.push('|--------|-------|');
    for (const m of section.metrics) {
      lines.push(`| ${m.key} | ${m.value} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
