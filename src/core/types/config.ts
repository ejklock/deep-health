import type { SupportedLocale } from "./locale";

export interface ProtectedPackage {
  package: string;
  constraint: string;
  reason: string;
}

/**
 * Strategy id for automated fixer engines.
 * - 'osv' (default for npm): use OSV in-place fix; OSV fix is coordinated by the orchestrator.
 *   Breaking changes authorized by the user are applied separately via npm at orchestration level.
 * - 'npm-audit': use `npm audit fix`; OSV fix is NOT run in this path.
 * - 'osv-then-audit': applies OSV fix first, then npm audit fix on top; validates after both;
 *   if validation fails, reverts audit-fix portion and re-validates against OSV-only state.
 */
export type FixerStrategyId = "osv" | "npm-audit" | "osv-then-audit";

/** Output format for generated reports */
export type OutputFormat = "markdown";

/** Per-ecosystem advisor configuration */
export interface AdvisorConfig {
  name: string;
  command: string;
  /**
   * Output format expected from the advisor command.
   * - 'json': parse structured JSON output (e.g. `npm audit --json`).
   * - 'text': treat output as plain text (default).
   */
  format?: "json" | "text";
}

/** Per-ecosystem validation command configuration */
export interface ValidationCommandConfig {
  name: string;
  command: string;
  /**
   * Maximum seconds to wait for this validation command to complete.
   * When exceeded, the command is killed and the validation step is failed.
   * Defaults to the runner's global timeout when not set.
   */
  timeout_seconds?: number;
}

/** Runner selection for OSV scanner */
export type OsvRunnerMode = "auto" | "docker" | "local";

/** Runner selection for npm commands */
export type NpmRunnerMode = "auto" | "docker" | "local";

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

/**
 * Image source axis — shared by npm, pip, and composer runners.
 * - 'pull' (default): pull a pre-built image from a registry.
 * - 'dockerfile': build a local image from a project-owned Dockerfile.
 *   Requires `dockerfile_path`. Mutually exclusive with `image`.
 */
export type ImageSource = 'pull' | 'dockerfile';

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
   * (e.g. Node 20 → 'node:20').  Falls back to 'node:lts'.
   * Takes precedence over `language_version`.
   * Mutually exclusive with `image_source='dockerfile'`.
   */
  image?: string;
  /**
   * Node.js language version to use when resolving the Docker image.
   * Example: '20', '20.11', '20.11.1'.
   * When set, the image is resolved as `node:<major>` (e.g. '20' → 'node:20').
   * Overrides the version inferred from project files.
   * Only used when `image` is not set.
   * Set by `deep-health init` when a Node version can be inferred from .nvmrc / .node-version / package.json.
   */
  language_version?: string;
  /**
   * Image source axis.
   * - 'pull' (default): pull a registry image.
   * - 'dockerfile': build from a project-owned Dockerfile; requires `dockerfile_path`.
   *   Mutually exclusive with `image`.
   */
  image_source?: ImageSource;
  /**
   * Path to the Dockerfile relative to the project root.
   * Required when image_source='dockerfile'.
   * Example: 'Dockerfile', '.docker/node.Dockerfile'
   */
  dockerfile_path?: string;
  /**
   * OS-level packages to install via apt-get before running npm commands.
   * Use this when a project depends on native npm addons that require system
   * libraries to compile or link (e.g. sharp → libvips-dev, canvas → libcairo2-dev).
   *
   * Packages are installed inside the ephemeral container via:
   *   apt-get update -qq && apt-get install -y --no-install-recommends <pkgs>
   *
   * Example:
   *   native_deps: [libvips-dev, build-essential, python3]
   *
   * Package names must follow Debian naming conventions (lowercase alphanumeric,
   * hyphens, dots, plus signs only).
   */
  native_deps?: readonly string[];
  /**
   * Build context path for docker build, relative to projectDir.
   * Defaults to the project root when absent.
   * Only used when image_source='dockerfile'.
   * Example: '.', 'docker/'
   */
  build_context?: string;
  /**
   * Build arguments to pass as --build-arg KEY=VALUE to docker build.
   * Only used when image_source='dockerfile'.
   * Example: { NODE_VERSION: '20', APP_ENV: 'production' }
   */
  build_args?: Record<string, string>;
  /**
   * When true, allows the Docker build context to resolve outside the project
   * boundary (git root, or projectDir when not in a git repository).
   * Only relevant when image_source='dockerfile' and build_context resolves
   * outside the allowed root.
   *
   * ⚠ Security: enabling this sends the full directory tree outside the project
   * to the Docker daemon, potentially exposing sensitive files. A warning is
   * emitted when this flag is active and the boundary is crossed.
   * Default: false.
   */
  allow_build_context_escape?: boolean;
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
  provider: "google_drive";
  folder_id: string;
  /**
   * When true, the fix/executive-report commands will fail if cloud upload fails.
   * Default: false (cloud upload failure is non-fatal — warns to stderr only).
   */
  require_upload?: boolean;
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

