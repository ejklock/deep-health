import type { ConsolidatedReport } from '@core/types/report.js';
import type { EcosystemScanResult, ScanResultJson } from '@core/types/scan.js';
import { defaultRegistry } from '@modules/ecosystem/index.js';
import { getLocale } from './i18n/index.js';
import type { ConsolidatedLocale } from './i18n/types.js';
import { render } from './renderer.js';
import consolidatedTemplate from './templates/consolidated.hbs.js';

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

    // Resolve validation status and detail from the canonical validations[] array
    const validationEntry = update?.validations?.find((v) => v.name === plugin.validationName);
    const validationStatus = update ? statusLabel(validationEntry?.status) : null;
    const validationDetail = validationEntry?.detail ?? '';

    const updatedPackages = update?.packages_updated?.length ? update.packages_updated : null;

    return {
      id: plugin.id,
      name: plugin.name,
      reportLabel: plugin.reportLabel,
      validationLabel: plugin.validationLabel,
      ecosystemHeader: locale.consolidated.ecosystem_header(plugin.name),
      eco,
      update,
      validationStatus,
      validationDetail,
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

  const context: Record<string, unknown> = {
    t: {
      ...locale.consolidated,
      title: locale.consolidated.title(data.projectName),
    },
    date: data.date,
    environment: data.environment,
    totalVulns,
    ecosystemSections,
    pendingItems: breakingPkgs.length > 0 || manualPkgs.length > 0,
    breakingPkgs: breakingPkgs.length ? breakingPkgs : null,
    manualPkgs: manualPkgs.length ? manualPkgs : null,
    sonarSection,
  };

  return render(consolidatedTemplate, context);
}
