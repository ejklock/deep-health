import Handlebars from 'handlebars';
import type { SupportedLocale } from '@core/types/locale';
import type { OutputFormat } from '@core/types/config';
import configTemplate from './templates/project-config.hbs';

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
   * Inferred Node.js runtime version to persist into `scanners.npm.runtime_version`.
   * When set, the generated config includes this value so the orchestrator can use it
   * for Docker image resolution without running inferVersion() at scan time.
   * Example: '20', '20.11'
   */
  npmRuntimeVersion?: string;
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
};

/** Default ecosystem entries used when ecosystemConfigs is not provided */
const DEFAULT_ECOSYSTEM_CONFIGS: EcosystemConfigEntry[] = [
  {
    id: 'composer',
    validationCommands: [{ name: 'tests', command: 'php artisan test --compact' }],
    advisors: [{ name: 'audit', command: 'composer audit' }],
  },
  {
    id: 'npm',
    fixerStrategy: 'npm-audit',
    validationCommands: [{ name: 'build', command: 'npm run build' }],
    advisors: [{ name: 'audit', command: 'npm audit' }],
  },
];

export function generateConfigYaml(opts: GenerateConfigOptions = {}): string {
  // Resolve ecosystem entries — default to composer+npm when not provided
  const configEntries = (opts.ecosystemConfigs && opts.ecosystemConfigs.length > 0)
    ? opts.ecosystemConfigs
    : DEFAULT_ECOSYSTEM_CONFIGS;

  const ecosystems = configEntries.map((entry) => ({
    id: entry.id,
    hasFixer: !!(entry.fixerStrategy),
    fixer: entry.fixerStrategy,
    hasValidationCommands: (entry.validationCommands?.length ?? 0) > 0,
    validationCommands: entry.validationCommands ?? [],
    hasAdvisors: (entry.advisors?.length ?? 0) > 0,
    advisors: entry.advisors ?? [],
  }));

  // Resolve selected ecosystem ids for protected_packages
  const selectedIds = ecosystems.map((e) => e.id);

  // Always emit both known ecosystem keys in protected_packages for schema compatibility.
  const allKnownIds = ['composer', 'npm'];
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

  // Normalize the project name into a valid SonarQube project_key for the template.
  const rawProjectName = opts.projectName ?? 'My Project';
  const sonarProjectKey = normalizeSonarProjectKey(rawProjectName);

  return compiled({
    projectName: rawProjectName,
    client: opts.client ?? 'Client Name',
    ecosystems,
    reportLanguage: opts.reportLanguage ?? 'pt-br',
    protectedPackageEcosystems,
    enableSonarQube: opts.enableSonarQube ?? false,
    hasOutputs,
    outputFormats,
    outputsDir,
    sonarProjectKey,
    npmRuntimeVersion: opts.npmRuntimeVersion,
  });
}

