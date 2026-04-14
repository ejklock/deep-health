import type { ExecutionEnv } from './common';
import type { SupportedLocale } from './locale';
// AdvisorResult has moved to report.ts; re-exported here for backward compatibility.
export type { AdvisorResult } from './report';

export interface ProtectedPackage {
  package: string;
  constraint: string;
  reason: string;
}

/**
 * Execution runtime — only the fields needed to invoke commands.
 * Language-specific runtime settings (php, node) have been moved to
 * the declarative ecosystems[] array.
 */
export interface RuntimeConfig {
  execution: ExecutionEnv;
  docker_service: string;
  docker_workdir?: string;
}

/** Strategy id for automated fixer engines */
export type FixerStrategyId = 'osv' | 'npm-audit';

/** Output format for generated reports */
export type OutputFormat = 'markdown';

/** Per-ecosystem advisor configuration */
export interface AdvisorConfig {
  name: string;
  command: string;
}

/** Per-ecosystem validation command configuration */
export interface ValidationCommandConfig {
  name: string;
  command: string;
}

/** OSV scanner engine configuration */
export interface OsvScannerConfig {
  /** Additional CLI args forwarded to osv-scanner */
  args?: string[];
}

/** Outputs/reports configuration */
export interface OutputsConfig {
  formats?: OutputFormat[];
  dir?: string;
}

/** Declarative ecosystem configuration entry */
export interface EcosystemConfig {
  /** Plugin id: 'npm', 'composer', etc. */
  id: string;
  /** Runtime version hint (e.g. '8.2', '20.x') — informational */
  version?: string;
  /**
   * Fixer strategy to apply when remediating vulnerabilities.
   * Defaults to the plugin's primary supported fixer.
   */
  fixer?: FixerStrategyId;
  /** Validation commands to run after updates */
  validationCommands?: ValidationCommandConfig[];
  /** Advisor commands to run for this ecosystem */
  advisors?: AdvisorConfig[];
}

export interface CloudStorageConfig {
  provider: 'google_drive';
  folder_id: string;
  credentials?: string;
  credentials_env?: string;
}

/**
 * SonarQube project_key validation.
 *
 * SonarQube project keys must match the pattern:
 *   - Only letters (a-z, A-Z), digits (0-9), hyphens (-), underscores (_), periods (.), and colons (:)
 *   - At least one character
 *
 * References: https://docs.sonarsource.com/sonarqube/latest/project-administration/project-settings/
 */
export const SONARQUBE_PROJECT_KEY_REGEX = /^[a-zA-Z0-9\-_.:][-a-zA-Z0-9_.:]*$/;

/**
 * Returns true if the given string is a valid SonarQube project key.
 * Valid keys contain only letters, digits, hyphens, underscores, periods, and colons.
 */
export function isValidSonarProjectKey(key: string): boolean {
  return SONARQUBE_PROJECT_KEY_REGEX.test(key);
}

export interface SonarQubeConfig {
  enabled: boolean;
  /**
   * 'external' (default): connect to a pre-existing SonarQube instance at host_url.
   * 'managed': provision an ephemeral SonarQube CE Docker container automatically.
   */
  mode: 'external' | 'managed';
  host_url: string;
  project_key: string;
  /** Name of the environment variable holding the SonarQube token. Defaults to SONAR_TOKEN. */
  token_env: string;
  /** What to do when SonarQube scan fails: 'warn' (default) or 'fail'. */
  on_failure: 'warn' | 'fail';
  /**
   * Docker image tag for the sonar-scanner-cli container used in the container fallback path.
   * Only relevant when `mode` is 'managed' and local sonar-scanner is unavailable.
   * Defaults to 'sonarsource/sonar-scanner-cli:latest'.
   * Example: 'sonarsource/sonar-scanner-cli:5.0' to pin to a specific version.
   */
  scanner_image?: string;
}

export interface ScannersConfig {
  sonarqube?: SonarQubeConfig;
  osv?: OsvScannerConfig;
}

export interface SafeUpdatePolicy {
  allow_patch_and_minor_within_constraints: boolean;
  require_authorization_for_constraint_change: boolean;
}

export interface ProjectConfig {
  project: {
    name: string;
    client: string;
  };
  runtime: RuntimeConfig;
  /**
   * Declarative list of ecosystems to scan/update.
   * At least one entry is required.
   */
  ecosystems: EcosystemConfig[];
  protected_packages: Record<string, ProtectedPackage[]>;
  safe_update_policy: SafeUpdatePolicy;
  conflict_resolution: string;
  reports_dir?: string;
  report_language?: SupportedLocale;
  cloud_storage?: CloudStorageConfig;
  scanners?: ScannersConfig;
  outputs?: OutputsConfig;
}
