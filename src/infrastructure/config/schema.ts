import { z } from "zod";

const ProtectedPackageSchema = z
  .object({
    package: z.string(),
    constraint: z.string(),
    reason: z.string(),
  })
  .strict();

/**
 * Fixer strategy identifier.
 * - 'osv' (default for npm): OSV in-place fix coordinated by the orchestrator.
 * - 'npm-audit': `npm audit fix` approach (OSV fix is skipped).
 */
const FixerStrategyIdSchema = z.enum(["osv", "npm-audit"]);

/** Advisor command config */
const AdvisorConfigSchema = z
  .object({
    name: z.string(),
    command: z.string(),
    format: z.enum(["json", "text"]).optional(),
  })
  .strict();

/** Validation command config */
const ValidationCommandConfigSchema = z
  .object({
    name: z.string(),
    command: z.string(),
    timeout_seconds: z.number().int().positive().optional(),
  })
  .strict();

/** OSV scanner engine config */
const OsvScannerConfigSchema = z
  .object({
    args: z.array(z.string()).optional(),
    /**
     * Runner selection (default: 'docker'):
     * - 'docker' (default): always use an ephemeral Docker container.
     * - 'local': require a locally installed osv-scanner binary. ⚠ Emits a warning.
     * - 'auto': try local osv-scanner, fall back to Docker. ⚠ Deprecated escape hatch — emits a warning.
     */
    runner: z.enum(["auto", "local", "docker"]).default("docker"),
    /**
     * Docker image for the OSV container (used when runner is 'docker').
     * Defaults to 'ghcr.io/google/osv-scanner:latest'.
     */
    image: z.string().optional(),
  })
  .strict();

/** npm runner config */
const NpmRunnerConfigSchema = z
  .object({
    /**
     * Runner selection (default: 'docker'):
     * - 'docker' (default): run npm via an ephemeral Node Docker container.
     * - 'local': use the locally installed npm binary. ⚠ Emits a warning.
     * - 'auto': try local npm first; fall back to Docker. ⚠ Deprecated escape hatch — emits a warning.
     */
    mode: z.enum(["auto", "local", "docker"]).default("docker"),
    /**
     * Docker image to use when mode is 'docker'.
     * Defaults to a version-resolved image (e.g. 'node:20'), falling back to 'node:lts'.
     * Takes precedence over runtime_version.
     */
    image: z.string().optional(),
    /**
     * Node.js runtime version hint used to resolve the Docker image when `image` is not set.
     * Example: '20', '20.11', '20.11.1'.
     * Overrides the version inferred from project files.
     * Set by `deep-health init` when a Node version can be inferred automatically.
     */
    runtime_version: z.string().optional(),
  })
  .strict();

/** Output format — markdown for reports */
const OutputFormatSchema = z.enum(["markdown"]);

/** Outputs config block */
const OutputsConfigSchema = z
  .object({
    formats: z.array(OutputFormatSchema).optional(),
    dir: z.string().optional(),
    /**
     * When true, engine-specific reports are written to sub-folders:
     *   - SonarQube artifacts → {dir}/sonarqube/
     * Consolidated and executive reports remain at the root level.
     * Defaults to false.
     */
    sub_folders: z.boolean().optional(),
  })
  .strict();

/** Declarative ecosystem config entry */
const EcosystemConfigSchema = z
  .object({
    id: z.string(),
    fixer: FixerStrategyIdSchema.optional(),
    validationCommands: z.array(ValidationCommandConfigSchema).optional(),
    advisors: z.array(AdvisorConfigSchema).optional(),
  })
  .strict();

/**
 * SonarQube config — CLI-side concerns only.
 *
 * Project-level configuration (project_key, sources, exclusions, host_url,
 * credentials) lives in the project's `sonar-project.properties` file, which
 * is the SonarQube-community convention. The CLI reads that file at scan time.
 *
 * What stays here: orchestration policy (on_failure), runtime dispatch (mode),
 * infra choices (scanner_image), and CLI feature flags (send_branch_name,
 * ce_task_timeout_seconds).
 *
 * In managed mode, the CLI overrides `sonar.host.url` and `sonar.token` with
 * values generated at runtime; `sonar.login`/`sonar.password` are always
 * stripped from the properties file (sonar-scanner 5+ errors when they exist).
 */
const SonarQubeConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    /**
     * 'external' (default): sonar-scanner connects to a pre-existing SonarQube
     *   instance — host URL and project key come from sonar-project.properties;
     *   token comes from the SONAR_TOKEN env var.
     * 'managed': the CLI provisions an ephemeral SonarQube CE container via
     *   Docker, generates a token via the admin API, overrides host.url+token
     *   at the CLI layer, runs the scan, tears the container down.
     */
    mode: z.enum(["external", "managed"]).default("external"),
    on_failure: z.enum(["warn", "fail"]).default("warn"),
    /**
     * Docker image tag for the sonar-scanner-cli container (managed mode fallback
     * when local sonar-scanner is not installed). Defaults to
     * 'sonarsource/sonar-scanner-cli:latest'.
     */
    scanner_image: z.string().optional(),
    /**
     * When true, forwards the detected git branch as -Dsonar.branch.name to sonar-scanner.
     * Requires SonarQube Developer Edition or higher — Community Edition does NOT support
     * branch analysis and will fail if this property is forwarded.
     * Defaults to false (CE-safe).
     */
    send_branch_name: z.boolean().default(false),
    /**
     * Maximum seconds to wait for the SonarQube Compute Engine (CE) task to complete
     * before fetching the quality gate status.  Defaults to 120.  Set to 0 to disable.
     */
    ce_task_timeout_seconds: z.number().int().nonnegative().default(120),
  })
  .strict();

