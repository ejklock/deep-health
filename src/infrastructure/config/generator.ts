import Handlebars from 'handlebars';
import type { SupportedLocale } from '@core/types/locale';
import type { OutputFormat } from '@core/types/config';
import configTemplate from './templates/project-config.hbs';
import npmRunnerBlockTemplate from './templates/npm-runner-block.hbs';
import pipRunnerBlockTemplate from './templates/pip-runner-block.hbs';
import composerRunnerBlockTemplate from './templates/composer-runner-block.hbs';

Handlebars.registerPartial('npm-runner-block', npmRunnerBlockTemplate);
Handlebars.registerPartial('pip-runner-block', pipRunnerBlockTemplate);
Handlebars.registerPartial(
  'composer-runner-block',
  composerRunnerBlockTemplate,
);

/**
 * Config / init scaffolding generates a declarative project-config.yml.
 *
 * The generated file uses the ecosystems[] format — each ecosystem entry
 * declares its id, fixer strategy, validation commands, and advisors.
 *
 * By contrast, the *runtime* architecture (scan → update → report) is fully
 * registry-extensible: any plugin that implements EcosystemPlugin and registers
 * with `defaultRegistry` is picked up automatically at runtime without changes
 * to this file, the CLI flags, or the orchestrator.
 *
 * TL;DR: add new ecosystems to the plugin registry for runtime support;
 * update this generator only when you want first-class `init` scaffolding.
 */

export interface EcosystemConfigEntry {
  id: string;
  fixerStrategy?: string;
  validationCommands?: Array<{ name: string; command: string }>;
  advisors?: Array<{ name: string; command: string }>;
}

export interface GenerateConfigOptions {
  projectName?: string;
  client?: string;
  reportLanguage?: SupportedLocale;
  /**
   * Rich ecosystem config entries (registry-driven from init command).
   * Defaults to both composer and npm when omitted.
   */
  ecosystemConfigs?: EcosystemConfigEntry[];
  /** Whether to add SonarQube scanner block */
  enableSonarQube?: boolean;
  /** Outputs config for report generation */
  outputs?: { formats?: OutputFormat[]; dir?: string };
  /**
   * Inferred Node.js language version to persist into `runners.npm.language_version`.
   * When set, the generated config includes this value so the orchestrator can use it
   * for Docker image resolution without running inferVersion() at scan time.
   * Example: '20', '20.11'
   */
  npmLanguageVersion?: string;
  /**
   * Inferred Python language version to persist into `runners.pip.language_version`.
   * When set, the generated config includes this value so the orchestrator can use it
   * for Docker image resolution without running inferVersion() at scan time.
   * Example: '3.11', '3.11.2'
   */
  pipLanguageVersion?: string;
  /**
   * Inferred PHP language version to persist into `runners.composer.language_version`.
   * When set, the generated config includes this value so the orchestrator can use it
   * for Docker image resolution without running inferVersion() at scan time.
   * Example: '8.2', '8.2.1'
   */
  composerLanguageVersion?: string;
  /**
   * Image source for the npm runner container.
   * - 'pull' (default): pull a registry image.
   * - 'dockerfile': build from a project-owned Dockerfile; requires `npmDockerfilePath`.
   */
  npmImageSource?: 'pull' | 'dockerfile';
  /**
   * Path to the Dockerfile to use for the npm container (relative to project root).
   * Only written when `npmImageSource='dockerfile'`.
   * Example: 'Dockerfile', '.docker/node.Dockerfile'
   */
  npmDockerfilePath?: string;
  /**
   * Image source for the pip runner container.
   * - 'pull' (default): pull a registry image.
   * - 'dockerfile': build from a project-owned Dockerfile; requires `pipDockerfilePath`.
   */
  pipImageSource?: 'pull' | 'dockerfile';
  /**
   * Path to the Dockerfile to use for the pip container (relative to project root).
   * Only written when `pipImageSource='dockerfile'`.
   */
  pipDockerfilePath?: string;
  /**
   * Image source for the composer runner container.
   * - 'pull' (default): pull a registry image.
   * - 'dockerfile': build from a project-owned Dockerfile; requires `composerDockerfilePath`.
   */
  composerImageSource?: 'pull' | 'dockerfile';
  /**
   * Path to the Dockerfile to use for the composer container (relative to project root).
   * Only written when `composerImageSource='dockerfile'`.
   * Example: 'Dockerfile', '.docker/php.Dockerfile'
   */
  composerDockerfilePath?: string;
  /**
   * Build context directory for the npm Docker build, relative to project root.
   * Only written when `npmImageSource='dockerfile'`.
   * Defaults to project root when absent.
   */
  npmBuildContext?: string;
  /**
   * Build arguments for the npm Docker build (KEY=VALUE pairs).
   * Only written when `npmImageSource='dockerfile'`.
   */
  npmBuildArgs?: Record<string, string>;
  /**
   * Build context directory for the pip Docker build, relative to project root.
   * Only written when `pipImageSource='dockerfile'`.
   */
  pipBuildContext?: string;
  /**
   * Build arguments for the pip Docker build (KEY=VALUE pairs).
   * Only written when `pipImageSource='dockerfile'`.
   */
  pipBuildArgs?: Record<string, string>;
  /**
   * Build context directory for the composer Docker build, relative to project root.
   * Only written when `composerImageSource='dockerfile'`.
   */
  composerBuildContext?: string;
  /**
   * Build arguments for the composer Docker build (KEY=VALUE pairs).
   * Only written when `composerImageSource='dockerfile'`.
   */
  composerBuildArgs?: Record<string, string>;
  /**
   * When true, persists `allow_build_context_escape: true` into the npm runner config.
   * Only relevant when `npmImageSource='dockerfile'`. Default: false (boundary enforced).
   */
  npmAllowBuildContextEscape?: boolean;
  /**
   * When true, persists `allow_build_context_escape: true` into the pip runner config.
   * Only relevant when `pipImageSource='dockerfile'`. Default: false (boundary enforced).
   */
  pipAllowBuildContextEscape?: boolean;
  /**
   * When true, persists `allow_build_context_escape: true` into the composer runner config.
   * Only relevant when `composerImageSource='dockerfile'`. Default: false (boundary enforced).
   */
  composerAllowBuildContextEscape?: boolean;
}

