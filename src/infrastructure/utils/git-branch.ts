import type { CommandRunner } from '@core/types/common';
import { logger } from '@infra/utils/logger';

/**
 * Detect the current git branch name.
 *
 * Uses `git rev-parse --abbrev-ref HEAD` which outputs the branch name on normal
 * branches, or the literal string "HEAD" when the repo is in detached HEAD state
 * (common in CI after a checkout-by-SHA).
 *
 * Return contract:
 * - Returns the branch name string when it is available and meaningful.
 * - Returns `null` when:
 *   - The command fails (not a git repo, git not installed, etc.)
 *   - The output is "HEAD" (detached HEAD — branch name is not meaningful)
 *   - The output is empty
 *
 * This function never throws. All errors are swallowed and logged at debug level.
 * Callers may always treat `null` as "branch unknown / not applicable".
 *
 * @param cwd    Working directory to run the git command in.
 * @param runner CommandRunner to use for execution.
 * @returns Branch name string or null.
 */
export async function detectGitBranch(
  cwd: string,
  runner: CommandRunner,
): Promise<string | null> {
  try {
    const result = await runner.run('git rev-parse --abbrev-ref HEAD', { cwd });

    if (result.exitCode !== 0) {
      logger.debug(
        `git-branch: git rev-parse failed (exit ${result.exitCode}) — branch detection skipped`,
      );
      return null;
    }

    const branch = result.stdout.trim();

    if (!branch || branch === 'HEAD') {
      // Empty output or detached HEAD — branch name is not meaningful
      logger.debug(
        `git-branch: detected "${branch || '(empty)'}" — treating as no branch (detached HEAD or empty)`,
      );
      return null;
    }

    logger.debug(`git-branch: detected branch "${branch}"`);
    return branch;
  } catch (err) {
    logger.debug(
      `git-branch: detection failed — ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
