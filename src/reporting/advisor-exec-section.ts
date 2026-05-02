import type { AdvisorResult, AdvisorFinding } from '@core/types/report';
import { defaultRegistry } from '@modules/ecosystem/index';
import type { ExecLocale } from './i18n/types';

// ── Advisor section builder (executive) ─────────────────────────────────────

interface AdvisorFindingEntry {
  package: string;
  severity: string;
  title: string;
  range: string;
  fixAvailable: string;
}

export interface AdvisorExecSectionData {
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

export function buildAdvisorExecSection(
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
