import type { ExecutionEnv } from './common.js';
import type { SupportedLocale } from '../report/i18n/index.js';

export interface ProtectedPackage {
  package: string;
  constraint: string;
  reason: string;
}

export interface RuntimeConfig {
  php?: string;
  node?: string;
  execution: ExecutionEnv;
  docker_service: string;
  docker_workdir?: string;
  test_command?: string;
  build_commands?: {
    frontend: string;
    backend: string;
  };
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
  protected_packages: {
    composer: ProtectedPackage[];
    npm: ProtectedPackage[];
    [key: string]: ProtectedPackage[];
  };
  safe_update_policy: SafeUpdatePolicy;
  conflict_resolution: string;
  reports_dir?: string;
  report_language?: SupportedLocale;
  cloud_storage?: CloudStorageConfig;
  scanners?: ScannersConfig;
}
