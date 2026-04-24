import { runScanner } from "@modules/scanner/index";
import { runOrchestrator } from "@orchestration/orchestrator";
import {
  generateExecutiveReport,
  executiveReportFilename,
} from "@reporting/executive";
import {
  generateSonarQubeHtmlReport,
  sonarqubeHtmlReportFilename,
} from "@reporting/sonarqube-report";
import {
  saveReport,
  resolveReportsDir,
  resolveEngineReportsDir,
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

  // Markdown output is opt-in: only save to reportsDir when outputs.formats includes 'markdown'
  const outputsConfig = config.outputs;
  const markdownEnabled = (outputsConfig?.formats ?? []).includes('markdown');

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
    locale: config.report_language,
    // Wire advisorResults from orchestrator into executive report
    advisorResults: Object.keys(orchestratorResult.advisorResults).length > 0
      ? orchestratorResult.advisorResults
      : undefined,
  });

  // Use outputs.dir if present
  const reportsDir = resolveReportsDir(opts.cwd, outputsConfig?.dir);
  const subFoldersEnabled = outputsConfig?.sub_folders ?? false;
  const sonarReportsDir = resolveEngineReportsDir(reportsDir, subFoldersEnabled ? 'sonarqube' : undefined);

  if (markdownEnabled) {
    const filename = executiveReportFilename(client, project);
    const outcome = await saveReport(
      filename,
      report,
      reportsDir,
      config.cloud_storage,
      opts.cwd,
    );
    if (outcome.cloudError && config.cloud_storage?.require_upload) {
      process.stderr.write(
        `[deep-health] Cloud upload required but failed: ${outcome.cloudError}\n`,
      );
      return 1;
    }

    // Standalone SonarQube HTML artifact
    const sonarHtml = generateSonarQubeHtmlReport(
      orchestratorResult.aggregated?.engineResults,
      client,
      project,
    );
    if (sonarHtml) {
      const htmlFilename = sonarqubeHtmlReportFilename(client, project);
      const sonarOutcome = await saveReport(
        htmlFilename,
        sonarHtml,
        sonarReportsDir,
        config.cloud_storage,
        opts.cwd,
      );
      if (sonarOutcome.cloudError && config.cloud_storage?.require_upload) {
        process.stderr.write(
          `[deep-health] Cloud upload required but failed (SonarQube HTML): ${sonarOutcome.cloudError}\n`,
        );
        return 1;
      }
    }
  }

  return 0;
}
