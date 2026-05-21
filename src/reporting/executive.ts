import type { ExecutiveReportOptions, ResidualVerification } from '@core/types/report';
import type { VulnerabilityEntry, ScanResultJson } from '@core/types/scan';
import type { Locale } from './i18n/index';
import { defaultRegistry } from '@modules/ecosystem/index';
import { getLocale } from './i18n/index';
import { render } from './renderer';
import executiveTemplate from './templates/executive.hbs';
import { buildSonarQubeExecSection } from './sonarqube-exec-section';
import { buildAdvisorExecSection } from './advisor-exec-section';

// ── deduplication ───────────────────────────────────────────────────────────

type VulnerabilityClass = 'auto_safe' | 'breaking' | 'manual';

type AggregatedVulnEntry = VulnerabilityEntry & {
  affectedVersions: string[];
  instanceCount: number;
};

const CLASS_RANK: Record<VulnerabilityClass, number> = { auto_safe: 0, breaking: 1, manual: 2 };

function dedupVulns(entries: VulnerabilityEntry[]): AggregatedVulnEntry[] {
  const groups = new Map<string, VulnerabilityEntry[]>();
  for (const entry of entries) {
    const key = `${entry.ecosystem}|${entry.ghsaId ?? 'no-ghsa'}|${entry.package}`;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }

  return [...groups.values()].map((group) => {
    const first = group[0]!;
    const affectedVersions = [...new Set(group.map((v) => v.currentVersion))];

    const maxCvss = group.reduce<string | null>((best, v) => {
      const n = parseFloat(v.cvss);
      const b = best !== null ? parseFloat(best) : NaN;
      if (!isNaN(n) && (isNaN(b) || n > b)) return v.cvss;
      return best;
    }, null);

    const safeVersion = group.find((v) => v.safeVersion != null)?.safeVersion ?? null;

    const worstClass = group.reduce<VulnerabilityClass>((worst, v) => {
      return (CLASS_RANK[v.classification] ?? 0) > (CLASS_RANK[worst] ?? 0) ? v.classification : worst;
    }, first.classification);

    const minVersion = affectedVersions.slice().sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0] ?? first.currentVersion;

    return {
      ...first,
      currentVersion: minVersion,
      cvss: maxCvss ?? first.cvss,
      safeVersion,
      classification: worstClass,
      affectedVersions,
      instanceCount: group.length,
    };
  });
}

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

// ── context builder ──────────────────────────────────────────────────────────

