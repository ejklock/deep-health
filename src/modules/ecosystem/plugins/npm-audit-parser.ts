import type { AdvisorFinding } from '@core/types/report';

/**
 * Parse npm audit --json output into structured AdvisorFindings.
 *
 * npm audit JSON schema (v7+):
 * {
 *   vulnerabilities: {
 *     [packageName]: {
 *       name: string, severity: string, range: string,
 *       nodes: string[], fixAvailable: boolean | { name, version, ... },
 *       via: Array<string | { title, url, severity, range }>
 *     }
 *   }
 * }
 *
 * Returns an empty array when the structure is unrecognized (valid JSON, no vulnerabilities key).
 * Throws a SyntaxError when the raw string is not valid JSON so the caller can emit 'error' status.
 * @internal exported for unit testing only
 */
export function parseNpmAuditJson(raw: string): AdvisorFinding[] {
  // Let JSON.parse throw naturally — caller is responsible for catching and emitting 'error'.
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object') return [];

  const obj = parsed as Record<string, unknown>;
  const vulnerabilities = obj['vulnerabilities'];
  if (!vulnerabilities || typeof vulnerabilities !== 'object') return [];

  const findings: AdvisorFinding[] = [];
  for (const [pkgName, vuln] of Object.entries(vulnerabilities as Record<string, unknown>)) {
    if (!vuln || typeof vuln !== 'object') continue;
    const v = vuln as Record<string, unknown>;

    const severity = typeof v['severity'] === 'string' ? v['severity'] : 'unknown';
    const range = typeof v['range'] === 'string' ? v['range'] : undefined;

    // Extract a title from the first non-string via entry
    let title = 'Vulnerability';
    const via = v['via'];
    if (Array.isArray(via)) {
      for (const entry of via) {
        if (entry && typeof entry === 'object' && 'title' in entry && typeof (entry as Record<string, unknown>)['title'] === 'string') {
          title = (entry as Record<string, unknown>)['title'] as string;
          break;
        }
      }
    }

    // fixAvailable: false | true | { name, version, isSemVerMajor? }
    let fixAvailable: string | undefined;
    const fa = v['fixAvailable'];
    if (fa && typeof fa === 'object' && 'version' in fa && typeof (fa as Record<string, unknown>)['version'] === 'string') {
      fixAvailable = (fa as Record<string, unknown>)['version'] as string;
    }

    findings.push({ package: pkgName, severity, title, range, fixAvailable });
  }

  return findings;
}