/**
 * SonarQube engine configuration — CLI-side concerns only.
 *
 * Project-level configuration (project_key, sources, exclusions, host_url,
 * credentials) lives in the project's `sonar-project.properties` file per
 * SonarQube convention. The CLI reads that file at scan time — adding those
 * fields to config.yml would duplicate them, which is the source of the bug
 * this model eliminates.
 *
 * External mode: reads everything from sonar-project.properties; SONAR_TOKEN
 * env var supplies the authentication token.
 *
 * Managed mode: CLI provisions an ephemeral SonarQube container, generates a
 * token via the admin API, overrides `sonar.host.url` + `sonar.token` at the
 * CLI arg layer (higher precedence than the properties file). Any
 * `sonar.login` / `sonar.password` in the properties file are stripped via a
 * sanitized temp copy (sonar-scanner 5+ rejects their mere presence).
 */
export interface SonarQubeConfig {
  enabled: boolean;
  /**
   * 'external' (default): sonar-scanner connects to a pre-existing SonarQube
   *   instance — host URL and project key come from sonar-project.properties;
   *   token comes from the SONAR_TOKEN env var.
   * 'managed': the CLI provisions an ephemeral SonarQube CE container via
   *   Docker, generates a token via the admin API, overrides host.url+token
   *   at the CLI arg layer, runs the scan, tears the container down.
   */
  mode: "external" | "managed";
  /** What to do when SonarQube scan fails: 'warn' (default) or 'fail'. */
  on_failure: "warn" | "fail";
  /**
   * Docker image tag for the sonar-scanner-cli container used in the container fallback path.
   * Only relevant when `mode` is 'managed' and local sonar-scanner is unavailable.
   * Defaults to 'sonarsource/sonar-scanner-cli:latest'.
   * Example: 'sonarsource/sonar-scanner-cli:5.0' to pin to a specific version.
   *
   * NOTE: This is the sonar-scanner-cli image (the container that sends code for analysis),
   * NOT the SonarQube server image. To configure the server image, use `server_image`.
   */
  scanner_image?: string;
  /**
   * Docker image for the SonarQube Community Edition server container.
   * Only used when `mode` is 'managed' — the CLI provisions an ephemeral SonarQube
   * server container using this image, runs the scan, then tears it down.
   * Defaults to 'sonarqube:lts-community'.
   * Example: 'sonarqube:10.4-community' to pin to a specific version.
   *
   * NOTE: This controls the SonarQube server image, NOT the sonar-scanner-cli image.
   * To configure the scanner image, use `scanner_image`.
   */
  server_image?: string;
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
   * Maximum seconds the sonar-scanner subprocess may run before being killed.
   * Applies to both local and container sonar-scanner execution.
   * Increase for large codebases. Defaults to 300 (5 minutes).
   */
  scanner_timeout_seconds?: number;
  /**
   * When true (default), scanner and CE timeouts are dynamically scaled based on
   * ncloc from the previous analysis. Falls back to static values when ncloc is
   * unavailable (first run, API error, managed mode).
   * Set to false to use only static scanner_timeout_seconds / ce_task_timeout_seconds.
   */
  dynamic_timeout?: boolean;
  /**
   * Multipliers for dynamic timeout calculation.
   * Only used when dynamic_timeout is true (or not set).
   * scanner_seconds_per_kloc: seconds of scanner budget per 1000 lines (default: 3)
   * ce_seconds_per_kloc: seconds of CE budget per 1000 lines (default: 1.5)
   */
  timeout_scale?: {
    scanner_seconds_per_kloc?: number;
    ce_seconds_per_kloc?: number;
  };
}

/** Runner selection for composer commands */
export type ComposerRunnerMode = "auto" | "docker" | "local";