/** pip runner config */
const PipRunnerConfigSchema = z
  .object({
    /**
     * Runner selection (default: 'docker'):
     * - 'docker' (default): run pip via an ephemeral Python Docker container.
     * - 'local': use the locally installed pip binary. ⚠ Emits a warning.
     * - 'auto': try local pip first; fall back to Docker. ⚠ Deprecated escape hatch — emits a warning.
     */
    mode: z.enum(["auto", "local", "docker"]).default("docker"),
    /**
     * Docker image to use when mode is 'docker'.
     * Defaults to a version-resolved image (e.g. 'python:3.11-slim'), falling back to 'python:3-slim'.
     * Takes precedence over runtime_version.
     */
    image: z.string().optional(),
    /**
     * Python runtime version hint used to resolve the Docker image when `image` is not set.
     * Example: '3.11', '3.11.2'.
     * Overrides the version inferred from project files.
     */
    runtime_version: z.string().optional(),
  })
  .strict();

/** composer runner config */
const ComposerRunnerConfigSchema = z
  .object({
    /**
     * Runner selection (default: 'docker'):
     * - 'docker' (default): run composer via an ephemeral PHP Docker container.
     * - 'local': use the locally installed composer binary. ⚠ Emits a warning.
     * - 'auto': try local composer first; fall back to Docker. ⚠ Deprecated escape hatch — emits a warning.
     */
    mode: z.enum(["auto", "local", "docker"]).default("docker"),
    /**
     * Docker image to use when mode is 'docker'.
     * Defaults to a version-resolved image (e.g. 'php:8.2-cli'), falling back to 'composer:2'.
     * Takes precedence over runtime_version.
     */
    image: z.string().optional(),
    /**
     * PHP runtime version hint used to resolve the Docker image when `image` is not set.
     * Example: '8.2', '8.2.1'.
     * Overrides the version inferred from project files (.php-version / composer.json#require.php).
     * Set by `deep-health init` when a PHP version can be inferred automatically.
     */
    runtime_version: z.string().optional(),
    /**
     * Image provisioning strategy when mode is 'docker'.
     * - 'pull' (default): use the resolved base image as-is.
     * - 'build' (Phase 2 — NOT YET IMPLEMENTED): build a custom image with framework PHP extensions.
     */
    image_strategy: z.enum(["pull", "build"]).default("pull"),
    /**
     * PHP framework profile for extension selection (used when image_strategy='build').
     * - 'none' (default): no framework-specific extensions.
     * - 'laravel' | 'symfony' | 'wordpress': installs profile extension list.
     * Phase 1: persisted to config only. Phase 2: consumed by image builder.
     */
    framework_profile: z
      .enum(["none", "laravel", "symfony", "wordpress"])
      .default("none"),
  })
  .strict();

const ScannersConfigSchema = z
  .object({
    sonarqube: SonarQubeConfigSchema.optional(),
    osv: OsvScannerConfigSchema.optional(),
    npm: NpmRunnerConfigSchema.optional(),
    pip: PipRunnerConfigSchema.optional(),
    composer: ComposerRunnerConfigSchema.optional(),
  })
  .strict();

const CloudStorageConfigSchema = z
  .object({
    provider: z.enum(["google_drive"]),
    folder_id: z.string(),
  })
  .strict();

const SafeUpdatePolicySchema = z
  .object({
    allow_patch_and_minor_within_constraints: z.boolean(),
    require_authorization_for_constraint_change: z.boolean(),
  })
  .strict();

export const ProjectConfigSchema = z
  .object({
    project: z
      .object({
        name: z.string(),
        client: z.string(),
      })
      .strict(),
    /**
     * At least one ecosystem must be declared.
     * Each entry must have a unique id (validated at runtime by the plugin registry).
     */
    ecosystems: z.array(EcosystemConfigSchema).min(1, {
      message: "At least one ecosystem must be configured in ecosystems[]",
    }),
    /** Per-ecosystem protected packages. Keys are ecosystem ids ('npm', 'composer', …). */
    protected_packages: z.record(z.array(ProtectedPackageSchema)),
    safe_update_policy: SafeUpdatePolicySchema,
    conflict_resolution: z.string(),
    report_language: z.enum(["pt-br", "en"]).optional(),
    cloud_storage: CloudStorageConfigSchema.optional(),
    scanners: ScannersConfigSchema.optional(),
    outputs: OutputsConfigSchema.optional(),
  })
  .strict();

export type ProjectConfigInput = z.input<typeof ProjectConfigSchema>;
