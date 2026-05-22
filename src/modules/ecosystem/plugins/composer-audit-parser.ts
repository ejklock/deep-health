import { logger } from '@infra/utils/logger';

/**
 * Structured advisory entry returned by parseComposerAuditAdvisories.
 * One entry per package (not per advisory item — multiple advisories for the same
 * package are collapsed: first CVE found, first title).
 */
export interface ComposerAuditAdvisory {
  package: string;
  advisoryId: string;
  title: string;
  cve: string | null;
  affectedVersions: string;
}

/**
 * Parse `composer audit --format=json` output and return structured advisory objects.
 *
 * Same JSON source as parseComposerAuditJson but returns rich objects instead of
 * plain package name strings. One ComposerAuditAdvisory per package key in the
 * advisories map (takes the first advisory entry for that package).
 *
 * Returns [] on:
 * - empty/clean audit output (advisories is {} or [])
 * - malformed or empty JSON input
 * - any parse failure
 *
 * Never throws.
 */
export function parseComposerAuditAdvisories(raw: string): ComposerAuditAdvisory[] {
  if (!raw || !raw.trim()) return [];

  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return [];

    const obj = parsed as Record<string, unknown>;
    const advisories = obj['advisories'];

    if (!advisories || typeof advisories !== 'object' || Array.isArray(advisories)) return [];

    const result: ComposerAuditAdvisory[] = [];
    const seen = new Set<string>();

    for (const [packageName, advisoryList] of Object.entries(advisories as Record<string, unknown>)) {
      if (seen.has(packageName)) continue;
      seen.add(packageName);

      const list = Array.isArray(advisoryList) ? advisoryList : [];
      const first = list[0] as Record<string, unknown> | undefined;

      result.push({
        package: packageName,
        advisoryId: typeof first?.['advisoryId'] === 'string' ? first['advisoryId'] : '',
        title: typeof first?.['title'] === 'string' ? first['title'] : '',
        cve: typeof first?.['cve'] === 'string' ? first['cve'] : null,
        affectedVersions: typeof first?.['affectedVersions'] === 'string' ? first['affectedVersions'] : '',
      });
    }

    return result;
  } catch (err) {
    logger.tagged(
      'composer',
      'audit-parser',
      `Failed to parse composer audit JSON: ${err instanceof Error ? err.message : String(err)}`,
      'warn',
    );
    return [];
  }
}

/**
 * Parse `composer audit --format=json` output and return unique package names with advisories.
 *
 * composer audit JSON schema:
 * {
 *   advisories: {
 *     "vendor/package": [ { advisoryId, packageName, affectedVersions, title, cve, ... } ]
 *   }
 * }
 *
 * When the audit is clean, composer returns: { advisories: {} } or { advisories: [] }
 *
 * Returns string[] of unique package names. Returns [] on:
 * - empty/clean audit output
 * - malformed or empty JSON input
 * - any parse failure
 *
 * Never throws.
 */
export function parseComposerAuditJson(raw: string): string[] {
  if (!raw || !raw.trim()) return [];

  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return [];

    const obj = parsed as Record<string, unknown>;
    const advisories = obj['advisories'];

    // Clean audit: { advisories: [] } or missing advisories key
    if (!advisories || typeof advisories !== 'object' || Array.isArray(advisories)) return [];

    const names = Object.keys(advisories as Record<string, unknown>);
    // Deduplicate (composer should not repeat keys, but be defensive)
    return [...new Set(names)];
  } catch (err) {
    logger.tagged(
      'composer',
      'audit-parser',
      `Failed to parse composer audit JSON: ${err instanceof Error ? err.message : String(err)}`,
      'warn',
    );
    return [];
  }
}
