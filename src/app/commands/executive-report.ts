import { runScanner } from "@modules/scanner/index";
import { runOrchestrator } from "@orchestration/orchestrator";
import { generateAndSaveReportArtifacts } from "@app/report-artifacts";
import type { RunContext } from "@app/run-context";

export interface ExecutiveReportCommandOptions {
  config: string;
  cwd: string;
  dryRun: boolean;
  verbose: boolean;
  quiet: boolean;
  json: boolean;
  output?: string;
  client?: string;
  project?: string;
}

/**
 * Generates the executive report by running a scan before/after orchestration.
 * Returns an exit code (always 0 on success; errors bubble to the caller).
 */
export async function runExecutiveReportCommand(
  ctx: RunContext,
  opts: ExecutiveReportCommandOptions,
): Promise<number> {
  const { config, runner } = ctx;

  const client = opts.client ?? config.project.client;
  const project = opts.project ?? config.project.name;

  const scanBefore = await runScanner(runner, config, opts.cwd);

  const orchestratorResult = await runOrchestrator(runner, config, {
    configPath: opts.config,
    cwd: opts.cwd,
    dryRun: opts.dryRun,
    verbose: opts.verbose,
  });

  const artifactCode = await generateAndSaveReportArtifacts({
    runner,
    cwd: opts.cwd,
    config,
    client,
    project,
    scanBefore,
    updates: orchestratorResult.updates,
    engineResults: orchestratorResult.aggregated?.engineResults,
    advisorResults: Object.keys(orchestratorResult.advisorResults).length > 0
      ? orchestratorResult.advisorResults
      : undefined,
  });
  if (artifactCode !== 0) return artifactCode;

  return 0;
}
