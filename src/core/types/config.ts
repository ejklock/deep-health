import type { SupportedLocale } from './locale';

export interface ProtectedPackage {
  package: string;
  constraint: string;
  reason: string;
}

/** Strategy id for automated fixer engines */
export type FixerStrategyId = 'osv' | 'npm-audit';

/** Output format for generated reports */
export type OutputFormat = 'markdown';

/** Per-ecosystem advisor configuration */
export interface AdvisorConfig {
  name: string;
  command: string;
  /**
   * Output format expected from the advisor command.
   * - 'json': parse structured JSON output (e.g. `npm audit --json`).
   * - 'text': treat output as plain text (default).
   */
  format?: 'json' | 'text';
}

/** Per-ecosystem validation command configuration */
export interface ValidationCommandConfig {
  name: string;
  command: string;
}

/** Runner selection for OSV scanner */
export type OsvRunnerMode = 'auto' | 'docker' | 'local';

/** Runner selection for npm commands */
export type NpmRunnerMode = 'auto' | 'docker' | 'local';

/** OSV scanner engine configuration */
export interface OsvScannerConfig {
  /** Additional CLI args forwarded to osv-scanner */
  args?: string[];
  /**
   * Runner selection strategy (default: 'docker').
   * - 'docker': always run osv-scanner via an ephemeral Docker container. ← DEFAULT
   * - 'local':  always use the local osv-scanner binary; fail if not installed.
   * - 'auto':   try local first; fall back to Docker if unavailable. ⚠ DEPRECATED escape hatch — emits a warning.
   */
  runner?: OsvRunnerMode;
  /**
   * Docker image to use when runner is 'docker'.
   * Defaults to 'ghcr.io/google/osv-scanner:latest'.
   * Example: 'ghcr.io/google/osv-scanner:v1.9.0'
   */
  image?: string;
}

/** npm runner configuration */
export interface NpmRunnerConfig {
  /**
   * Runner selection strategy (default: 'docker').
   * - 'docker': run npm via an ephemeral Node Docker container. ← DEFAULT
   * - 'local':  use the locally installed npm binary. ⚠ emits a warning.
   * - 'auto':   try local npm first; fall back to Docker. ⚠ DEPRECATED escape hatch — emits a warning.
   */
  mode?: NpmRunnerMode;
  /**
   * Docker image to use when mode is 'docker'.
   * When absent, the image is resolved from the inferred/configured Node version
   * (e.g. Node 20 → 'node:20-slim').  Falls back to 'node:lts-slim'.
   */
  image?: string;
}

/** Outputs/reports configuration */
export interface OutputsConfig {
  formats?: OutputFormat[];
  dir?: string;
  /**
   * When true, engine-specific reports are written to sub-folders inside the reports dir:
   *   - SonarQube artifacts → {dir}/sonarqube/
   * Consolidated and executive reports always stay at the root of the reports dir.
   * Defaults to false (flat layout — all files at the root level).
   */
  sub_folders?: boolean;
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
  /**
   * When true, forwards the detected git branch as `-Dsonar.branch.name` to sonar-scanner.
   *
   * WARNING: Branch analysis requires SonarQube Developer Edition or higher.
   * Community Edition (CE) does NOT support branch analysis — enabling this on CE will
   * cause sonar-scanner to fail with an "invalid branch" or licensing error.
   *
   * Defaults to false (CE-safe). Only set to true if you have a paid SonarQube edition
   * and branch analysis is configured on your SonarQube instance.
   */
  send_branch_name?: boolean;
  /**
   * Maximum seconds to wait for the SonarQube Compute Engine (CE) task to complete
   * before fetching the quality gate status.  Polling uses exponential back-off.
   *
   * When the CE task completes within the timeout, quality gate results are accurate.
   * If the timeout is exceeded, the engine falls back to an immediate quality-gate
   * fetch (best-effort) and emits a warning — the pipeline is NOT hard-failed.
   *
   * Defaults to 120 seconds.  Set to 0 to disable CE waiting entirely.
   */
  ce_task_timeout_seconds?: number;
  /**
   * Glob patterns forwarded to sonar-scanner as `-Dsonar.exclusions`.
   * When absent, ecosystem-specific defaults are used:
   *   - npm:      node_modules/**, tests/**
   *   - composer: vendor/**, tests/**
   * If explicitly set (even to an empty array), the value is used as-is (full override —
   * no merging with defaults).
   */
  exclusions?: string[];
  /**
   * Glob patterns forwarded to sonar-scanner as `-Dsonar.coverage.exclusions`.
   * When absent, ecosystem-specific defaults are used:
   *   - npm:      node_modules/**, tests/**
   *   - composer: vendor/**, tests/**
   * If explicitly set (even to an empty array), the value is used as-is (full override —
   * no merging with defaults).
   */
  coverage_exclusions?: string[];
}

export interface ScannersConfig {
  sonarqube?: SonarQubeConfig;
  osv?: OsvScannerConfig;
  npm?: NpmRunnerConfig;
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
