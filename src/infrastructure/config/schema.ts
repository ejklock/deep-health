import { CLI_NAME } from '@infra/brand';
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
const FixerStrategyIdSchema = z.enum(["osv", "npm-audit", "osv-then-audit"]);

/** Advisor command config */
const AdvisorConfigSchema = z
  .object({
    name: z.string().max(200),
    command: z.string().max(1000),
    format: z.enum(["json", "text"]).optional(),
  })
  .strict();

/**
 * Validation command config.
 * ⚠ SECURITY: commands execute as shell commands (shell: true) on the operator's host,
 * inheriting the full process environment. Treat this as an executable trust boundary —
 * operators configure these, and external/untrusted data must never be interpolated
 * into command strings. See also: src/modules/ecosystem/utils/validation-runner.ts.
 */
const ValidationCommandConfigSchema = z
  .object({
    name: z.string().max(200),
    command: z.string().max(1000),
    timeout_seconds: z.number().int().positive().optional().default(300),
  })
  .strict();

const DockerImageRefSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9./_:@-]*$/,
    'Docker image reference must be lowercase and contain only alphanumeric characters, dots, slashes, colons, at-signs, and hyphens',
  );

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
    image: DockerImageRefSchema.optional(),
  })
  .strict();

/**
 * Validates a single Debian/apt package name.
 * Debian policy: starts with alphanumeric, followed by alphanumeric, hyphens,
 * dots, or plus signs. Rejects shell metacharacters that would break preamble injection.
 */
const DebianPackageNameSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9+.\-]*$/,
    'Invalid package name — must follow Debian naming conventions (lowercase alphanumeric, hyphens, dots, plus signs only)',
  );

const NativeDepsSchema = z.array(DebianPackageNameSchema).optional();

/**
 * Image source axis — shared by npm, pip, and composer runners.
 * - 'pull' (default): pull a pre-built image from a registry (Docker Hub, GHCR, etc.).
 * - 'dockerfile': build a local image from a project-owned Dockerfile.
 *   Requires `dockerfile_path` to be set. Mutually exclusive with `image`.
 */
const ImageSourceSchema = z.enum(['pull', 'dockerfile']).default('pull');

const BuildArgsSchema = z.record(
  z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'Build arg key must be uppercase letters, digits, and underscores'),
  z.string().regex(/^[^\n\r]*$/, 'Build arg value must not contain newlines'),
);

/** npm runner config */
const NpmRunnerConfigSchema = z
  .object({
    /**
     * Docker image to use for the npm container.
     * Defaults to a version-resolved image (e.g. 'node:20'), falling back to 'node:lts'.
     * Takes precedence over language_version.
     * Mutually exclusive with image_source='dockerfile'.
     */
    image: DockerImageRefSchema.optional(),
    /**
     * Node.js language version hint used to resolve the Docker image when `image` is not set.
     * Example: '20', '20.11', '20.11.1'.
     * Overrides the version inferred from project files.
     * Set by `security-scan init` when a Node version can be inferred automatically.
     */
    language_version: z.string().optional(),
    /**
     * Image source axis.
     * - 'pull' (default): pull a registry image.
     * - 'dockerfile': build from a project-owned Dockerfile; requires `dockerfile_path`.
     *   Mutually exclusive with `image`.
     */
    image_source: ImageSourceSchema,
    /**
     * Path to the Dockerfile relative to the project root.
     * Required when image_source='dockerfile'.
     * Example: 'Dockerfile', '.docker/node.Dockerfile'
     */
    dockerfile_path: z.string().optional(),
    /**
     * OS-level packages to install via apt-get before running npm commands.
     * Useful for native addons that require system libraries (e.g. sharp → libvips-dev).
     * Example: [libvips-dev, build-essential, python3]
     */
    native_deps: NativeDepsSchema,
    /**
     * Build context directory for docker build, relative to the project root.
     * Defaults to the project root ('.') when absent.
     * Only used when image_source='dockerfile'.
     */
    build_context: z.string().optional(),
    /**
     * Build arguments passed as --build-arg KEY=VALUE to docker build.
     * Only used when image_source='dockerfile'.
     */
    build_args: BuildArgsSchema.optional(),
    /**
     * When true, allows build_context to resolve outside the project boundary
     * (git root or projectDir). Security warning is emitted when active.
     * Only relevant with image_source='dockerfile'. Default: false.
     */
    allow_build_context_escape: z.boolean().optional(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (cfg.image_source === 'dockerfile' && cfg.image) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'runners.npm: image_source="dockerfile" is mutually exclusive with `image`. ' +
          'Remove `image` or set image_source="pull".',
      });
    }
    if (cfg.image_source === 'dockerfile' && !cfg.dockerfile_path) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'runners.npm: image_source="dockerfile" requires `dockerfile_path` to be set.',
      });
    }
  });

