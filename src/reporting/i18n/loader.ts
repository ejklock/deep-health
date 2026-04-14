import type { RawLocale } from './raw-locale';
import type { Locale } from './types';

function interp(str: string, vars: Record<string, string | number>): string {
  return str.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(vars[k] ?? ''));
}

export function buildLocale(raw: RawLocale): Locale {
  return {
    months: raw.months,

    pkg_count(vulnCount, pkgCount, ecosystem, names) {
      const tmpl = pkgCount === 1 ? raw.pkg_count.one : raw.pkg_count.other;
      return interp(tmpl, { vulnCount, pkgCount, ecosystem, namesSuffix: names ? `: ${names}` : '' });
    },

    reason: {
      no_safe_version: raw.reason.no_safe_version,
      major_bump: (version) => interp(raw.reason.major_bump, { version }),
      major_bump_generic: raw.reason.major_bump_generic,
      protected_constraint: (constraint) => interp(raw.reason.protected_constraint, { constraint }),
    },

    status: raw.status,

    exec: {
      ...raw.exec,
      scan_summary: (total, ecoLabels) => interp(raw.exec.scan_summary, { total, ecoLabels }),
      scan_after_summary_generic: (total, ecoLabels) => interp(raw.exec.scan_after_summary_generic, { total, ecoLabels }),
      ecosystem_evidence_title: (ecoLabel) => interp(raw.exec.ecosystem_evidence_title, { ecoLabel }),
      validation_verified: (validationLabel, detail) => interp(raw.exec.validation_verified, { validationLabel, detail }),
      fixed_version: (version) => interp(raw.exec.fixed_version, { version }),
      sonarqube_quality_gate: (status) => interp(raw.exec.sonarqube_quality_gate, { status }),
      sonarqube_warning: (message) => interp(raw.exec.sonarqube_warning, { message }),
      advisor_header: (name) => interp(raw.exec.advisor_header, { name }),
      advisor_output: (output) => interp(raw.exec.advisor_output, { output }),
    },

    consolidated: {
      ...raw.consolidated,
      title: (projectName) => interp(raw.consolidated.title, { projectName }),
      ecosystem_header: (name) => interp(raw.consolidated.ecosystem_header, { name }),
      sonarqube_quality_gate: (status) => interp(raw.consolidated.sonarqube_quality_gate, { status }),
      sonarqube_warning: (message) => interp(raw.consolidated.sonarqube_warning, { message }),
      advisor_header: (name) => interp(raw.consolidated.advisor_header, { name }),
      advisor_output: (output) => interp(raw.consolidated.advisor_output, { output }),
    },
  };
}
