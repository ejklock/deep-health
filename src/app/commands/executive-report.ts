import { runScanner } from "@modules/scanner/index";
import { runOrchestrator } from "@orchestration/orchestrator";
import {
  generateExecutiveReport,
  executiveReportFilename,
} from "@reporting/executive";
import {
  saveReport,
  saveSonarQubeExport,
  resolveReportsDir,
} from "@app/report-saver";
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

  const scanAfter = await runScanner(runner, config, opts.cwd);

  const report = generateExecutiveReport({
    client,
    project,
    scanBefore,
    scanAfter,
    updates: orchestratorResult.updates,
    engineResults: orchestratorResult.aggregated?.engineResults,
  });

  const filename = executiveReportFilename(client, project);
  const reportsDir = resolveReportsDir(opts.cwd, config.reports_dir);
  await saveReport(
    filename,
    report,
    reportsDir,
    config.cloud_storage,
    opts.cwd,
  );

  // Save SonarQube detailed export when available
  if (orchestratorResult.aggregated?.engineResults) {
    const date = new Date().toISOString().split("T")[0]!;
    await saveSonarQubeExport(
      orchestratorResult.aggregated.engineResults,
      config.project.name,
      date,
      reportsDir,
      config.cloud_storage,
      opts.cwd,
    );
  }

  return 0;
}
