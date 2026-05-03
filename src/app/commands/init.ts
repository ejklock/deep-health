import { writeFile, access, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { DEFAULT_CONFIG_PATH } from '@infra/config/loader';
import { generateConfigYaml, type GenerateConfigOptions } from '@infra/config/generator';
import { writeSonarPropertiesTemplateIfMissing } from './sonar-properties-template';
import { prompt } from '@infra/utils/prompt';
import { confirmPrompt, selectPrompt, checkboxPrompt } from '@infra/utils/inquirer-prompts';
import { defaultRegistry } from '@modules/ecosystem/index';
import { ConfigLoadError } from '@core/errors';

export interface InitCommandOptions {
  projectName?: string;
  client?: string;
  cwd: string;
  output?: string;
  force: boolean;
  /** Skip interactive prompts — used in tests and CI. */
  nonInteractive?: boolean;
}

/**
 * Parses a comma-separated KEY=VALUE string into a Record<string, string>.
 * Returns undefined when the input is blank or yields no valid pairs.
 */
function parseBuildArgs(raw: string): Record<string, string> | undefined {
  const pairs = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const result: Record<string, string> = {};
  for (const pair of pairs) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx > 0) {
      result[pair.slice(0, eqIdx).trim()] = pair.slice(eqIdx + 1).trim();
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Registry-driven init: prompts for ecosystems from the plugin registry,
 * per-ecosystem fixer strategy, validation commands, and advisors.
 * Also prompts for OSV/SonarQube scanner config and outputs settings.
 */
export async function runInitCommand(opts: InitCommandOptions): Promise<void> {
  const outputPath = opts.output
    ? resolve(opts.cwd, opts.output)
    : resolve(opts.cwd, DEFAULT_CONFIG_PATH);

  // Check if file already exists
  if (!opts.force) {
    try {
      await access(outputPath);
      throw new ConfigLoadError(
        `File already exists: ${outputPath}\nUse --force to overwrite.`,
        outputPath,
      );
    } catch (err) {
      // Re-throw our own error
      if (err instanceof ConfigLoadError) throw err;
      // Re-throw unexpected fs errors (e.g. EACCES, EPERM) — only swallow ENOENT
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // File doesn't exist — proceed
    }
  }

  const projectName = opts.projectName ?? await prompt('Project name', 'Project');
  const client = opts.client ?? await prompt('Client name', 'Client Name');

  // ─── Ecosystem selection (registry-driven) ───────────────────────────────────

  const allPlugins = defaultRegistry.getAll();
  let selectedEcosystemIds: string[];

  if (opts.nonInteractive) {
    // Non-interactive: pick all registered plugins
    selectedEcosystemIds = allPlugins.map((p) => p.id);
  } else {
    selectedEcosystemIds = await checkboxPrompt(
      'Select ecosystems to configure',
      allPlugins.map((p) => ({ name: `${p.name} (${p.id})`, value: p.id, checked: true })),
    );
  }

  // ─── Per-ecosystem config ────────────────────────────────────────────────────

  const ecosystemConfigs: GenerateConfigOptions['ecosystemConfigs'] = [];
  /** Inferred npm language version (written to runners.npm.language_version, not ecosystem entry). */
  let npmLanguageVersion: string | undefined;
  /** Inferred Python language version (written to runners.pip.language_version, not ecosystem entry). */
  let pipLanguageVersion: string | undefined;
  /** Inferred PHP language version (written to runners.composer.language_version, not ecosystem entry). */
  let composerLanguageVersion: string | undefined;

  // Dockerfile image-source options — one set per ecosystem scanner
  let npmImageSource: 'pull' | 'dockerfile' | undefined;
  let npmDockerfilePath: string | undefined;
  let npmBuildContext: string | undefined;
  let npmBuildArgs: Record<string, string> | undefined;

  let pipImageSource: 'pull' | 'dockerfile' | undefined;
  let pipDockerfilePath: string | undefined;
  let pipBuildContext: string | undefined;
  let pipBuildArgs: Record<string, string> | undefined;

  let composerImageSource: 'pull' | 'dockerfile' | undefined;
  let composerDockerfilePath: string | undefined;
  let composerBuildContext: string | undefined;
  let composerBuildArgs: Record<string, string> | undefined;

  for (const id of selectedEcosystemIds) {
    const plugin = defaultRegistry.get(id)!;

    let fixerStrategy: string | undefined;
    if (plugin.supportedFixers.length > 0 && !opts.nonInteractive) {
      fixerStrategy = await selectPrompt(
        `  [${plugin.name}] Fixer strategy`,
        plugin.supportedFixers.map((f) => ({ name: f, value: f })),
      );
    } else if (plugin.supportedFixers.length > 0) {
      fixerStrategy = plugin.supportedFixers[0];
    }

    // Validation commands
    const validationCommands: Array<{ name: string; command: string }> = [];
    if (!opts.nonInteractive) {
      for (const defaultCmd of plugin.defaultValidationCommands) {
        const include = await confirmPrompt(
          `  [${plugin.name}] Include "${defaultCmd.name}" validation command?`,
          true,
        );
        if (include) {
          const cmdAnswer = await prompt(
            `  [${plugin.name}] Validation command "${defaultCmd.name}"`,
            defaultCmd.command,
          );
          if (cmdAnswer.trim()) {
            validationCommands.push({ name: defaultCmd.name, command: cmdAnswer.trim() });
          }
        }
      }
    } else {
      validationCommands.push(...plugin.defaultValidationCommands);
    }

    // Advisors
    const advisors: Array<{ name: string; command: string }> = [];
    if (!opts.nonInteractive) {
      for (const defaultAdvisor of plugin.defaultAdvisors) {
        const include = await confirmPrompt(
          `  [${plugin.name}] Include "${defaultAdvisor.name}" advisor?`,
          true,
        );
        if (include) {
          const advisorAnswer = await prompt(
            `  [${plugin.name}] Advisor "${defaultAdvisor.name}" command`,
            defaultAdvisor.command,
          );
          if (advisorAnswer.trim()) {
            advisors.push({ name: defaultAdvisor.name, command: advisorAnswer.trim() });
          }
        }
      }
    } else {
      advisors.push(...plugin.defaultAdvisors);
    }

    // ── Version inference (plugin-native, scoped to selected ecosystems) ──
    const inferredVersion = plugin.inferVersion
      ? await plugin.inferVersion(opts.cwd)
      : undefined;

    if (id === 'npm') {
      // npm language version is stored in runners.npm.language_version, not in the ecosystem entry.
      let resolvedVersion: string | undefined;
      if (!opts.nonInteractive) {
        const versionDefault = inferredVersion ?? '';
        const versionPrompt = inferredVersion
          ? `  [${plugin.name}] Language version (inferred: ${inferredVersion}, blank to skip)`
          : `  [${plugin.name}] Language version (blank to skip)`;
        const versionAnswer = await prompt(versionPrompt, versionDefault);
        resolvedVersion = versionAnswer.trim() || undefined;
      } else {
        resolvedVersion = inferredVersion;
      }
      npmLanguageVersion = resolvedVersion;

      // image_source prompts for npm scanner
      if (!opts.nonInteractive) {
        npmImageSource = await selectPrompt(
          `  [${plugin.name}] Image source`,
          [
            { name: 'pull (default)', value: 'pull' as const },
            { name: 'dockerfile (custom build)', value: 'dockerfile' as const },
          ],
        );
        if (npmImageSource === 'dockerfile') {
          const dfPath = await prompt(`  [${plugin.name}] Dockerfile path`, './Dockerfile');
          npmDockerfilePath = dfPath.trim() || './Dockerfile';
          const ctxAnswer = await prompt(`  [${plugin.name}] Build context (blank for '.')`, '');
          npmBuildContext = ctxAnswer.trim() || '.';
          const buildArgsAnswer = await prompt(
            `  [${plugin.name}] Build args (KEY=VALUE comma-separated, blank to skip)`,
            '',
          );
          npmBuildArgs = parseBuildArgs(buildArgsAnswer);
        }
      } else {
        npmImageSource = 'pull';
      }
    } else if (id === 'composer') {
      // composer PHP language version is stored in runners.composer.language_version
      let resolvedVersion: string | undefined;
      if (!opts.nonInteractive) {
        const versionDefault = inferredVersion ?? '';
        const versionPrompt = inferredVersion
          ? `  [${plugin.name}] PHP language version (inferred: ${inferredVersion}, blank to skip)`
          : `  [${plugin.name}] PHP language version (blank to skip)`;
        const versionAnswer = await prompt(versionPrompt, versionDefault);
        resolvedVersion = versionAnswer.trim() || undefined;
      } else {
        resolvedVersion = inferredVersion;
      }
      composerLanguageVersion = resolvedVersion;

      // image_source prompts for composer scanner
      if (!opts.nonInteractive) {
        composerImageSource = await selectPrompt(
          `  [${plugin.name}] Image source`,
          [
            { name: 'pull (default)', value: 'pull' as const },
            { name: 'dockerfile (custom build)', value: 'dockerfile' as const },
          ],
        );
        if (composerImageSource === 'dockerfile') {
          const dfPath = await prompt(`  [${plugin.name}] Dockerfile path`, './Dockerfile');
          composerDockerfilePath = dfPath.trim() || './Dockerfile';
          const ctxAnswer = await prompt(`  [${plugin.name}] Build context (blank for '.')`, '');
          composerBuildContext = ctxAnswer.trim() || '.';
          const buildArgsAnswer = await prompt(
            `  [${plugin.name}] Build args (KEY=VALUE comma-separated, blank to skip)`,
            '',
          );
          composerBuildArgs = parseBuildArgs(buildArgsAnswer);
        }
      } else {
        composerImageSource = 'pull';
      }
    } else if (id === 'pip') {
      // pip Python language version is stored in runners.pip.language_version
      let resolvedPipVersion: string | undefined;
      if (!opts.nonInteractive) {
        const versionDefault = inferredVersion ?? '';
        const versionPrompt = inferredVersion
          ? `  [${plugin.name}] Python language version (inferred: ${inferredVersion}, blank to skip)`
          : `  [${plugin.name}] Python language version (blank to skip)`;
        const versionAnswer = await prompt(versionPrompt, versionDefault);
        resolvedPipVersion = versionAnswer.trim() || undefined;
      } else {
        resolvedPipVersion = inferredVersion;
      }
      pipLanguageVersion = resolvedPipVersion;

      // image_source prompts for pip scanner
      if (!opts.nonInteractive) {
        pipImageSource = await selectPrompt(
          `  [${plugin.name}] Image source`,
          [
            { name: 'pull (default)', value: 'pull' as const },
            { name: 'dockerfile (custom build)', value: 'dockerfile' as const },
          ],
        );
        if (pipImageSource === 'dockerfile') {
          const dfPath = await prompt(`  [${plugin.name}] Dockerfile path`, './Dockerfile');
          pipDockerfilePath = dfPath.trim() || './Dockerfile';
          const ctxAnswer = await prompt(`  [${plugin.name}] Build context (blank for '.')`, '');
          pipBuildContext = ctxAnswer.trim() || '.';
          const buildArgsAnswer = await prompt(
            `  [${plugin.name}] Build args (KEY=VALUE comma-separated, blank to skip)`,
            '',
          );
          pipBuildArgs = parseBuildArgs(buildArgsAnswer);
        }
      } else {
        pipImageSource = 'pull';
      }
    }
    // Note: language versions are stored in the runner config block (runners.npm.language_version,
    // runners.pip.language_version, runners.composer.language_version), not in the ecosystem entry.

    ecosystemConfigs.push({ id, fixerStrategy, validationCommands, advisors });
  }

  // ─── Scanner options ─────────────────────────────────────────────────────────

  let enableSonarQube = false;
  if (!opts.nonInteractive) {
    enableSonarQube = await confirmPrompt('Enable SonarQube scanner?', false);
  }

  // ─── Output / report settings ────────────────────────────────────────────────

  let reportLanguage: 'pt-br' | 'en' = 'pt-br';
  let outputsDir: string | undefined;
  let enableMarkdown = true;

  if (!opts.nonInteractive) {
    reportLanguage = await selectPrompt<'pt-br' | 'en'>('Report language', [
      { name: 'Português (pt-br)', value: 'pt-br' },
      { name: 'English (en)', value: 'en' },
    ]);

    enableMarkdown = await confirmPrompt('Generate markdown reports?', true);

    if (enableMarkdown) {
      const dirAnswer = await prompt('Reports output directory', '.deep-health/reports');
      outputsDir = dirAnswer.trim() || '.deep-health/reports';
    }
  } else {
    outputsDir = '.deep-health/reports';
  }

  // Determine output formats: markdown when enabled
  const outputFormats: ('markdown')[] = [];
  if (enableMarkdown) outputFormats.push('markdown');

  const yaml = generateConfigYaml({
    projectName,
    client,
    reportLanguage,
    ecosystemConfigs,
    enableSonarQube,
    npmLanguageVersion,
    pipLanguageVersion,
    composerLanguageVersion,
    npmImageSource,
    npmDockerfilePath,
    npmBuildContext,
    npmBuildArgs,
    pipImageSource,
    pipDockerfilePath,
    pipBuildContext,
    pipBuildArgs,
    composerImageSource,
    composerDockerfilePath,
    composerBuildContext,
    composerBuildArgs,
    outputs: outputFormats.length > 0 || outputsDir
      ? { formats: outputFormats, dir: outputsDir }
      : undefined,
  });

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, yaml, 'utf-8');
  process.stdout.write(`Created: ${outputPath}\n`);

  // When SonarQube is enabled, make sure the project has a sonar-project.properties.
  // That file is SonarQube's convention for project-level analysis config (sources,
  // exclusions, project key). We never overwrite an existing one.
  let sonarPropsCreated = false;
  if (enableSonarQube) {
    const status = await writeSonarPropertiesTemplateIfMissing(opts.cwd, {
      projectName,
      ecosystemIds: selectedEcosystemIds,
    });
    if (status === 'created') {
      sonarPropsCreated = true;
      process.stdout.write(`Created: ${resolve(opts.cwd, 'sonar-project.properties')}\n`);
    } else {
      process.stdout.write(`Found existing sonar-project.properties (not overwritten)\n`);
    }
  }

  process.stdout.write(`\nNext steps:\n`);
  process.stdout.write(`  1. Edit ${outputPath} to match your project\n`);
  process.stdout.write(
    `  2. Review protected_packages — add any packages that must not be auto-upgraded\n`,
  );
  if (sonarPropsCreated) {
    process.stdout.write(
      `  3. Review sonar-project.properties — adjust sonar.sources and sonar.exclusions for your layout\n`,
    );
    process.stdout.write(
      `  4. Run: deep-health scan --cwd <your-project-dir>\n`,
    );
  } else {
    process.stdout.write(
      `  3. Run: deep-health scan --cwd <your-project-dir>\n`,
    );
  }
  process.stdout.write(
    `     (config will be loaded from project-config.yml at project root by default)\n`,
  );
}
