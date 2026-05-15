import { writeFile, access, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { DEFAULT_CONFIG_PATH } from '@infra/config/loader';
import { generateConfigYaml, type GenerateConfigOptions } from '@infra/config/generator';
import { writeSonarPropertiesTemplateIfMissing } from './sonar-properties-template';
import { prompt } from '@infra/utils/prompt';
import { confirmPrompt, selectPrompt, checkboxPrompt } from '@infra/utils/inquirer-prompts';
import { detectEcosystems } from '@infra/utils/detect-ecosystems';
import { defaultRegistry } from '@modules/ecosystem/index';
import { ConfigLoadError } from '@core/errors';
import { resolveDefaultLocale } from '@core/locale-detect';
import { CLI_NAME, DEFAULT_REPORTS_SUBDIR } from '@infra/brand';
import { getInitLocale } from '@app/i18n/init-locale';

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

  // Check if file already exists — stays in English (fires before language selection)
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

  // ─── Language selection (FIRST interactive question) ─────────────────────────

  let reportLanguage: 'pt-br' | 'en' = resolveDefaultLocale();

  if (!opts.nonInteractive) {
    // The label is bilingual because it appears before any locale is resolved
    reportLanguage = await selectPrompt<'pt-br' | 'en'>(
      'Language / Idioma',
      [
        { name: 'English (en)', value: 'en' },
        { name: 'Português (pt-br)', value: 'pt-br' },
      ],
      resolveDefaultLocale(),
    );
  }

  // Load the locale object for all subsequent prompts and messages
  const t = getInitLocale(reportLanguage);

  // ─── Project name and client ──────────────────────────────────────────────────

  const projectName = opts.projectName ?? await prompt(t.projectNamePrompt, 'Project');
  const client = opts.client ?? await prompt(t.clientNamePrompt, 'Client Name');

  // ─── Ecosystem selection (registry-driven) ───────────────────────────────────

  const allPlugins = defaultRegistry.getAll();
  const detectedIds = await detectEcosystems(opts.cwd, allPlugins);
  let selectedEcosystemIds: string[];

  if (opts.nonInteractive) {
    // Non-interactive: use detected ecosystems when found, otherwise fallback to all (safe for CI/new projects)
    selectedEcosystemIds = detectedIds.size > 0
      ? allPlugins.filter((p) => detectedIds.has(p.id)).map((p) => p.id)
      : allPlugins.map((p) => p.id);
  } else {
    selectedEcosystemIds = await checkboxPrompt(
      t.ecosystemSelectPrompt,
      allPlugins.map((p) => ({ name: `${p.name} (${p.id})`, value: p.id, checked: detectedIds.has(p.id) })),
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
        t.fixerStrategyPrompt(plugin.name),
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
          t.includeValidationCommandPrompt(plugin.name, defaultCmd.name),
          true,
        );
        if (include) {
          const cmdAnswer = await prompt(
            t.validationCommandValuePrompt(plugin.name, defaultCmd.name),
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
          t.includeAdvisorPrompt(plugin.name, defaultAdvisor.name),
          true,
        );
        if (include) {
          const advisorAnswer = await prompt(
            t.advisorCommandPrompt(plugin.name, defaultAdvisor.name),
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
        const versionPromptMsg = inferredVersion
          ? t.languageVersionPromptWithInferred(plugin.name, inferredVersion)
          : t.languageVersionPromptBlank(plugin.name);
        const versionAnswer = await prompt(versionPromptMsg, versionDefault);
        resolvedVersion = versionAnswer.trim() || undefined;
      } else {
        resolvedVersion = inferredVersion;
      }
      npmLanguageVersion = resolvedVersion;

      // image_source prompts for npm scanner
      if (!opts.nonInteractive) {
        npmImageSource = await selectPrompt(
          t.imageSourcePrompt(plugin.name),
          [
            { name: t.imageSourceDockerfile, value: 'dockerfile' as const },
            { name: t.imageSourcePull, value: 'pull' as const },
          ],
          'dockerfile',
        );
        if (npmImageSource === 'dockerfile') {
          const dfPath = await prompt(t.dockerfilePathPrompt(plugin.name), './Dockerfile');
          npmDockerfilePath = dfPath.trim() || './Dockerfile';
          const ctxAnswer = await prompt(t.buildContextPrompt(plugin.name), '');
          npmBuildContext = ctxAnswer.trim() || '.';
          const buildArgsAnswer = await prompt(t.buildArgsPrompt(plugin.name), '');
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
        const versionPromptMsg = inferredVersion
          ? t.phpVersionPromptWithInferred(plugin.name, inferredVersion)
          : t.phpVersionPromptBlank(plugin.name);
        const versionAnswer = await prompt(versionPromptMsg, versionDefault);
        resolvedVersion = versionAnswer.trim() || undefined;
      } else {
        resolvedVersion = inferredVersion;
      }
      composerLanguageVersion = resolvedVersion;

      // image_source prompts for composer scanner
      if (!opts.nonInteractive) {
        composerImageSource = await selectPrompt(
          t.imageSourcePrompt(plugin.name),
          [
            { name: t.imageSourceDockerfile, value: 'dockerfile' as const },
            { name: t.imageSourcePull, value: 'pull' as const },
          ],
          'dockerfile',
        );
        if (composerImageSource === 'dockerfile') {
          const dfPath = await prompt(t.dockerfilePathPrompt(plugin.name), './Dockerfile');
          composerDockerfilePath = dfPath.trim() || './Dockerfile';
          const ctxAnswer = await prompt(t.buildContextPrompt(plugin.name), '');
          composerBuildContext = ctxAnswer.trim() || '.';
          const buildArgsAnswer = await prompt(t.buildArgsPrompt(plugin.name), '');
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
        const versionPromptMsg = inferredVersion
          ? t.pythonVersionPromptWithInferred(plugin.name, inferredVersion)
          : t.pythonVersionPromptBlank(plugin.name);
        const versionAnswer = await prompt(versionPromptMsg, versionDefault);
        resolvedPipVersion = versionAnswer.trim() || undefined;
      } else {
        resolvedPipVersion = inferredVersion;
      }
      pipLanguageVersion = resolvedPipVersion;

      // image_source prompts for pip scanner
      if (!opts.nonInteractive) {
        pipImageSource = await selectPrompt(
          t.imageSourcePrompt(plugin.name),
          [
            { name: t.imageSourceDockerfile, value: 'dockerfile' as const },
            { name: t.imageSourcePull, value: 'pull' as const },
          ],
          'dockerfile',
        );
        if (pipImageSource === 'dockerfile') {
          const dfPath = await prompt(t.dockerfilePathPrompt(plugin.name), './Dockerfile');
          pipDockerfilePath = dfPath.trim() || './Dockerfile';
          const ctxAnswer = await prompt(t.buildContextPrompt(plugin.name), '');
          pipBuildContext = ctxAnswer.trim() || '.';
          const buildArgsAnswer = await prompt(t.buildArgsPrompt(plugin.name), '');
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
  let sonarQubeMode: 'managed' | 'external' = 'managed';
  if (!opts.nonInteractive) {
    enableSonarQube = await confirmPrompt(t.enableSonarQubePrompt, false);
    if (enableSonarQube) {
      sonarQubeMode = await selectPrompt<'managed' | 'external'>(
        t.sonarQubeModePrompt,
        [
          {
            name: t.sonarQubeModeManaged,
            value: 'managed',
          },
          {
            name: t.sonarQubeModeExternal,
            value: 'external',
          },
        ],
        'managed',
      );
    }
  }

  // ─── Output / report settings ────────────────────────────────────────────────

  let outputsDir: string | undefined;
  let enableMarkdown = true;

  if (!opts.nonInteractive) {
    enableMarkdown = await confirmPrompt(t.generateMarkdownPrompt, true);

    if (enableMarkdown) {
      const dirAnswer = await prompt(t.reportsOutputDirPrompt, DEFAULT_REPORTS_SUBDIR);
      outputsDir = dirAnswer.trim() || DEFAULT_REPORTS_SUBDIR;
    }
  } else {
    outputsDir = DEFAULT_REPORTS_SUBDIR;
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
    sonarQubeMode,
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
  process.stdout.write(t.createdFile(outputPath));

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
      process.stdout.write(t.createdFile(resolve(opts.cwd, 'sonar-project.properties')));
    } else {
      process.stdout.write(t.foundExistingSonarProps);
    }
  }

  process.stdout.write(t.nextStepsHeader);
  process.stdout.write(t.nextStepEditConfig(outputPath));
  process.stdout.write(t.nextStepReviewProtectedPackages);
  if (sonarPropsCreated) {
    process.stdout.write(t.nextStepReviewSonarProps);
    process.stdout.write(t.nextStepRunScanStep4(CLI_NAME));
  } else {
    process.stdout.write(t.nextStepRunScanStep3(CLI_NAME));
  }
  process.stdout.write(t.nextStepConfigNote);
}
