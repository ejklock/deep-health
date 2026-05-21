import { logger } from '@infra/utils/logger';

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
