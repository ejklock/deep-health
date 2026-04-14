import { writeFile, access, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { DEFAULT_CONFIG_PATH } from '@infra/config/loader';
import { generateConfigYaml, type GenerateConfigOptions } from '@infra/config/generator';
import { prompt } from '@infra/utils/prompt';
import { defaultRegistry } from '@modules/ecosystem/index';

export interface InitCommandOptions {
  projectName?: string;
  client?: string;
  execution: string;
  dockerService: string;
  dockerWorkdir?: string;
  cwd: string;
  output?: string;
  force: boolean;
  /** Skip interactive prompts — used in tests and CI. */
  nonInteractive?: boolean;
}

async function promptBoolean(question: string, defaultYes = false): Promise<boolean> {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  const answer = await prompt(`${question} [${hint}]`, defaultYes ? 'y' : 'n');
  return answer.trim().toLowerCase().startsWith('y');
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
      process.stderr.write(
        `File already exists: ${outputPath}\nUse --force to overwrite.\n`,
      );
      process.exit(3);
    } catch {
      // File doesn't exist — proceed
    }
  }

  const projectName = opts.projectName ?? await prompt('Project name', 'Project');
  const client = opts.client ?? await prompt('Client name', 'Client Name');

  // ─── Ecosystem selection (registry-driven) ───────────────────────────────────

  const allPlugins = defaultRegistry.getAll();
  const selectedEcosystemIds: string[] = [];

  if (opts.nonInteractive) {
    // Non-interactive: pick all registered plugins
    selectedEcosystemIds.push(...allPlugins.map((p) => p.id));
  } else {
    process.stdout.write('\nAvailable ecosystems:\n');
    for (const plugin of allPlugins) {
      process.stdout.write(`  - ${plugin.name} (${plugin.id})\n`);
    }
    process.stdout.write('\n');

    for (const plugin of allPlugins) {
      const include = await promptBoolean(`Include ${plugin.name} (${plugin.id})?`, true);
      if (include) {
        selectedEcosystemIds.push(plugin.id);
      }
    }
  }

  // ─── Per-ecosystem config ────────────────────────────────────────────────────

  const ecosystemConfigs: GenerateConfigOptions['ecosystemConfigs'] = [];

  for (const id of selectedEcosystemIds) {
    const plugin = defaultRegistry.get(id)!;

    let fixerStrategy: string | undefined;
    if (plugin.supportedFixers.length > 0 && !opts.nonInteractive) {
      const defaultFixer = plugin.supportedFixers[0]!;
      const fixerAnswer = await prompt(
        `  [${plugin.name}] Fixer strategy (${plugin.supportedFixers.join('/')})`,
        defaultFixer,
      );
      fixerStrategy = plugin.supportedFixers.includes(fixerAnswer as typeof plugin.supportedFixers[0])
        ? fixerAnswer
        : defaultFixer;
    } else if (plugin.supportedFixers.length > 0) {
      fixerStrategy = plugin.supportedFixers[0];
    }

    // Validation commands
    const validationCommands: Array<{ name: string; command: string }> = [];
    if (!opts.nonInteractive) {
      for (const defaultCmd of plugin.defaultValidationCommands) {
        const cmdAnswer = await prompt(
          `  [${plugin.name}] Validation command "${defaultCmd.name}" (blank to skip)`,
          defaultCmd.command,
        );
        if (cmdAnswer.trim()) {
          validationCommands.push({ name: defaultCmd.name, command: cmdAnswer.trim() });
        }
      }
    } else {
      validationCommands.push(...plugin.defaultValidationCommands);
    }

    // Advisors
    const advisors: Array<{ name: string; command: string }> = [];
    if (!opts.nonInteractive) {
      for (const defaultAdvisor of plugin.defaultAdvisors) {
        const advisorAnswer = await prompt(
          `  [${plugin.name}] Advisor "${defaultAdvisor.name}" command (blank to skip)`,
          defaultAdvisor.command,
        );
        if (advisorAnswer.trim()) {
          advisors.push({ name: defaultAdvisor.name, command: advisorAnswer.trim() });
        }
      }
    } else {
      advisors.push(...plugin.defaultAdvisors);
    }

    ecosystemConfigs.push({ id, fixerStrategy, validationCommands, advisors });
  }

  // ─── Scanner options ─────────────────────────────────────────────────────────

  let enableSonarQube = false;
  if (!opts.nonInteractive) {
    enableSonarQube = await promptBoolean('Enable SonarQube scanner?', false);
  }

  // ─── Output / report settings ────────────────────────────────────────────────

  let reportLanguage: 'pt-br' | 'en' = 'pt-br';
  let outputsDir: string | undefined;
  let enableMarkdown = true;

  if (!opts.nonInteractive) {
    const langAnswer = await prompt('Report language (pt-br/en)', 'pt-br');
    reportLanguage = langAnswer === 'en' ? 'en' : 'pt-br';

    enableMarkdown = await promptBoolean('Generate markdown reports?', true);

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
    execution: opts.execution as 'docker' | 'local',
    dockerService: opts.dockerService,
    dockerWorkdir: opts.dockerWorkdir,
    reportLanguage,
    ecosystemConfigs,
    enableSonarQube,
    outputs: outputFormats.length > 0 || outputsDir
      ? { formats: outputFormats, dir: outputsDir }
      : undefined,
  });

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, yaml, 'utf-8');
  process.stdout.write(`Created: ${outputPath}\n`);
  process.stdout.write(`\nNext steps:\n`);
  process.stdout.write(`  1. Edit ${outputPath} to match your project\n`);
  process.stdout.write(
    `  2. Review protected_packages — add any packages that must not be auto-upgraded\n`,
  );
  process.stdout.write(
    `  3. Run: deep-health scan --cwd <your-project-dir>\n`,
  );
  process.stdout.write(
    `     (config will be loaded from project-config.yml at project root by default)\n`,
  );
}
