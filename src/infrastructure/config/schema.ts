import { z } from 'zod';

const ProtectedPackageSchema = z.object({
  package: z.string(),
  constraint: z.string(),
  reason: z.string(),
});

const RuntimeConfigSchema = z.object({
  php: z.string().optional(),
  node: z.string().optional(),
  execution: z.enum(['docker', 'local']),
  docker_service: z.string(),
  docker_workdir: z.string().optional(),
  test_command: z.string().optional(),
  build_commands: z.object({
    frontend: z.string(),
    backend: z.string(),
  }).optional(),
}).refine(
  (r) => r.php !== undefined || r.node !== undefined,
  { message: 'At least one ecosystem must be configured: php or node', path: ['php'] },
);

const SonarQubeConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /**
   * 'external' (default): sonar-scanner connects to a pre-existing SonarQube instance.
   * 'managed': the CLI provisions an ephemeral SonarQube CE container via Docker,
   *            runs the scan, then tears it down automatically.
   *
   * When mode is 'managed', host_url is ignored (the provisioner sets it dynamically).
   * Phase 1 behaviour is preserved: omitting mode is equivalent to 'external'.
   */
  mode: z.enum(['external', 'managed']).default('external'),
  host_url: z.string().url().optional().default('http://localhost:9000'),
  project_key: z.string(),
  token_env: z.string().default('SONAR_TOKEN'),
  on_failure: z.enum(['warn', 'fail']).default('warn'),
});

const ScannersConfigSchema = z.object({
  sonarqube: SonarQubeConfigSchema.optional(),
});

const CloudStorageConfigSchema = z.object({
  provider: z.enum(['google_drive']),
  folder_id: z.string(),
  credentials: z.string().optional(),
  credentials_env: z.string().optional(),
});

const SafeUpdatePolicySchema = z.object({
  allow_patch_and_minor_within_constraints: z.boolean(),
  require_authorization_for_constraint_change: z.boolean(),
  authorization_format: z.string(),
});

export const ProjectConfigSchema = z.object({
  project: z.object({
    name: z.string(),
    client: z.string(),
  }),
  runtime: RuntimeConfigSchema,
  protected_packages: z.object({
    composer: z.array(ProtectedPackageSchema).optional().default([]),
    npm: z.array(ProtectedPackageSchema).optional().default([]),
  }).catchall(z.array(ProtectedPackageSchema)),
  safe_update_policy: SafeUpdatePolicySchema,
  conflict_resolution: z.string(),
  reports_dir: z.string().optional(),
  report_language: z.enum(['pt-br', 'en']).optional(),
  cloud_storage: CloudStorageConfigSchema.optional(),
  scanners: ScannersConfigSchema.optional(),
});

export type ProjectConfigInput = z.input<typeof ProjectConfigSchema>;
