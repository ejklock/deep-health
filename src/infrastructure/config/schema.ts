import { z } from 'zod';
import { SONARQUBE_PROJECT_KEY_REGEX } from '@core/types/config';

const ProtectedPackageSchema = z.object({
  package: z.string(),
  constraint: z.string(),
  reason: z.string(),
}).strict();

/** Fixer strategy identifier */
const FixerStrategyIdSchema = z.enum(['osv', 'npm-audit']);

/** Advisor command config */
const AdvisorConfigSchema = z.object({
  name: z.string(),
  command: z.string(),
}).strict();

/** Validation command config */
const ValidationCommandConfigSchema = z.object({
  name: z.string(),
  command: z.string(),
}).strict();

/** OSV scanner engine config */
const OsvScannerConfigSchema = z.object({
  args: z.array(z.string()).optional(),
  /**
   * Runner selection:
   * - 'auto' (default): try local osv-scanner, fall back to Docker.
   * - 'local': require a locally installed osv-scanner binary.
   * - 'docker': always use an ephemeral Docker container.
   */
  runner: z.enum(['auto', 'local', 'docker']).default('auto'),
  /**
   * Docker image for the OSV container (used when runner is 'docker' or auto-fallback).
   * Defaults to 'ghcr.io/google/osv-scanner:latest'.
   */
  image: z.string().optional(),
}).strict();

/** Output format — markdown for reports */
const OutputFormatSchema = z.enum(['markdown']);

/** Outputs config block */
const OutputsConfigSchema = z.object({
  formats: z.array(OutputFormatSchema).optional(),
  dir: z.string().optional(),
}).strict();

/** Declarative ecosystem config entry */
const EcosystemConfigSchema = z.object({
  id: z.string(),
  version: z.string().optional(),
  fixer: FixerStrategyIdSchema.optional(),
  validationCommands: z.array(ValidationCommandConfigSchema).optional(),
  advisors: z.array(AdvisorConfigSchema).optional(),
}).strict();

const SonarQubeConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /**
   * 'external' (default): sonar-scanner connects to a pre-existing SonarQube instance.
   * 'managed': the CLI provisions an ephemeral SonarQube CE container via Docker,
   *            runs the scan, then tears it down automatically.
   *
   * When mode is 'managed', host_url is ignored (the provisioner sets it dynamically).
   * Omitting mode is equivalent to 'external'.
   */
  mode: z.enum(['external', 'managed']).default('external'),
  host_url: z.string().url().optional().default('http://localhost:9000'),
  project_key: z.string().regex(
    SONARQUBE_PROJECT_KEY_REGEX,
    'SonarQube project_key may only contain letters, digits, hyphens (-), underscores (_), periods (.), and colons (:). ' +
    'Spaces and special characters are not allowed. Example: "my-project" or "org:my-project".',
  ),
  token_env: z.string().default('SONAR_TOKEN'),
  on_failure: z.enum(['warn', 'fail']).default('warn'),
  /**
   * Docker image tag for the sonar-scanner-cli container (managed mode fallback).
   * Defaults to 'sonarsource/sonar-scanner-cli:latest'.
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
  /**
   * Glob patterns for sonar.exclusions.  When omitted, ecosystem-specific defaults apply.
   * When set (even to []), the value is used verbatim (full override).
   */
  exclusions: z.array(z.string()).optional(),
  /**
   * Glob patterns for sonar.coverage.exclusions.  When omitted, ecosystem-specific defaults apply.
   * When set (even to []), the value is used verbatim (full override).
   */
  coverage_exclusions: z.array(z.string()).optional(),
}).strict();

const ScannersConfigSchema = z.object({
  sonarqube: SonarQubeConfigSchema.optional(),
  osv: OsvScannerConfigSchema.optional(),
}).strict();

const CloudStorageConfigSchema = z.object({
  provider: z.enum(['google_drive']),
  folder_id: z.string(),
  credentials: z.string().optional(),
  credentials_env: z.string().optional(),
}).strict();

const SafeUpdatePolicySchema = z.object({
  allow_patch_and_minor_within_constraints: z.boolean(),
  require_authorization_for_constraint_change: z.boolean(),
}).strict();

export const ProjectConfigSchema = z.object({
  project: z.object({
    name: z.string(),
    client: z.string(),
  }).strict(),
  /**
   * At least one ecosystem must be declared.
   * Each entry must have a unique id (validated at runtime by the plugin registry).
   */
  ecosystems: z.array(EcosystemConfigSchema).min(1, {
    message: 'At least one ecosystem must be configured in ecosystems[]',
  }),
  /** Per-ecosystem protected packages. Keys are ecosystem ids ('npm', 'composer', …). */
  protected_packages: z.record(z.array(ProtectedPackageSchema)),
  safe_update_policy: SafeUpdatePolicySchema,
  conflict_resolution: z.string(),
  reports_dir: z.string().optional(),
  report_language: z.enum(['pt-br', 'en']).optional(),
  cloud_storage: CloudStorageConfigSchema.optional(),
  scanners: ScannersConfigSchema.optional(),
  outputs: OutputsConfigSchema.optional(),
}).strict();

export type ProjectConfigInput = z.input<typeof ProjectConfigSchema>;
