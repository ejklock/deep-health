import type { CommandRunner } from "@core/types/common";
import type { ValidationCommandConfig } from "@core/types/config";
import type { ValidationEntry } from "@core/types/update";
import { logger } from "@infra/utils/logger";

export interface RunValidationsOptions {
  runner: CommandRunner;
  cwd: string;
  commands: ValidationCommandConfig[];
  /**
   * Exit codes that are treated as success.
   * Defaults to [0] per standard shell semantics.
   */
  successExitCodes?: number[];
  /**
   * When true and commands is empty, returns allPassed: false instead of allPassed: true.
   * Use this when the caller requires at least one passing validation — a skip is not acceptable.
   * Defaults to false (existing behavior: empty commands → allPassed: true).
   */
  failIfAllSkipped?: boolean;
}

export interface RunValidationsResult {
  entries: ValidationEntry[];
  /**
   * True if all configured validations passed (or none were configured).
   * False if any validation failed.
   */
  allPassed: boolean;
}

/**
 * Run a sequence of configured validation commands and return ValidationEntry results.
 *
 * Semantics:
 * - Empty commands array → returns a single 'skipped' entry with status 'skipped'.
 * - Commands run sequentially; stops at first failure.
 * - Success is determined by exit code membership in successExitCodes (default [0]).
 * - Never throws on command failure — failure is represented as ValidationEntry with status 'fail'.
 */
export async function runValidations(
  opts: RunValidationsOptions,
): Promise<RunValidationsResult> {
  const { runner, cwd, commands, successExitCodes = [0], failIfAllSkipped = false } = opts;

  if (commands.length === 0) {
    if (failIfAllSkipped) {
      return {
        entries: [
          {
            name: "validation",
            status: "skipped",
            detail:
              "No validation commands configured — skipped (caller requires at least one passing validation)",
          },
        ],
        allPassed: false,
      };
    }
    return {
      entries: [
        {
          name: "validation",
          status: "skipped",
          detail: "No validation commands configured",
        },
      ],
      allPassed: true,
    };
  }

  const entries: ValidationEntry[] = [];

  for (const cmd of commands) {
    logger.info(`Running validation: ${cmd.name} — ${cmd.command}`);
    const result = await runner.run(cmd.command, {
      cwd,
      stream: true,
      ...(cmd.timeout_seconds !== undefined
        ? { timeout: cmd.timeout_seconds * 1000 }
        : {}),
    });

    const passed = successExitCodes.includes(result.exitCode);

    if (passed) {
      const detail =
        result.stdout.trim().split("\n").slice(-2).join(" ") || "Passed";
      entries.push({ name: cmd.name, status: "pass", detail });
    } else {
      const detail =
        result.stdout || result.stderr || `Exited with code ${result.exitCode}`;
      entries.push({ name: cmd.name, status: "fail", detail });
      // Stop on first failure — emit detailed diagnostics before caller reverts
      logger.error(`Validation "${cmd.name}" failed (exit ${result.exitCode})`);
      logger.error(`  Command : ${cmd.command}`);
      if (result.stdout.trim()) {
        const truncated = result.stdout
          .trim()
          .split("\n")
          .slice(-50)
          .join("\n");
        logger.error(`  stdout  :\n${truncated}`);
      }
      if (result.stderr.trim()) {
        const truncated = result.stderr
          .trim()
          .split("\n")
          .slice(-50)
          .join("\n");
        logger.error(`  stderr  :\n${truncated}`);
      }
      logger.error(`  exit    : ${result.exitCode}`);
      return { entries, allPassed: false };
    }
  }

  return { entries, allPassed: true };
}