export function buildExecutiveReportContext(opts: ExecutiveReportOptions): Record<string, unknown> {
  const locale = getLocale(opts.locale);
  const now = new Date();

  // Resolve residual verification state — use the explicit union type.
  const residualVerification: ResidualVerification = opts.residualVerification ?? { status: 'skipped' };

  // Build per-ecosystem update name sets (for determining fixed vs pending)
  const plugins = defaultRegistry.getAll();

  // Clone the top-level scanBefore so we never mutate the original. For each plugin
  // that carries audit_findings, deep-clone its ecosystem entry and push synthetic
  // entries so the existing fixedVulns/pendingVulns filters naturally include them.
  let effectiveScanBefore: ScanResultJson = opts.scanBefore;

  for (const plugin of plugins) {
    const auditFindings = opts.updates[plugin.id]?.audit_findings;
    if (!auditFindings || auditFindings.length === 0) continue;

    // Clone the top-level object (shallow) plus the ecosystems map on first mutation.
    if (effectiveScanBefore === opts.scanBefore) {
      effectiveScanBefore = { ...opts.scanBefore, ecosystems: { ...opts.scanBefore.ecosystems } };
    }

    // Deep-clone the specific ecosystem entry we need to mutate.
    const existingEco = effectiveScanBefore.ecosystems[plugin.id];
    const clonedEco = existingEco
      ? structuredClone(existingEco)
      : { vulnerabilities_total: 0, auto_safe: 0, breaking: 0, manual: 0, auto_safe_packages: [], breaking_packages: [], manual_packages: [], vulnerabilities: [] };

    for (const finding of auditFindings) {
      const syntheticEntry: VulnerabilityEntry = {
        ecosystem: plugin.id,
        package: finding.package,
        ghsaId: finding.advisoryId,
        cvss: '—',
        risk: finding.title,
        currentVersion: finding.affectedVersions,
        safeVersion: null,
        classification: 'auto_safe',
        reason: '',
      };
      clonedEco.vulnerabilities.push(syntheticEntry);
      clonedEco.vulnerabilities_total += 1;
      clonedEco.auto_safe += 1;
    }

    effectiveScanBefore.ecosystems[plugin.id] = clonedEco;
  }

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
    ...Object.values(effectiveScanBefore.ecosystems).flatMap((e) => e.vulnerabilities),
  ];

  // Fixed vulns: auto_safe and in the updated set for their ecosystem
  const fixedVulns = dedupVulns(
    allVulnsBefore.filter((v) => {
      const names = updatedNamesByEco.get(v.ecosystem) ?? new Set();
      return v.classification === 'auto_safe' && names.has(v.package);
    }),
  ).map((v) => {
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
      ghsaId: v.ghsaId,
      cvss: v.cvss,
      package: v.package,
      affectedVersions: v.affectedVersions.join(', '),
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

  const pendingVulns = dedupVulns(pendingOriginal).map((v) => {
    const plugin = defaultRegistry.findByOsvEcosystem(v.ecosystem) ?? defaultRegistry.get(v.ecosystem);
    return {
      ecoLabel: plugin?.reportLabel ?? v.ecosystem,
      ghsaLink: ghsaLink(v.ghsaId),
      ghsaId: v.ghsaId,
      cvss: v.cvss,
      package: v.package,
      affectedVersions: v.affectedVersions.join(', '),
      motivoPt: motivoStr(v, locale),
    };
  });

  // Per-plugin evidence sections
  const evidenceSections = plugins.map((plugin) => {
    const ecoScan = effectiveScanBefore.ecosystems[plugin.id];
    const update = opts.updates[plugin.id] ?? null;
    const updatedNames = updatedNamesByEco.get(plugin.id) ?? new Set();

    const installedVersions = installedVersionsByEco.get(plugin.id) ?? new Map<string, string>();
    // Use the explicit verification state: only show residual warning when 'unverified'
    const residualCount = residualVerification.status !== 'skipped'
      ? (residualVerification.summary[plugin.id] ?? 0)
      : null;
    const isUnverified = residualVerification.status === 'unverified';
    const rawVulnsAfter = (ecoScan?.vulnerabilities ?? []).map((v) => {
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
        currentVersion: v.currentVersion,
        statusPt,
        risk: v.risk,
      };
    });
    // Deduplicate by (ghsaId, package, statusPt) — keep separate rows when status differs
    const afterGroups = new Map<string, typeof rawVulnsAfter>();
    for (const row of rawVulnsAfter) {
      const key = `${row.ghsaId ?? 'no-ghsa'}|${row.package}|${row.statusPt}`;
      const group = afterGroups.get(key) ?? [];
      group.push(row);
      afterGroups.set(key, group);
    }
    const vulnsAfter = [...afterGroups.values()].map((group) => {
      const first = group[0]!;
      const affectedVersions = [...new Set(group.map((r) => r.currentVersion))].join(', ');
      return {
        ghsaId: first.ghsaId,
        cvss: first.cvss,
        package: first.package,
        affectedVersions,
        statusPt: first.statusPt,
        risk: first.risk,
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
      const eco = effectiveScanBefore.ecosystems[plugin.id];
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

  // Build advisor section (graceful: absent when advisorResults not provided)
  const advisorSection = buildAdvisorExecSection(opts.advisorResults, locale.exec);

  return {
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
    allVulnsBefore: dedupVulns(allVulnsBefore).map((v) => {
      const plugin = defaultRegistry.findByOsvEcosystem(v.ecosystem) ?? defaultRegistry.get(v.ecosystem);
      return {
        ecoLabel: plugin?.reportLabel ?? v.ecosystem,
        ghsaId: v.ghsaId,
        cvss: v.cvss,
        package: v.package,
        affectedVersions: v.affectedVersions.join(', '),
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
}

export function generateExecutiveReport(opts: ExecutiveReportOptions): string {
  const context = buildExecutiveReportContext(opts);
  return render(executiveTemplate, context);
}

export function executiveReportFilename(client: string, project: string): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `[${client} ${project}] Security Report - ${year}-${month} - ${monthName(now)}.md`;
}
