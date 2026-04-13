import { z } from 'zod';
import type { GateResult } from '../types/common.js';

const VulnerabilityEntrySchema = z.object({
  ecosystem: z.string(),
  package: z.string(),
  currentVersion: z.string(),
  safeVersion: z.string().nullable(),
  cvss: z.string(),
  ghsaId: z.string(),
  risk: z.string(),
  classification: z.enum(['auto_safe', 'breaking', 'manual']),
  reason: z.string(),
});

const EcosystemScanResultSchema = z.object({
  vulnerabilities_total: z.number(),
  auto_safe: z.number(),
  breaking: z.number(),
  manual: z.number(),
  auto_safe_packages: z.array(z.string()),
  breaking_packages: z.array(z.string()),
  manual_packages: z.array(z.string()),
  vulnerabilities: z.array(VulnerabilityEntrySchema),
});

const ScanResultSchema = z.object({
  $schema: z.string(),
  agent: z.string(),
  status: z.enum(['success', 'error', 'skipped']),
  environment: z.enum(['docker', 'local']),
  ecosystems: z.record(z.string(), EcosystemScanResultSchema),
  error: z.string().nullable(),
});

/**
 * Schema for a single canonical validation step entry.
 * Mirrors the ValidationEntry interface in types/update.ts.
 */
const ValidationEntrySchema = z.object({
  name: z.string(),
  status: z.enum(['pass', 'fail', 'skipped']),
  detail: z.string().optional(),
});

const UpdateResultSchema = z.object({
  $schema: z.string(),
  agent: z.string(),
  status: z.enum(['success', 'error', 'skipped']),
  packages_updated: z.array(z.string()),
  packages_skipped: z.array(z.string()),
  packages_pending_breaking: z.array(z.string()),
  /**
   * Canonical validation steps array — required and must be non-empty.
   * All ecosystem plugins must emit at least one entry (pass / fail / skipped).
   * An empty array is a contract violation and will fail schema validation.
   */
  validations: z.array(ValidationEntrySchema).min(1),
  error: z.string().nullable(),
});

export function validateGateA(data: unknown): GateResult {
  const result = ScanResultSchema.safeParse(data);
  if (!result.success) {
    return {
      valid: false,
      gate: 'A',
      errors: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    };
  }
  if (result.data.status === 'error') {
    return {
      valid: false,
      gate: 'A',
      errors: [`Scanner returned error: ${result.data.error ?? 'unknown'}`],
    };
  }
  return { valid: true, gate: 'A', errors: [] };
}

/**
 * Generic ecosystem gate validator.
 * Validates the UpdateResultJson schema and checks for error status.
 * Does NOT enforce a specific agent name — that is the caller's responsibility.
 * Used by the orchestrator when iterating over registered plugins.
 */
export function validateEcosystemGate(
  ecosystemId: string,
  data: unknown,
): GateResult {
  const result = UpdateResultSchema.safeParse(data);
  if (!result.success) {
    return {
      valid: false,
      gate: ecosystemId,
      errors: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    };
  }
  if (result.data.status === 'error') {
    return {
      valid: false,
      gate: ecosystemId,
      errors: [`${ecosystemId} updater returned error: ${result.data.error ?? 'unknown'}`],
    };
  }
  return { valid: true, gate: ecosystemId, errors: [] };
}
