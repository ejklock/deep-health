import type { ExecutionEnv } from './common';
import type { SupportedLocale } from './locale';

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
}

export interface ScannersConfig {
  sonarqube?: SonarQubeConfig;
  osv?: OsvScannerConfig;
}

export interface SafeUpdatePolicy {
  allow_patch_and_minor_within_constraints: boolean;
  require_authorization_for_constraint_change: boolean;
  authorization_format: string;
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

/** Result produced by an advisor command execution */
export interface AdvisorResult {
  name: string;
  command: string;
  /** Exit code of the advisor command */
  exitCode: number;
  /** Last N lines of stdout (truncated for reports; full output in logs) */
  output: string;
  status: 'pass' | 'fail' | 'skipped';
}
