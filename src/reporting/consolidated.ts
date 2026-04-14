import type { ConsolidatedReport } from '@core/types/report';
import type { AdvisorResult } from '@core/types/report';
import type { EcosystemScanResult, ScanResultJson } from '@core/types/scan';
import { defaultRegistry } from '@modules/ecosystem/index';
import { getLocale } from './i18n/index';
import type { ConsolidatedLocale } from './i18n/types';
import { render } from './renderer';
import consolidatedTemplate from './templates/consolidated.hbs';

function emptyEcosystemResult(): EcosystemScanResult {
  return {
    vulnerabilities_total: 0,
    auto_safe: 0,
    breaking: 0,
    manual: 0,
    auto_safe_packages: [],
    breaking_packages: [],
    manual_packages: [],
    vulnerabilities: [],
  };
}

function statusLabel(s: string | undefined): string {
  return s === 'pass' ? '✅ PASS' : s === 'fail' ? '❌ FAIL' : '— skipped';
}

// ─── SonarQube section builder ───────────────────────────────────────────────

/**
 * Extract unique file paths from issue component strings.
 * Component format: "projectKey:path/to/file.ts"
 */
function extractFilePaths(
  issues: Array<{ component: string; message: string; severity: string; rule: string }>,
): string[] {
  const seen = new Set<string>();
  for (const issue of issues) {
    const colon = issue.component.indexOf(':');
    const file = colon >= 0 ? issue.component.slice(colon + 1) : issue.component;
    seen.add(file);
  }
  return [...seen];
}

interface SonarQubeSectionData {
  present: boolean;
  skipped: boolean;
  warning: string | null;
  qualityGate: string | null;
  qualityGatePassed: boolean | null;
  metrics: Array<{ key: string; value: string }> | null;
  affectedFiles: string[] | null;
  noIssues: boolean;
}

function buildSonarQubeConsolidatedSection(
  engineResults: Record<string, ScanResultJson> | undefined,
  warnings: Array<{ engineId: string; message: string }> | undefined,
  locale: ConsolidatedLocale,
): SonarQubeSectionData {
  // No engineResults provided at all — section is absent
  if (!engineResults) {
    return { present: false, skipped: false, warning: null, qualityGate: null, qualityGatePassed: null, metrics: null, affectedFiles: null, noIssues: false };
  }

  const sonarResult = engineResults['sonarqube'];

  // Engine warning (sonarqube failed with warn policy)
  const engineWarning = warnings?.find((w) => w.engineId === 'sonarqube');
  if (engineWarning && !sonarResult) {
    return { present: true, skipped: false, warning: locale.sonarqube_warning(engineWarning.message), qualityGate: null, qualityGatePassed: null, metrics: null, affectedFiles: null, noIssues: false };
  }

  // SonarQube not in engineResults — skipped/absent
  if (!sonarResult) {
    return { present: false, skipped: false, warning: null, qualityGate: null, qualityGatePassed: null, metrics: null, affectedFiles: null, noIssues: false };
  }

  // Status = skipped
  if (sonarResult.status === 'skipped') {
    return { present: true, skipped: true, warning: null, qualityGate: null, qualityGatePassed: null, metrics: null, affectedFiles: null, noIssues: false };
  }

  // Status = error
  if (sonarResult.status === 'error') {
    const msg = sonarResult.error ?? 'scan error';
    return { present: true, skipped: false, warning: locale.sonarqube_warning(msg), qualityGate: null, qualityGatePassed: null, metrics: null, affectedFiles: null, noIssues: false };
  }

  // Success — extract metadata
  const meta = sonarResult.metadata ?? {};

  const qualityGateStatus = meta['qualityGateStatus'] as string | undefined;
  const qualityGatePassed = meta['qualityGatePassed'] as boolean | undefined;
  const qualityGateLabel = qualityGateStatus
    ? locale.sonarqube_quality_gate(qualityGateStatus === 'OK' ? '✅ OK' : qualityGateStatus === 'ERROR' ? '❌ ERROR' : qualityGateStatus)
    : null;

  const rawMetrics = meta['metrics'] as Record<string, string> | undefined;
  const metricsForDisplay = rawMetrics
    ? Object.entries(rawMetrics).map(([key, value]) => ({ key, value }))
    : null;

  const rawIssues = meta['issues'] as Array<{ component: string; message: string; severity: string; rule: string }> | undefined;
  const affectedFiles = rawIssues && rawIssues.length > 0 ? extractFilePaths(rawIssues) : null;
  const noIssues = rawIssues !== undefined && rawIssues.length === 0;

  return {
    present: true,
    skipped: false,
    warning: null,
    qualityGate: qualityGateLabel,
    qualityGatePassed: qualityGatePassed ?? null,
    metrics: metricsForDisplay,
    affectedFiles,
    noIssues,
  };
}

