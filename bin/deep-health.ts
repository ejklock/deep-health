#!/usr/bin/env node

// Runtime Node.js version guard — must run before any other imports.
const [nodeMajor] = process.versions.node.split(".").map(Number);
if (nodeMajor < 22) {
  process.stderr.write(
    `deep-health requires Node.js >=22. Detected: v${process.versions.node}\n` +
      `Please upgrade Node.js and try again.\n`,
  );
  process.exit(1);
}

import { Command } from "commander";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig, DEFAULT_CONFIG_PATH } from "@infra/config/loader.js";
import { generateConfigYaml } from "@infra/config/generator.js";
import { detectEnvironment } from "@infra/environment/detector.js";
import { runOrchestrator } from "@orchestration/orchestrator.js";
import { generateConsolidatedReport } from "@reporting/consolidated.js";
import {
  generateExecutiveReport,
  executiveReportFilename,
} from "@reporting/executive.js";
import { runScanner } from "@modules/scanner/index.js";
import { setLogLevel } from "@infra/utils/logger.js";
import {
  ConfigLoadError,
  GateValidationError,
  PhaseError,
} from "@core/errors.js";
import { prompt } from "@infra/utils/prompt.js";
import { runCloudSetup } from "@app/commands/cloud-setup.js";
import { defaultRegistry } from "@modules/ecosystem/index.js";
import { writeOutput, formatScanSummary } from "@app/output-writer.js";
import {
  saveReport,
  saveSonarQubeExport,
  resolveReportsDir,
} from "@app/report-saver.js";
import type { ConsolidatedReport } from "@core/types/report.js";
import pkg from "../package.json" with { type: "json" };

const pkgVersion: string = pkg.version;

const program = new Command();

program
  .name("deep-health")
  .description("OSV vulnerability scanning and safe dependency update CLI")
  .version(pkgVersion);

const commonOptions = (cmd: Command) =>
  cmd
    .option(
      "-c, --config <path>",
      "Path to project-config.yml",
      DEFAULT_CONFIG_PATH,
    )
    .option("--cwd <path>", "Working directory", process.cwd())
    .option("--dry-run", "Show commands without executing", false)
    .option("-v, --verbose", "Verbose output", false)
    .option(
      "-q, --quiet",
      "Suppress all output except errors and final report",
      false,
    )
    .option("--json", "Output results as JSON", false)
    .option("-o, --output <path>", "Write report to file");

// init command
// NOTE: init/config scaffolding is intentionally product-scoped to php/npm.
// The runtime scan → update → report architecture is fully registry-extensible
// via EcosystemPlugin; new ecosystems added to the registry are picked up
// automatically without touching this command or the orchestrator.
// Update this command only when new ecosystems need first-class `init` UX.
program
  .command("init")
  .description("Generate a project-config.yml template in the current project")
  .option("--project-name <name>", "Project name")
  .option("--client <name>", "Client name")
  .option("--execution <mode>", "Execution mode: docker or local", "docker")
  .option("--docker-service <service>", "Docker Compose service name", "app")
  .option(
    "--docker-workdir <path>",
    "Working directory inside the container (e.g. /var/www/html)",
  )
  .option(
    "--ecosystems <list>",
    "Comma-separated ecosystems: php,npm (default: php,npm)",
    "php,npm",
  )
  .option("--php-version <version>", "PHP version", "8.2")
  .option("--node-version <version>", "Node.js version", "20.x")
  .option("--test-command <cmd>", "Test command", "php artisan test --compact")
  .option(
    "--report-language <lang>",
    "Report language: pt-br (default) or en",
    "pt-br",
  )
  .option("--cwd <path>", "Working directory", process.cwd())
  .option("--output <path>", "Output path (default: ./project-config.yml)")
  .option("--force", "Overwrite existing file", false)
  .action(async (opts) => {
    const { access, mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");

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
      opts.projectName ?? (await prompt("Project name", "Project"));
    const client = opts.client ?? (await prompt("Client name", "Client Name"));

    const yaml = generateConfigYaml({
      projectName,
      client,
      execution: opts.execution as "docker" | "local",
      dockerService: opts.dockerService,
      dockerWorkdir: opts.dockerWorkdir,
      ecosystems: (opts.ecosystems as string)
        .split(",")
        .map((s: string) => s.trim()) as ("php" | "npm")[],
      phpVersion: opts.phpVersion,
      nodeVersion: opts.nodeVersion,
      testCommand: opts.testCommand,
      reportLanguage: opts.reportLanguage as "pt-br" | "en",
    });

    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, yaml, "utf-8");
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
  });