/** Output format — markdown or docx for reports */
const OutputFormatSchema = z.enum(["markdown", "docx"]);

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
    scanner_image: DockerImageRefSchema.optional(),
    /**
     * Docker image for the SonarQube Community Edition server container.
     * Only used in managed mode — ignored in external mode.
     * Distinct from scanner_image (sonar-scanner-cli); this controls the server
     * that sonar-scanner connects to.
     * Default: 'sonarqube:lts-community'.
     */
    server_image: DockerImageRefSchema.optional(),
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
    /**
     * Maximum seconds the sonar-scanner subprocess may run before being killed.
     * Applies to both local and container sonar-scanner execution.
     * Defaults to 300 (5 minutes).
     */
    scanner_timeout_seconds: z.number().int().positive().optional(),
    /**
     * When true (default), auto-scales timeouts based on ncloc from previous analysis.
     */
    dynamic_timeout: z.boolean().default(true),
    /**
     * Per-kloc multipliers for dynamic timeout scaling.
     */
    timeout_scale: z.object({
      scanner_seconds_per_kloc: z.number().positive().default(3),
      ce_seconds_per_kloc: z.number().positive().default(1.5),
    }).default({}),
    /**
     * JVM options passed to sonar-scanner via the SONAR_SCANNER_OPTS environment variable.
     * Use this to increase heap for large codebases.
     * Example: "-Xmx2048m" for 2GB heap.
     */
    scanner_jvm_opts: z.string().optional(),
  })
  .strict();

/** pip runner config */
const PipRunnerConfigSchema = z
  .object({
    /**
     * Docker image to use for the pip container.
     * Defaults to a version-resolved image (e.g. 'python:3.11-slim'), falling back to 'python:3-slim'.
     * Takes precedence over language_version.
     * Mutually exclusive with image_source='dockerfile'.
     */
    image: DockerImageRefSchema.optional(),
    /**
     * Python language version hint used to resolve the Docker image when `image` is not set.
     * Example: '3.11', '3.11.2'.
     * Overrides the version inferred from project files.
     */
    language_version: z.string().optional(),
    /**
     * Image source axis.
     * - 'pull' (default): pull a registry image.
     * - 'dockerfile': build from a project-owned Dockerfile; requires `dockerfile_path`.
     *   Mutually exclusive with `image`.
     */
    image_source: ImageSourceSchema,
    /**
     * Path to the Dockerfile relative to the project root.
     * Required when image_source='dockerfile'.
     */
    dockerfile_path: z.string().optional(),
    /**
     * OS-level packages to install via apt-get before running pip commands.
     * Useful for packages with C extensions that require system libraries.
     */
    native_deps: NativeDepsSchema,
    /**
     * Build context directory for docker build, relative to the project root.
     * Defaults to the project root ('.') when absent.
     * Only used when image_source='dockerfile'.
     */
    build_context: z.string().optional(),
    /**
     * Build arguments passed as --build-arg KEY=VALUE to docker build.
     * Only used when image_source='dockerfile'.
     */
    build_args: BuildArgsSchema.optional(),
    /**
     * When true, allows build_context to resolve outside the project boundary
     * (git root or projectDir). Security warning is emitted when active.
     * Only relevant with image_source='dockerfile'. Default: false.
     */
    allow_build_context_escape: z.boolean().optional(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (cfg.image_source === 'dockerfile' && cfg.image) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'runners.pip: image_source="dockerfile" is mutually exclusive with `image`. ' +
          'Remove `image` or set image_source="pull".',
      });
    }
    if (cfg.image_source === 'dockerfile' && !cfg.dockerfile_path) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'runners.pip: image_source="dockerfile" requires `dockerfile_path` to be set.',
      });
    }
  });

/** composer runner config */
const ComposerRunnerConfigSchema = z
  .object({
    /**
     * Docker image to use for the composer container.
     * Defaults to a version-resolved image (e.g. 'php:8.2-cli'), falling back to 'composer:2'.
     * Takes precedence over language_version.
     * Mutually exclusive with image_source='dockerfile'.
     */
    image: DockerImageRefSchema.optional(),
    /**
     * PHP language version hint used to resolve the Docker image when `image` is not set.
     * Example: '8.2', '8.2.1'.
     * Overrides the version inferred from project files (.php-version / composer.json#require.php).
     * Set by `security-scan init` when a PHP version can be inferred automatically.
     */
    language_version: z.string().optional(),
    /**
     * Image source axis.
     * - 'pull' (default): pull a registry image (php:*-cli or composer:2).
     * - 'dockerfile': build from a project-owned Dockerfile; requires `dockerfile_path`.
     *   Mutually exclusive with `image`.
     */
    image_source: ImageSourceSchema,
    /**
     * Path to the Dockerfile relative to the project root.
     * Required when image_source='dockerfile'.
     * Example: 'Dockerfile', '.docker/php.Dockerfile'
     */
    dockerfile_path: z.string().optional(),
    /**
     * When true, passes --ignore-platform-reqs to all composer commands.
     * Defaults to true in Docker mode (the container is not the production environment).
     * Set to false to enforce strict platform checks even in Docker.
     */
    ignore_platform_reqs: z.boolean().optional(),
    /**
     * OS-level packages to install via apt-get before running composer commands.
     * Useful for PHP extensions that require system libraries.
     */
    native_deps: NativeDepsSchema,
    /**
     * Build context directory for docker build, relative to the project root.
     * Defaults to the project root ('.') when absent.
     * Only used when image_source='dockerfile'.
     */
    build_context: z.string().optional(),
    /**
     * Build arguments passed as --build-arg KEY=VALUE to docker build.
     * Only used when image_source='dockerfile'.
     */
    build_args: BuildArgsSchema.optional(),
    /**
     * When true, allows build_context to resolve outside the project boundary
     * (git root or projectDir). Security warning is emitted when active.
     * Only relevant with image_source='dockerfile'. Default: false.
     */
    allow_build_context_escape: z.boolean().optional(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (cfg.image_source === 'dockerfile' && cfg.image) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'runners.composer: image_source="dockerfile" is mutually exclusive with `image`. ' +
          'Remove `image` or set image_source="pull".',
      });
    }
    if (cfg.image_source === 'dockerfile' && !cfg.dockerfile_path) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'runners.composer: image_source="dockerfile" requires `dockerfile_path` to be set.',
      });
    }
  });