// ─── Advisor section builder ─────────────────────────────────────────────────

interface AdvisorSectionData {
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

function buildAdvisorConsolidatedSection(
  advisorResults: Record<string, AdvisorResult[]> | undefined,
  locale: ConsolidatedLocale,
): AdvisorSectionData {
  if (!advisorResults) {
    return { present: false, ecosystems: [] };
  }

  const ecosystems: AdvisorSectionData['ecosystems'] = [];

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

export function generateConsolidatedReport(data: ConsolidatedReport): string {
  const locale = getLocale(data.locale);
  const scan = data.scan;
  const ecosystemEntries = Object.entries(scan.ecosystems);
  const totalVulns = ecosystemEntries.reduce((sum, [, e]) => sum + e.vulnerabilities_total, 0);

  const breakingPkgs = ecosystemEntries.flatMap(([id, e]) =>
    e.breaking_packages.map((p) => `[${id.toUpperCase()}] ${p}`),
  );
  const manualPkgs = ecosystemEntries.flatMap(([id, e]) =>
    e.manual_packages.map((p) => `[${id.toUpperCase()}] ${p}`),
  );

  // Build per-ecosystem sections driven by registry plugins
  const plugins = defaultRegistry.getAll();
  const ecosystemSections = plugins.map((plugin) => {
    const eco = scan.ecosystems[plugin.id] ?? emptyEcosystemResult();
    const update = data.updates[plugin.id] ?? null;

    // Render all validations generically — no fixed names assumed
    const validationEntries = (update?.validations ?? []).map((v) => ({
      name: v.name,
      statusLabel: statusLabel(v.status),
      detail: v.detail ?? '',
      hasDetail: !!(v.detail && v.detail.trim()),
    }));
    const hasValidations = validationEntries.length > 0;

    const updatedPackages = update?.packages_updated?.length ? update.packages_updated : null;

    return {
      id: plugin.id,
      name: plugin.name,
      reportLabel: plugin.reportLabel,
      ecosystemHeader: locale.consolidated.ecosystem_header(plugin.name),
      eco,
      update,
      hasValidations,
      validationEntries,
      updatedPackages,
    };
  });

  // Build SonarQube section (graceful: absent when engineResults not provided)
  const sonarSection = buildSonarQubeConsolidatedSection(
    data.engineResults,
    // engineResults may carry warnings via the report data — none here, warnings
    // are passed through CLI via engineResults presence/status
    undefined,
    locale.consolidated,
  );

  // Build advisor section
  const advisorSection = buildAdvisorConsolidatedSection(data.advisorResults, locale.consolidated);

  const context: Record<string, unknown> = {
    t: {
      ...locale.consolidated,
      title: locale.consolidated.title(data.projectName),
    },
    date: data.date,
    environment: data.environment,
    branch: data.branch ?? null,
    hasBranch: typeof data.branch === 'string' && data.branch.length > 0,
    scannerEngines: data.scannerEngines && data.scannerEngines.length > 0 ? data.scannerEngines.join(', ') : null,
    totalVulns,
    ecosystemSections,
    pendingItems: breakingPkgs.length > 0 || manualPkgs.length > 0,
    breakingPkgs: breakingPkgs.length ? breakingPkgs : null,
    manualPkgs: manualPkgs.length ? manualPkgs : null,
    sonarSection,
    advisorSection,
  };

  return render(consolidatedTemplate, context);
}

