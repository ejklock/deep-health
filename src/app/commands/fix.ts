import { runOrchestrator } from "@orchestration/orchestrator";
import { selectRenderer } from "@app/progress-reporter";
import { defaultRegistry } from "@modules/ecosystem/index";
import { writeOutput } from "@app/output-writer";
import {
  resolveReportsDir,
} from "@app/report-saver";
import { generateAndSaveReportArtifacts } from "@app/report-artifacts";
import type { RunContext } from "@app/run-context";
import { writeAuditTrail, resolveCliVersion } from "@app/audit-trail";
import { createBranchAndCommit, buildBranchName } from "@infra/utils/git-commit";
import { detectGitBranch } from "@infra/utils/git-branch";
import type { CommandRunner } from "@core/types/common";
import { CLI_NAME, DEFAULT_BRANCH_PREFIX } from "@infra/brand";

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
  /** Create a git branch before applying fixes and commit changes on success */
  createBranch?: boolean;
  /** Branch name prefix (default: 'fix/security-scan-') */
  branchPrefix?: string;
  /** Create a GitHub pull request after fix (implies createBranch; requires gh CLI) */
  openPr?: boolean;
  /** Pull request title (default: auto-generated) */
  prTitle?: string;
}

/**
 * Core fix pipeline: scan + ecosystem updates + reports.
 * Extracted from runFixCommand so it can be called inside a branch/commit wrapper.
 * Returns an exit code: 0 = success, 1 = error or pending vulns.
 */
async function runFixPipeline(
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
    rendererType: selectRenderer({ verbose: opts.verbose, quiet: opts.quiet, json: opts.json }),
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
          `[${CLI_NAME}] Breaking-change updates skipped for ${plugin.name} (${breaking} package(s): ${pkgs || "unknown"}).\n` +
          `  To authorize: ${CLI_NAME} fix --authorize-breaking ${plugin.id}\n`,
        );
      }
    }
  }

  // Resolve outputs config (canonical location for reports settings)
  const outputsConfig = config.outputs;
  const reportsDir = resolveReportsDir(opts.cwd, outputsConfig?.dir);
  // Markdown output is opt-in: only save to reportsDir when outputs.formats includes 'markdown'
  const markdownEnabled = (outputsConfig?.formats ?? []).includes('markdown');

  if (opts.json) {
    await writeOutput(JSON.stringify(result, null, 2), opts.output);
  }

  if (!opts.noReport && markdownEnabled && result.scan) {
    const artifactCode = await generateAndSaveReportArtifacts({
      runner,
      cwd: opts.cwd,
      config,
      scanBefore: result.scan,
      updates: result.updates,
      engineResults: result.aggregated?.engineResults,
      advisorResults: Object.keys(result.advisorResults).length > 0
        ? result.advisorResults
        : undefined,
      residualVerification: result.residualVerification,
    });
    if (artifactCode !== 0) return artifactCode;
  }

  // Fase 6: write audit trail
  const auditTimestamp = new Date().toISOString();
  const cliVersion = await resolveCliVersion();
  await writeAuditTrail(opts.cwd, {
    timestamp: auditTimestamp,
    cli_version: cliVersion,
    dry_run: opts.dryRun,
    scan: result.scan,
    updates: result.updates,
    overall_status: result.overallStatus,
    has_pending_vulns: result.hasPendingVulns,
  }, reportsDir);

  if (result.overallStatus === "error") return 1; // real crash/failure
  if (result.hasPendingVulns) return 1;           // scan clean-exit, vulns remain
  return 0;
}

/**
 * Runs the full fix workflow: scan + ecosystem updates + reports.
 * Returns an exit code:
 *   0 — success
 *   1 — overall status error
 *
 * When --create-branch or --open-pr is requested (and not --dry-run):
 *   - Detects the current branch.
 *   - Creates a new branch before any mutations.
 *   - Runs the fix pipeline.
 *   - Commits all changes on success; rolls back to original branch on failure.
 *   - If --open-pr: pushes the branch and opens a GitHub pull request via `gh`.
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
  const { runner } = ctx;

  // Resolve effective workflow options: CLI flags take precedence over config,
  // config takes precedence over hardcoded defaults.
  const wf = ctx.config.workflow;
  const effectiveCreateBranch = opts.createBranch ?? wf?.create_branch ?? false;
  const effectiveOpenPr = opts.openPr ?? wf?.open_pr ?? false;
  const useBranch = (effectiveOpenPr || effectiveCreateBranch) && !opts.dryRun;
  const branchPrefix = opts.branchPrefix ?? wf?.branch_prefix ?? DEFAULT_BRANCH_PREFIX;

  if (useBranch) {
    const originalBranch = await detectGitBranch(opts.cwd, runner);
    const branchName = buildBranchName(branchPrefix);

    const branchResult = await createBranchAndCommit(
      runner,
      opts.cwd,
      originalBranch,
      branchName,
      'fix: apply safe dependency updates [' + CLI_NAME + ']',
      async () => runFixPipeline(ctx, opts),
    );

    if (effectiveOpenPr && branchResult.committed) {
      const effectivePrTitle = opts.prTitle ?? wf?.pr_title;
      await openPullRequest(runner, opts.cwd, branchResult.branch, effectivePrTitle, ctx);
    }

    return branchResult.exitCode;
  }

  return runFixPipeline(ctx, opts);
}

/**
 * Push the branch and open a GitHub pull request via the `gh` CLI.
 * Requires the `gh` CLI to be installed and authenticated.
 * Exits with code 3 if `gh` is not available.
 */
async function openPullRequest(
  runner: CommandRunner,
  cwd: string,
  branchName: string,
  prTitle: string | undefined,
  ctx: RunContext,
): Promise<void> {
  const { config } = ctx;
  const cliVersion = await resolveCliVersion();

  // Check gh CLI is available
  const ghCheck = await runner.runArgs('gh', ['--version'], { cwd });
  if (ghCheck.exitCode !== 0) {
    process.stderr.write(
      `[${CLI_NAME}] --open-pr requires the GitHub CLI (gh). ` +
      'Install it from https://cli.github.com and run: gh auth login\n',
    );
    process.exit(3);
  }

  // Push branch
  const pushResult = await runner.runArgs('git', ['push', 'origin', branchName], { cwd });
  if (pushResult.exitCode !== 0) {
    throw new Error(`git push failed: ${pushResult.stderr || pushResult.stdout}`);
  }

  const title = prTitle ?? `fix: apply safe dependency updates for ${config.project.name}`;

  const body = [
    `## Summary`,
    ``,
    `Automated dependency update by ${CLI_NAME} v${cliVersion}.`,
    ``,
    `**Project:** ${config.project.client} / ${config.project.name}`,
    `**Ecosystems:** ${config.ecosystems.map((e) => e.id).join(', ')}`,
    ``,
    `🤖 Co-authored with ${CLI_NAME} v${cliVersion}`,
  ].join('\n');

  const prResult = await runner.runArgs(
    'gh',
    ['pr', 'create', '--title', title, '--body', body],
    { cwd },
  );

  if (prResult.exitCode !== 0) {
    throw new Error(`gh pr create failed: ${prResult.stderr || prResult.stdout}`);
  }

  const prUrl = prResult.stdout.trim();
  process.stdout.write(`[${CLI_NAME}] Pull request created: ${prUrl}\n`);
}