/** Composer runner configuration */
export interface ComposerRunnerConfig {
  /**
   * Runner selection strategy (default: 'docker').
   * - 'docker': run composer via an ephemeral PHP Docker container. ← DEFAULT
   * - 'local':  use the locally installed composer binary. ⚠ emits a warning.
   * - 'auto':   try local composer first; fall back to Docker. ⚠ DEPRECATED escape hatch — emits a warning.
   */
  mode?: ComposerRunnerMode;
  /**
   * Docker image to use when mode is 'docker'.
   * When absent, the image is resolved from the inferred/configured PHP version
   * (e.g. PHP 8.2 → 'php:8.2-cli').  Falls back to 'composer:2'.
   * Takes precedence over `language_version`.
   * Mutually exclusive with `image_source='dockerfile'`.
   */
  image?: string;
  /**
   * PHP language version to use when resolving the Docker image.
   * Example: '8.2', '8.2.1'.
   * When set, the image is resolved as `php:<major>.<minor>-cli` (e.g. '8.2' → 'php:8.2-cli').
   * Overrides the version inferred from project files.
   * Only used when `image` is not set.
   * Set by `deep-health init` when a PHP version can be inferred from .php-version / composer.json.
   */
  language_version?: string;
  /**
   * Image source axis.
   * - 'pull' (default): pull a registry image (php:*-cli or composer:2).
   * - 'dockerfile': build from a project-owned Dockerfile; requires `dockerfile_path`.
   *   Mutually exclusive with `image`.
   */
  image_source?: ImageSource;
  /**
   * Path to the Dockerfile relative to the project root.
   * Required when image_source='dockerfile'.
   * Example: 'Dockerfile', '.docker/php.Dockerfile'
   */
  dockerfile_path?: string;
  /**
   * When true, passes `--ignore-platform-reqs` to all composer commands.
   * Defaults to true when mode is 'docker' (the Docker container is not the
   * production environment — platform extension checks are irrelevant there).
   * Set to false to enforce strict platform checks even in Docker mode.
   */
  ignore_platform_reqs?: boolean;
  /**
   * OS-level packages to install via apt-get before running composer commands.
   * Useful when a PHP extension requires system libraries not present in the
   * base php:*-cli image (e.g. imagemagick for ext-imagick).
   * Package names must follow Debian naming conventions.
   */
  native_deps?: readonly string[];
  /**
   * Build context path for docker build, relative to projectDir.
   * Defaults to the project root when absent.
   * Only used when image_source='dockerfile'.
   */
  build_context?: string;
  /**
   * Build arguments to pass as --build-arg KEY=VALUE to docker build.
   * Only used when image_source='dockerfile'.
   */
  build_args?: Record<string, string>;
  /**
   * When true, allows the Docker build context to resolve outside the project
   * boundary (git root, or projectDir when not in a git repository).
   * Only relevant when image_source='dockerfile' and build_context resolves
   * outside the allowed root.
   *
   * ⚠ Security: enabling this sends the full directory tree outside the project
   * to the Docker daemon, potentially exposing sensitive files. A warning is
   * emitted when this flag is active and the boundary is crossed.
   * Default: false.
   */
  allow_build_context_escape?: boolean;
}

/** Runner selection for pip commands */
export type PipRunnerMode = "auto" | "docker" | "local";

/** pip runner configuration */
export interface PipRunnerConfig {
  /**
   * Runner selection strategy (default: 'docker').
   * - 'docker': run pip via an ephemeral Python Docker container. ← DEFAULT
   * - 'local':  use the locally installed pip binary. ⚠ emits a warning.
   * - 'auto':   try local pip first; fall back to Docker. ⚠ DEPRECATED escape hatch — emits a warning.
   */
  mode?: PipRunnerMode;
  /**
   * Docker image to use when mode is 'docker'.
   * When absent, the image is resolved from the inferred/configured Python version.
   * Falls back to 'python:3-slim'.
   * Takes precedence over `language_version`.
   * Mutually exclusive with `image_source='dockerfile'`.
   */
  image?: string;
  /**
   * Python language version to use when resolving the Docker image.
   * Example: '3.11', '3.11.2'.
   * When set, the image is resolved as `python:{major}.{minor}-slim`.
   * Overrides the version inferred from project files.
   * Only used when `image` is not set.
   */
  language_version?: string;
  /**
   * Image source axis.
   * - 'pull' (default): pull a registry image.
   * - 'dockerfile': build from a project-owned Dockerfile; requires `dockerfile_path`.
   *   Mutually exclusive with `image`.
   */
  image_source?: ImageSource;
  /**
   * Path to the Dockerfile relative to the project root.
   * Required when image_source='dockerfile'.
   */
  dockerfile_path?: string;
  /**
   * OS-level packages to install via apt-get before running pip commands.
   * Use this for packages with C extensions that require system libraries
   * (e.g. Pillow → libjpeg-dev, psycopg2 → libpq-dev).
   * Package names must follow Debian naming conventions.
   */
  native_deps?: readonly string[];
  /**
   * Build context path for docker build, relative to projectDir.
   * Defaults to the project root when absent.
   * Only used when image_source='dockerfile'.
   */
  build_context?: string;
  /**
   * Build arguments to pass as --build-arg KEY=VALUE to docker build.
   * Only used when image_source='dockerfile'.
   */
  build_args?: Record<string, string>;
  /**
   * When true, allows the Docker build context to resolve outside the project
   * boundary (git root, or projectDir when not in a git repository).
   * Only relevant when image_source='dockerfile' and build_context resolves
   * outside the allowed root.
   *
   * ⚠ Security: enabling this sends the full directory tree outside the project
   * to the Docker daemon, potentially exposing sensitive files. A warning is
   * emitted when this flag is active and the boundary is crossed.
   * Default: false.
   */
  allow_build_context_escape?: boolean;
}