// scan command
commonOptions(
  program.command("scan").description("Run vulnerability scan only (Phase 1)"),
).action(async (opts) => {
  await runCommand("scan", opts);
});

// fix command
commonOptions(
  program
    .command("fix")
    .description(
      "Run full workflow: scan + ecosystem updates + executive report",
    )
    .option(
      "--phases <phases>",
      "Comma-separated phases: scan,npm,composer,report",
      "scan,npm,composer",
    )
    .option("--no-report", "Skip executive report generation", false)
    // Generic: --authorize-breaking can be passed multiple times, once per ecosystem id
    .option(
      "--authorize-breaking <ecosystemId...>",
      "Authorize breaking-change updates for the given ecosystem id(s). Example: --authorize-breaking composer npm",
    ),
).action(async (opts) => {
  await runCommand("fix", opts);
});

// executive-report command
commonOptions(
  program
    .command("executive-report")
    .description(
      "Generate executive report (reads client/project from config by default)",
    )
    .option("--client <name>", "Client name (default: from project-config.yml)")
    .option(
      "--project <name>",
      "Project name (default: from project-config.yml)",
    ),
).action(async (opts) => {
  await runCommand("executive-report", opts);
});

// cloud-setup command
program
  .command("cloud-setup")
  .description(
    "Interactive Google Drive folder picker — saves folder_id to project-config.yml",
  )
  .option(
    "-c, --config <path>",
    "Path to project-config.yml",
    DEFAULT_CONFIG_PATH,
  )
  .option("--cwd <path>", "Working directory", process.cwd())
  .action(async (opts: { config: string; cwd: string }) => {
    await runCloudSetup({ configPath: opts.config, cwd: opts.cwd });
  });

async function runCommand(
  command: string,
  opts: {
    config: string;
    cwd: string;
    dryRun: boolean;
    verbose: boolean;
    quiet: boolean;
    json: boolean;
    output?: string;
    phases?: string;
    client?: string;
    project?: string;
    noReport?: boolean;
    /**
     * Generic: ecosystem ids to authorize breaking changes for.
     * Populated by --authorize-breaking <id...>
     */
    authorizeBreaking?: string[];
  },
): Promise<void> {
  if (opts.verbose) setLogLevel("debug");
  if (opts.quiet) setLogLevel("error");

  let exitCode = 0;

  try {
    const config = await loadConfig(opts.config, opts.cwd);
    const runner = await detectEnvironment(
      config.runtime.execution,
      config.runtime.docker_service,
      opts.cwd,
      opts.dryRun,
      config.runtime.docker_workdir,
    );

    if (command === "scan") {
      const scanResult = await runScanner(runner, config, opts.cwd);
      const output = opts.json
        ? JSON.stringify(scanResult, null, 2)
        : formatScanSummary(scanResult);
      await writeOutput(output, opts.output);
      if (scanResult.status === "error") exitCode = 2;
      else if (Object.values(scanResult.ecosystems).some((e) => e.breaking > 0))
        exitCode = 1;
    } else if (command === "fix") {
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
          const reportsDir = resolveReportsDir(
            opts.cwd,
            config.reports_dir,
          );
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

      if (result.overallStatus === "error") exitCode = 1;
    } else if (command === "executive-report") {
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
    }
  } catch (err) {
    if (err instanceof ConfigLoadError) {
      process.stderr.write(`Configuration error: ${err.message}\n`);
      exitCode = 3;
    } else if (err instanceof GateValidationError) {
      process.stderr.write(`Gate ${err.gate} validation failed:\n`);
      for (const e of err.errors) process.stderr.write(`  - ${e}\n`);
      exitCode = 2;
    } else if (err instanceof PhaseError) {
      process.stderr.write(`Phase "${err.phase}" failed: ${err.message}\n`);
      exitCode = 2;
    } else {
      process.stderr.write(
        `Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      exitCode = 2;
    }
  }

  process.exit(exitCode);
}

program.parse();
