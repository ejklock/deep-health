import { runScanner } from "@modules/scanner/index";
import { runOrchestrator } from "@orchestration/orchestrator";
import { generateConsolidatedReport } from "@reporting/consolidated";
import {
  generateExecutiveReport,
  executiveReportFilename,
} from "@reporting/executive";
import { defaultRegistry } from "@modules/ecosystem/index";
import { writeOutput } from "@app/output-writer";
import {
  saveReport,
  saveSonarQubeExport,
  resolveReportsDir,
} from "@app/report-saver";
import type { RunContext } from "@app/run-context";
import type { ConsolidatedReport } from "@core/types/report";

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
 */
export async function runFixCommand(
  ctx: RunContext,
  opts: FixCommandOptions,
): Promise<number> {
  const { config, runner } = ctx;

  const phases = opts.phases
    ? (opts.phases.split(",") as ("scan" | "npm" | "composer" | "report")[])
    : undefined;

  const scanBefore = await runScanner(runner, config, opts.cwd);

  // Build authorizeBreaking set from --authorize-breaking <id...>
  const authorizedIds = new Set<string>(opts.authorizeBreaking ?? []);

  // Emit non-blocking warnings for ecosystems with breaking vulns and no authorization
  const activePlugins = defaultRegistry.getActive(config);
  for (const plugin of activePlugins) {
    const breaking = scanBefore.ecosystems[plugin.id]?.breaking ?? 0;
    if (breaking > 0 && !authorizedIds.has(plugin.id)) {
      const pkgs = (
        scanBefore.ecosystems[plugin.id]?.breaking_packages ?? []
      ).join(", ");
      process.stderr.write(
        `[deep-health] Breaking-change updates skipped for ${plugin.name} (${breaking} package(s): ${pkgs || "unknown"}).\n` +
        `  To authorize: deep-health fix --authorize-breaking ${plugin.id}\n`,
      );
    }
  }

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

  if (result.scan) {
    const report: ConsolidatedReport = {
      projectName: config.project.name,
      date: new Date().toISOString().split("T")[0]!,
      environment: runner.environment,
      scan: result.scan,
      updates: result.updates,
      overallStatus: result.overallStatus,
      engineResults: result.aggregated?.engineResults,
    };

    const output = opts.json
      ? JSON.stringify(result, null, 2)
      : generateConsolidatedReport(report);
    await writeOutput(output, opts.output);

    // Save SonarQube detailed export when available
    if (!opts.json && result.aggregated?.engineResults) {
      const date = report.date;
      const reportsDir = resolveReportsDir(opts.cwd, config.reports_dir);
      await saveSonarQubeExport(
        result.aggregated.engineResults,
        config.project.name,
        date,
        reportsDir,
        config.cloud_storage,
        opts.cwd,
      );
    }
  }

  if (!opts.noReport) {
    const scanAfter = await runScanner(runner, config, opts.cwd);
    const execReport = generateExecutiveReport({
      client: config.project.client,
      project: config.project.name,
      scanBefore,
      scanAfter,
      updates: result.updates,
      engineResults: result.aggregated?.engineResults,
    });
    const filename = executiveReportFilename(
      config.project.client,
      config.project.name,
    );
    const reportsDir = resolveReportsDir(opts.cwd, config.reports_dir);
    await saveReport(
      filename,
      execReport,
      reportsDir,
      config.cloud_storage,
      opts.cwd,
    );
  }

  if (result.overallStatus === "error") return 1;
  return 0;
}