const compiled = Handlebars.compile(configTemplate, { noEscape: true });

/**
 * Normalize a project name into a valid SonarQube project_key.
 *
 * SonarQube project keys may only contain letters, digits, hyphens (-),
 * underscores (_), periods (.), and colons (:). Spaces and other special
 * characters are not allowed.
 *
 * Transformation rules (applied in order):
 *  1. Trim leading/trailing whitespace.
 *  2. Replace whitespace runs with a single hyphen.
 *  3. Replace any remaining invalid characters with hyphens.
 *  4. Collapse consecutive hyphens into one.
 *  5. Strip leading/trailing hyphens (underscores/periods/colons are fine at edges per SQ docs).
 *  6. Fall back to 'my-project' if the result is empty.
 *
 * Already-valid keys are returned unchanged (idempotent).
 *
 * @example
 * normalizeSonarProjectKey('My App')          // → 'My-App'
 * normalizeSonarProjectKey('My App!')         // → 'My-App'
 * normalizeSonarProjectKey('org:my-project')  // → 'org:my-project'
 * normalizeSonarProjectKey('   ')             // → 'my-project'
 */
export function normalizeSonarProjectKey(name: string): string {
  let key = name.trim();
  // Replace whitespace runs with hyphens
  key = key.replace(/\s+/g, '-');
  // Replace any character not in [a-zA-Z0-9\-_.:] with a hyphen
  key = key.replace(/[^a-zA-Z0-9\-_.:]/g, '-');
  // Collapse consecutive hyphens
  key = key.replace(/-{2,}/g, '-');
  // Strip leading/trailing hyphens
  key = key.replace(/^-+|-+$/g, '');
  return key || 'my-project';
}

/** Known protected_packages ecosystem entries (id → example values) */
const ECOSYSTEM_EXAMPLES: Record<
  string,
  { examplePackage: string; exampleConstraint: string; exampleReason: string }
> = {
  composer: {
    examplePackage: 'vendor/package',
    exampleConstraint: '^2.0',
    exampleReason: 'Major upgrade requires project-wide migration',
  },
  npm: {
    examplePackage: 'some-package',
    exampleConstraint: '^3.0.0',
    exampleReason: 'v4 has breaking API changes',
  },
  pip: {
    examplePackage: 'requests',
    exampleConstraint: '>=2.31',
    exampleReason: 'Major upgrade requires API migration',
  },
};

/** Default ecosystem entries used when ecosystemConfigs is not provided */
const DEFAULT_ECOSYSTEM_CONFIGS: EcosystemConfigEntry[] = [
  {
    id: 'composer',
    validationCommands: [
      { name: 'tests', command: 'php artisan test --compact' },
    ],
    advisors: [{ name: 'audit', command: 'composer audit' }],
  },
  {
    id: 'npm',
    fixerStrategy: 'osv',
    validationCommands: [{ name: 'build', command: 'npm run build' }],
    advisors: [{ name: 'audit', command: 'npm audit' }],
  },
  {
    id: 'pip',
    validationCommands: [{ name: 'check', command: 'pip check' }],
    advisors: [{ name: 'audit', command: 'pip-audit' }],
  },
];

