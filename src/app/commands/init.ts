import { writeFile, access, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { DEFAULT_CONFIG_PATH } from '@infra/config/loader';
import { generateConfigYaml } from '@infra/config/generator';
import { prompt } from '@infra/utils/prompt';

export interface InitCommandOptions {
  projectName?: string;
  client?: string;
  execution: string;
  dockerService: string;
  dockerWorkdir?: string;
  ecosystems: string;
  phpVersion: string;
  nodeVersion: string;
  testCommand: string;
  reportLanguage: string;
  cwd: string;
  output?: string;
  force: boolean;
}

// NOTE: init/config scaffolding is intentionally product-scoped to php/npm.
// The runtime scan → update → report architecture is fully registry-extensible
// via EcosystemPlugin; new ecosystems added to the registry are picked up
// automatically without touching this command or the orchestrator.
// Update this command only when new ecosystems need first-class `init` UX.
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

  const projectName =
    opts.projectName ?? (await prompt('Project name', 'Project'));
  const client = opts.client ?? (await prompt('Client name', 'Client Name'));

  const yaml = generateConfigYaml({
    projectName,
    client,
    execution: opts.execution as 'docker' | 'local',
    dockerService: opts.dockerService,
    dockerWorkdir: opts.dockerWorkdir,
    ecosystems: (opts.ecosystems as string)
      .split(',')
      .map((s: string) => s.trim()) as ('php' | 'npm')[],
    phpVersion: opts.phpVersion,
    nodeVersion: opts.nodeVersion,
    testCommand: opts.testCommand,
    reportLanguage: opts.reportLanguage as 'pt-br' | 'en',
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
