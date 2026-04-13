import Handlebars from 'handlebars';
import { getLocale } from '../report/i18n/index.js';
import type { SupportedLocale } from '../types/locale.js';
import configTemplate from './templates/project-config.hbs.js';

/**
 * Config / init scaffolding is intentionally product-scoped to php and npm.
 *
 * Rationale: the `init` command generates a project-config.yml for the two
 * currently supported product verticals (PHP/Composer and Node/npm). This
 * scaffolding is a convenience UX layer — it produces a static YAML file that
 * the user edits to match their project. Extending it to new ecosystems
 * requires deliberate UX decisions (prompts, example values, documentation).
 *
 * By contrast, the *runtime* architecture (scan → update → report) is fully
 * registry-extensible: any plugin that implements EcosystemPlugin and registers
 * with `defaultRegistry` is picked up automatically at runtime without changes
 * to this file, the CLI flags, or the orchestrator.
 *
 * TL;DR: add new ecosystems to the plugin registry for runtime support;
 * update this generator only when you want first-class `init` scaffolding.
 */

export interface GenerateConfigOptions {
  projectName?: string;
  client?: string;
  execution?: 'docker' | 'local';
  dockerService?: string;
  dockerWorkdir?: string;
  /**
   * Ecosystem shorthand list passed from CLI.
   * 'php' activates composer/PHP runtime settings.
   * 'npm' activates node/npm runtime settings.
   * Intentionally limited to known product verticals for config scaffolding.
   */
  ecosystems?: ('php' | 'npm')[];
  phpVersion?: string;
  nodeVersion?: string;
  testCommand?: string;
  frontendBuildCommand?: string;
  backendBuildCommand?: string;
  reportLanguage?: SupportedLocale;
}

const compiled = Handlebars.compile(configTemplate, { noEscape: true });

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

export function generateConfigYaml(opts: GenerateConfigOptions = {}): string {
  const locale = getLocale(opts.reportLanguage);
  const ecosystems = opts.ecosystems ?? ['php', 'npm'];
  const hasPhp = ecosystems.includes('php');
  const hasNpm = ecosystems.includes('npm');

  // Always emit both known ecosystem keys in protected_packages for schema compatibility.
  // Mark as active (with example comments) only when the ecosystem is selected.
  const protectedPackageEcosystems = [
    {
      id: 'composer',
      active: hasPhp,
      ...(ECOSYSTEM_EXAMPLES['composer'] ?? {}),
    },
    {
      id: 'npm',
      active: hasNpm,
      ...(ECOSYSTEM_EXAMPLES['npm'] ?? {}),
    },
  ];

  return compiled({
    projectName: opts.projectName ?? 'My PHP Project',
    client: opts.client ?? 'Client Name',
    execution: opts.execution ?? 'docker',
    dockerService: opts.dockerService ?? 'app',
    dockerWorkdir: opts.dockerWorkdir,
    hasPhp,
    hasNpm,
    phpVersion: opts.phpVersion ?? '8.2',
    nodeVersion: opts.nodeVersion ?? '20.x',
    testCommand: opts.testCommand ?? 'php artisan test --compact',
    frontendBuild: opts.frontendBuildCommand ?? 'npm run development-frontend',
    backendBuild: opts.backendBuildCommand ?? 'npm run development-backend',
    reportLanguage: opts.reportLanguage ?? 'pt-br',
    authorizationFormat: locale.authorization_format,
    protectedPackageEcosystems,
  });
}