export function generateConfigYaml(opts: GenerateConfigOptions = {}): string {
  // Resolve ecosystem entries — default to composer+npm when not provided
  const configEntries =
    opts.ecosystemConfigs && opts.ecosystemConfigs.length > 0
      ? opts.ecosystemConfigs
      : DEFAULT_ECOSYSTEM_CONFIGS;

  const ecosystems = configEntries.map((entry) => ({
    id: entry.id,
    hasFixer: !!entry.fixerStrategy,
    fixer: entry.fixerStrategy,
    hasValidationCommands: (entry.validationCommands?.length ?? 0) > 0,
    validationCommands: entry.validationCommands ?? [],
    hasAdvisors: (entry.advisors?.length ?? 0) > 0,
    advisors: entry.advisors ?? [],
  }));

  // Resolve selected ecosystem ids for protected_packages
  const selectedIds = ecosystems.map((e) => e.id);

  // Always emit all known ecosystem keys in protected_packages for schema compatibility.
  const allKnownIds = ['composer', 'npm', 'pip'];
  const allIds = [...new Set([...allKnownIds, ...selectedIds])];
  const protectedPackageEcosystems = allIds.map((id) => ({
    id,
    active: selectedIds.includes(id),
    ...(ECOSYSTEM_EXAMPLES[id] ?? {
      examplePackage: 'example/package',
      exampleConstraint: '^1.0',
      exampleReason: 'Version constraint reason',
    }),
  }));

  const outputsConfig = opts.outputs;
  const hasOutputs = !!outputsConfig;
  const outputFormats = outputsConfig?.formats ?? [];
  const outputsDir = outputsConfig?.dir;

  const rawProjectName = opts.projectName ?? 'My Project';

  // Escape single quotes for YAML single-quoted string safety ('' is the only valid escape).
  // Prevents injection via values like O'Brien → O''Brien in the generated YAML.
  const safeProjectName = rawProjectName.replace(/'/g, "''");
  const safeClient = (opts.client ?? 'Client Name').replace(/'/g, "''");

  return compiled({
    projectName: safeProjectName,
    client: safeClient,
    ecosystems,
    reportLanguage: opts.reportLanguage ?? 'pt-br',
    protectedPackageEcosystems,
    enableSonarQube: opts.enableSonarQube ?? false,
    hasOutputs,
    outputFormats,
    outputsDir,
    npmLanguageVersion: opts.npmLanguageVersion,
    pipLanguageVersion: opts.pipLanguageVersion,
    composerLanguageVersion: opts.composerLanguageVersion,
    hasAnyRunnerConfig: !!(
      opts.npmLanguageVersion ||
      opts.pipLanguageVersion ||
      opts.composerLanguageVersion ||
      opts.npmImageSource === 'dockerfile' ||
      opts.pipImageSource === 'dockerfile' ||
      opts.composerImageSource === 'dockerfile'
    ),
    // Dockerfile image-source options
    npmImageSource:
      opts.npmImageSource === 'dockerfile' ? 'dockerfile' : undefined,
    npmDockerfilePath:
      opts.npmImageSource === 'dockerfile' ? opts.npmDockerfilePath : undefined,
    npmBuildContext:
      opts.npmImageSource === 'dockerfile' ? opts.npmBuildContext : undefined,
    npmBuildArgs:
      opts.npmImageSource === 'dockerfile' &&
      opts.npmBuildArgs &&
      Object.keys(opts.npmBuildArgs).length > 0
        ? Object.entries(opts.npmBuildArgs).map(([k, v]) => ({
            key: k,
            value: v,
          }))
        : undefined,
    pipImageSource:
      opts.pipImageSource === 'dockerfile' ? 'dockerfile' : undefined,
    pipDockerfilePath:
      opts.pipImageSource === 'dockerfile' ? opts.pipDockerfilePath : undefined,
    pipBuildContext:
      opts.pipImageSource === 'dockerfile' ? opts.pipBuildContext : undefined,
    pipBuildArgs:
      opts.pipImageSource === 'dockerfile' &&
      opts.pipBuildArgs &&
      Object.keys(opts.pipBuildArgs).length > 0
        ? Object.entries(opts.pipBuildArgs).map(([k, v]) => ({
            key: k,
            value: v,
          }))
        : undefined,
    composerImageSource:
      opts.composerImageSource === 'dockerfile' ? 'dockerfile' : undefined,
    composerDockerfilePath:
      opts.composerImageSource === 'dockerfile'
        ? opts.composerDockerfilePath
        : undefined,
    composerBuildContext:
      opts.composerImageSource === 'dockerfile'
        ? opts.composerBuildContext
        : undefined,
    composerBuildArgs:
      opts.composerImageSource === 'dockerfile' &&
      opts.composerBuildArgs &&
      Object.keys(opts.composerBuildArgs).length > 0
        ? Object.entries(opts.composerBuildArgs).map(([k, v]) => ({
            key: k,
            value: v,
          }))
        : undefined,
    npmAllowBuildContextEscape:
      opts.npmImageSource === 'dockerfile'
        ? opts.npmAllowBuildContextEscape
        : undefined,
    pipAllowBuildContextEscape:
      opts.pipImageSource === 'dockerfile'
        ? opts.pipAllowBuildContextEscape
        : undefined,
    composerAllowBuildContextEscape:
      opts.composerImageSource === 'dockerfile'
        ? opts.composerAllowBuildContextEscape
        : undefined,
  });
}