const ScannersConfigSchema = z
  .object({
    sonarqube: SonarQubeConfigSchema.optional(),
    osv: OsvScannerConfigSchema.optional(),
    primary: z.string().optional(),
  })
  .strict();

const RunnersConfigSchema = z
  .object({
    npm: NpmRunnerConfigSchema.optional(),
    pip: PipRunnerConfigSchema.optional(),
    composer: ComposerRunnerConfigSchema.optional(),
  })
  .strict();

/**
 * Scan path configuration — controls which paths osv-scanner inspects.
 *
 * Entries in `paths` are validated at schema level and again at runtime:
 * - No leading `/` (must be relative to /project inside the container)
 * - No `..` segments (path traversal prevention)
 * - No glob patterns (`*`, `?`) — use directory paths ending with `/` instead
 */
const ScanPathsConfigSchema = z.object({
  auto_discover: z.boolean().default(true),
  paths: z.array(
    z.string().superRefine((val, ctx) => {
      if (val.startsWith('/')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'scan.paths entries must be relative (no leading /)',
        });
      }
      if (val.split('/').some((seg) => seg === '..')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'scan.paths entries must not contain .. segments',
        });
      }
      if (/[*?]/.test(val)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'scan.paths does not support glob patterns — use a directory path ending with / instead (e.g. "app/")',
        });
      }
    }),
  ).optional(),
  exclude: z.array(z.string()).optional(),
}).strict();

const WorkflowConfigSchema = z
  .object({
    /**
     * Create a git branch before applying fixes, commit on success, and roll
     * back (delete branch + restore original) on failure.
     * Default: false.
     */
    create_branch: z.boolean().optional(),
    /**
     * Push the fix branch and open a GitHub PR via the `gh` CLI after a
     * successful run.  Implies create_branch.  Requires `gh` installed and
     * authenticated.
     * Default: false.
     */
    open_pr: z.boolean().optional(),
    /**
     * Prefix for the generated branch name.
     * Full name: <branch_prefix><ISO-timestamp>.
     * Default: 'fix/security-scan-'.
     */
    branch_prefix: z.string().regex(/^[a-zA-Z0-9]/, 'branch_prefix must not start with a dash or special character').optional(),
    /** Pull request title override. Auto-generated when absent. */
    pr_title: z.string().optional(),
  })
  .strict();

const CloudStorageConfigSchema = z
  .object({
    provider: z.enum(["google_drive"]),
    folder_id: z.string().regex(/^[A-Za-z0-9_-]{10,}$/, 'folder_id must be at least 10 alphanumeric, dash, or underscore characters'),
    /**
     * When true, fix/executive-report commands will fail if cloud upload fails.
     * Default: false (cloud upload failure is non-fatal — warns to stderr).
     */
    require_upload: z.boolean().default(false),
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
    /**
     * Schema version for forward-compatibility detection.
     * - Absent: treated as version "1" (backward compatible with pre-versioning configs).
     * - "1": current supported version.
     * - Any other value: rejected with a user-friendly message suggesting `security-scan init --force`.
     */
    config_version: z.string().optional(),
    project: z
      .object({
        name: z.string().regex(/^[^\n\r]+$/, 'project.name must not contain newlines'),
        client: z.string().regex(/^[^\n\r]+$/, 'project.client must not contain newlines'),
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
    scan: ScanPathsConfigSchema.optional(),
    scanners: ScannersConfigSchema.optional(),
    runners: RunnersConfigSchema.optional(),
    outputs: OutputsConfigSchema.optional(),
    workflow: WorkflowConfigSchema.optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.config_version !== undefined && data.config_version !== "1") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `Unsupported config_version "${data.config_version}". ` +
          `This version of ${CLI_NAME} supports config_version "1". ` +
          `Run "${CLI_NAME} init --force" to regenerate a compatible config.`,
      });
    }
  });

export type ProjectConfigInput = z.input<typeof ProjectConfigSchema>;
