import { runScanner } from "@modules/scanner/index";
import { runOrchestrator } from "@orchestration/orchestrator";
import {
  generateExecutiveReport,
  executiveReportFilename,
  generateSonarQubeMarkdownReport,
  sonarqubeReportFilename,
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
  const markdownEnabled =
    (outputsConfig?.formats ?? []).includes('markdown') ||
    // Legacy: if reports_dir is set but no outputs config, default to saving
    (!outputsConfig && !!config.reports_dir);

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

  // Use outputs.dir if present, fall back to legacy reports_dir
  const reportsDir = resolveReportsDir(opts.cwd, outputsConfig?.dir ?? config.reports_dir);
  const subFoldersEnabled = outputsConfig?.sub_folders ?? false;
  const sonarReportsDir = resolveEngineReportsDir(reportsDir, subFoldersEnabled ? 'sonarqube' : undefined);

  if (markdownEnabled) {
    const filename = executiveReportFilename(client, project);
    await saveReport(
      filename,
      report,
      reportsDir,
      config.cloud_storage,
      opts.cwd,
    );

    const engineResults = orchestratorResult.aggregated?.engineResults;

    // Standalone SonarQube Markdown artifact (rich: conditions + issues by file)
    const sonarMarkdown = generateSonarQubeMarkdownReport(
      engineResults,
      project,
      config.report_language,
    );
    if (sonarMarkdown) {
      const date = new Date().toISOString().split('T')[0]!;
      const sonarFilename = sonarqubeReportFilename(project, date);
      await saveReport(
        sonarFilename,
        sonarMarkdown,
        sonarReportsDir,
        config.cloud_storage,
        opts.cwd,
      );
    }

    // Standalone SonarQube HTML artifact
    const sonarHtml = generateSonarQubeHtmlReport(engineResults, client, project);
    if (sonarHtml) {
      const htmlFilename = sonarqubeHtmlReportFilename(client, project);
      await saveReport(
        htmlFilename,
        sonarHtml,
        sonarReportsDir,
        config.cloud_storage,
        opts.cwd,
      );
    }
  }

  return 0;
}
