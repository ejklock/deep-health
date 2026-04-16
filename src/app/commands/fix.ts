import { runScanner } from "@modules/scanner/index";
import { runOrchestrator } from "@orchestration/orchestrator";
import {
  generateExecutiveReport,
  executiveReportFilename,
} from "@reporting/executive";
import { defaultRegistry } from "@modules/ecosystem/index";
import { writeOutput } from "@app/output-writer";
import {
  saveReport,
  resolveReportsDir,
  resolveEngineReportsDir,
} from "@app/report-saver";
import {
  generateSonarQubeHtmlReport,
  sonarqubeHtmlReportFilename,
} from "@reporting/sonarqube-report";
import type { RunContext } from "@app/run-context";

export interface FixCommandOptions {
  config: string;
  cwd: string;
  dryRun: boolean;
  verbose: boolean;
  quiet: boolean;
  json: boolean;
  output?: string;
  phases?: string;
  noReport?: boolean;
  /**
   * Generic: ecosystem ids to authorize breaking changes for.
   * Populated by --authorize-breaking <id...>
   */
  authorizeBreaking?: string[];
}

/**
 * Runs the full fix workflow: scan + ecosystem updates + reports.
 * Returns an exit code:
 *   0 — success
 *   1 — overall status error
 *
 * Scan architecture note:
 * - `runScanner` (called below as scanAfter) is OSV-ONLY.
 *   It produces the post-fix vulnerability snapshot used for the executive before/after diff.
 * - The before-fix snapshot (`scanBefore`) comes from `result.scan` returned by `runOrchestrator`,
 *   which performs the scan internally as part of Gate A. No standalone pre-fix scan is needed.
 * - SonarQube results come from the orchestrator pipeline (runOrchestrator) via
 *   `result.aggregated.engineResults`. They are NOT included in scanBefore/scanAfter.
 * - runOrchestrator is called exactly once and owns the full SonarQube execution lifecycle
 *   (including managed-mode provisioning). fix.ts never invokes SonarQube directly.
 */
export async function runFixCommand(
  ctx: RunContext,
  opts: FixCommandOptions,
): Promise<number> {
  const { config, runner } = ctx;

  const phases = opts.phases
    ? (opts.phases.split(",") as ("scan" | "npm" | "composer" | "report")[])
    : undefined;

  // Build authorizeBreaking set from --authorize-breaking <id...>
  const authorizedIds = new Set<string>(opts.authorizeBreaking ?? []);

  // Translate to authorizeBreaking record for orchestrator
  const authorizeBreakingRecord: Record<string, boolean> = {};
  for (const plugin of defaultRegistry.getAll()) {
    authorizeBreakingRecord[plugin.id] = authorizedIds.has(plugin.id);
  }

  const result = await runOrchestrator(runner, config, {
    configPath: opts.config,
    cwd: opts.cwd,
    dryRun: opts.dryRun,
    verbose: opts.verbose,
    phases,
    authorizeBreaking: authorizeBreakingRecord,
  });

  // Emit non-blocking warnings for ecosystems with breaking vulns and no authorization.
  // Uses result.scan (the canonical before-fix snapshot from the orchestrator's Gate A scan).
  if (result.scan) {
    const activePlugins = defaultRegistry.getAll().filter((p) =>
      config.ecosystems.some((e) => e.id === p.id),
    );
    for (const plugin of activePlugins) {
      const breaking = result.scan.ecosystems[plugin.id]?.breaking ?? 0;
      if (breaking > 0 && !authorizedIds.has(plugin.id)) {
        const pkgs = (
          result.scan.ecosystems[plugin.id]?.breaking_packages ?? []
        ).join(", ");
        process.stderr.write(
          `[deep-health] Breaking-change updates skipped for ${plugin.name} (${breaking} package(s): ${pkgs || "unknown"}).\n` +
          `  To authorize: deep-health fix --authorize-breaking ${plugin.id}\n`,
        );
      }
    }
  }

  // Resolve outputs config (canonical location for reports settings)
  const outputsConfig = config.outputs;
  const reportsDir = resolveReportsDir(opts.cwd, outputsConfig?.dir ?? config.reports_dir);
  const subFoldersEnabled = outputsConfig?.sub_folders ?? false;
  const sonarReportsDir = resolveEngineReportsDir(reportsDir, subFoldersEnabled ? 'sonarqube' : undefined);
  const reportLanguage = config.report_language;
  // Markdown output is opt-in: only save to reportsDir when outputs.formats includes 'markdown'
  const markdownEnabled =
    (outputsConfig?.formats ?? []).includes('markdown') ||
    // Legacy: if reports_dir is set but no outputs config, default to saving
    (!outputsConfig && !!config.reports_dir);

  if (opts.json) {
    await writeOutput(JSON.stringify(result, null, 2), opts.output);
  }

  if (!opts.noReport && markdownEnabled && result.scan) {
    const scanAfter = await runScanner(runner, config, opts.cwd);
    const execReport = generateExecutiveReport({
      client: config.project.client,
      project: config.project.name,
      scanBefore: result.scan,
      scanAfter,
      updates: result.updates,
      engineResults: result.aggregated?.engineResults,
      locale: reportLanguage,
      // Wire advisorResults into executive report
      advisorResults: Object.keys(result.advisorResults).length > 0
        ? result.advisorResults
        : undefined,
    });
    const filename = executiveReportFilename(
      config.project.client,
      config.project.name,
    );
    await saveReport(
      filename,
      execReport,
      reportsDir,
      config.cloud_storage,
      opts.cwd,
    );

    // Standalone SonarQube HTML artifact
    const sonarHtml = generateSonarQubeHtmlReport(
      result.aggregated?.engineResults,
      config.project.client,
      config.project.name,
    );
    if (sonarHtml) {
      const htmlFilename = sonarqubeHtmlReportFilename(config.project.client, config.project.name);
      await saveReport(
        htmlFilename,
        sonarHtml,
        sonarReportsDir,
        config.cloud_storage,
        opts.cwd,
      );
    }
  }

  if (result.overallStatus === "error") return 1;
  return 0;
}