export interface ScannersConfig {
  sonarqube?: SonarQubeConfig;
  osv?: OsvScannerConfig;
  /** Engine id to use as Gate A source; defaults to 'osv' when omitted. */
  primary?: string;
}

export interface RunnersConfig {
  npm?: NpmRunnerConfig;
  pip?: PipRunnerConfig;
  composer?: ComposerRunnerConfig;
}

export interface SafeUpdatePolicy {
  allow_patch_and_minor_within_constraints: boolean;
  require_authorization_for_constraint_change: boolean;
}

/**
 * Git / PR workflow configuration.
 *
 * Controls whether `deep-health fix` creates a git branch and optionally opens
 * a pull request after applying updates.  All fields are optional — when absent
 * the CLI defaults to running in-place (no branch, no PR).
 *
 * CLI flags (`--create-branch`, `--open-pr`, etc.) always override these values,
 * so CI pipelines can override per-invocation without touching the config file.
 */
export interface WorkflowConfig {
  /**
   * When true, creates a new git branch before applying any changes and commits
   * the result on success.  The branch is deleted and the original branch is
   * restored if the pipeline fails.
   * Default: false.
   */
  create_branch?: boolean;
  /**
   * When true, pushes the fix branch and opens a GitHub pull request via `gh`
   * after a successful fix run.  Implies `create_branch: true`.
   * Requires the `gh` CLI to be installed and authenticated.
   * Default: false.
   */
  open_pr?: boolean;
  /**
   * Prefix used when generating the branch name.
   * The full branch name is: `<branch_prefix><ISO-timestamp>`.
   * Default: 'fix/deep-health-'.
   */
  branch_prefix?: string;
  /**
   * Pull request title.  When absent, a default title is generated from the
   * project name.
   */
  pr_title?: string;
}

/**
 * Scan path configuration — controls which paths osv-scanner inspects.
 *
 * All entries in `paths` must be relative (no leading `/`) and must not
 * contain `..` segments or glob characters. Paths resolve relative to
 * `/project` inside the container.
 */
export interface ScanPathsConfig {
  /**
   * When true (default), the scanner also scans the project root for lock files.
   * Set to false to restrict scanning to only the paths listed in `paths`.
   */
  auto_discover: boolean;
  /**
   * Explicit paths to scan. Directories (ending with `/`) are scanned
   * recursively via `-r`. Explicit file paths are passed via `--lockfile`.
   * When absent or empty, the scanner falls back to plugin-resolved lockfile args.
   */
  paths?: string[];
  /**
   * Paths to exclude from the scan.
   * Passed as `--experimental-exclude <path>` to osv-scanner.
   */
  exclude?: string[];
}

export interface ProjectConfig {
  /**
   * Schema version for forward-compatibility detection.
   * Absent means "1" (pre-versioning configs are treated as version 1).
   */
  config_version?: string;
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
  report_language?: SupportedLocale;
  cloud_storage?: CloudStorageConfig;
  /** Top-level scan path configuration — controls which paths osv-scanner inspects. */
  scan?: ScanPathsConfig;
  scanners?: ScannersConfig;
  /** Ecosystem runner configurations (Docker image, version hint, native deps, etc.) */
  runners?: RunnersConfig;
  outputs?: OutputsConfig;
  workflow?: WorkflowConfig;
}
