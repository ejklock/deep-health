import type { ExecutionEnv, PhaseStatus, VulnerabilityClass } from './common';
import type { SonarQubeScanMetadata } from './sonarqube';

export type { SonarQubeScanMetadata, SonarQubeQualityGateCondition, SonarQubeIssue } from './sonarqube';

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
  /** Discriminator for breaking-classified packages. Only set when classification === 'breaking'. */
  breakingReason?: 'major-bump' | 'protected-constraint';
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
 * Zero-state factory for an ecosystem scan result.
 * Kept here (neutral/core) so updater plugins and scanner engines
 * can both use it without creating a cross-layer dependency.
 */
export function emptyEcosystem(): EcosystemScanResult {
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

/**
 * Canonical scan result produced by a single scanner engine.
 */
export interface ScanResultJson {
  $schema: string;
  agent: string;
  status: PhaseStatus;
  environment: ExecutionEnv;
  ecosystems: Record<string, EcosystemScanResult>;
  error: string | null;
  /**
   * Git branch name at the time of the scan, if known.
   * `null` or absent when the branch could not be determined (detached HEAD, CI checkout-by-SHA, etc.).
   */
  branch?: string | null;
  /**
   * Engine-specific metadata. Optional — OSV does not populate this field.
   * SonarQube populates quality gate status and basic metrics here.
   * Typed as {@link SonarQubeScanMetadata} — consumers should use direct property access.
   * Consumers should not rely on this for Gate A or update orchestration.
   */
  metadata?: SonarQubeScanMetadata;
}
