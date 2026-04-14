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
import { DEFAULT_CONFIG_PATH } from "@infra/config/loader";
import {
  ConfigLoadError,
  GateValidationError,
  PhaseError,
} from "@core/errors";
import { runCloudSetup } from "@app/commands/cloud-setup";
import { runInitCommand } from "@app/commands/init";
import { createRunContext } from "@app/run-context";
import { runScanCommand, type ScanCommandOptions } from "@app/commands/scan";
import { runFixCommand, type FixCommandOptions } from "@app/commands/fix";
import {
  runExecutiveReportCommand,
  type ExecutiveReportCommandOptions,
} from "@app/commands/executive-report";
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
// NOTE: init/config scaffolding is registry-driven via EcosystemPlugin.
// New ecosystems added to the registry are picked up automatically at runtime
// without touching this command or the orchestrator.
// Update this command only when new ecosystems need first-class `init` UX.
program
  .command("init")
  .description("Generate a project-config.yml template in the current project")
  .option("--project-name <name>", "Project name")
  .option("--client <name>", "Client name")
  .option("--cwd <path>", "Working directory", process.cwd())
  .option("--output <path>", "Output path (default: ./project-config.yml)")
  .option("--force", "Overwrite existing file", false)
  .action(async (opts) => {
    await runInitCommand(opts);
  });

// scan command
commonOptions(
  program.command("scan").description("Run vulnerability scan only (Phase 1)"),
).action(async (opts: ScanCommandOptions) => {
  await runCliAction(() => createRunContext(opts).then((ctx) => runScanCommand(ctx, opts)));
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
).action(async (opts: FixCommandOptions) => {
  await runCliAction(() => createRunContext(opts).then((ctx) => runFixCommand(ctx, opts)));
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
).action(async (opts: ExecutiveReportCommandOptions) => {
  await runCliAction(() => createRunContext(opts).then((ctx) => runExecutiveReportCommand(ctx, opts)));
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

/**
 * Shared error/exit wrapper for all main CLI actions.
 * Invokes `fn`, maps known error types to exit codes, then exits.
 *
 * Exit codes:
 *   0 — success
 *   1 — vulnerabilities / update errors (returned by handler)
 *   2 — GateValidationError | PhaseError | unexpected error
 *   3 — ConfigLoadError
 */
async function runCliAction(fn: () => Promise<number>): Promise<void> {
  let exitCode = 0;

  try {
    exitCode = await fn();
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
