import type { ExecutionEnv, PhaseStatus, VulnerabilityClass } from './common.js';

export interface VulnerabilityEntry {
  ecosystem: string;
  package: string;
  currentVersion: string;
  safeVersion: string | null;
  cvss: string;
  ghsaId: string;
  risk: string;
  classification: VulnerabilityClass;
  reason: string;
  /**
   * Which scanner engine produced this entry.
   * Optional for backwards compatibility — OSV entries omit this field in Phase 0.
   * Phase 1+: SonarQube and other engines will set this to their engine id.
   */
  sourceEngine?: string;
}

export interface EcosystemScanResult {
  vulnerabilities_total: number;
  auto_safe: number;
  breaking: number;
  manual: number;
  auto_safe_packages: string[];
  breaking_packages: string[];
  manual_packages: string[];
  vulnerabilities: VulnerabilityEntry[];
}

/**
 * Canonical scan result produced by a single scanner engine.
 *
 * Phase 0: $schema and agent were literal string unions; now broadened to string
 * to support multiple engines without changing the runtime shape.
 * Existing values ('osv-scan-result/v1', 'osv-scanner') remain the only values
 * emitted in Phase 0 — the type simply no longer enforces the literal.
 */
export interface ScanResultJson {
  $schema: string;
  agent: string;
  status: PhaseStatus;
  environment: ExecutionEnv;
  ecosystems: Record<string, EcosystemScanResult>;
  error: string | null;
}
