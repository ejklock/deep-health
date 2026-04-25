import type { CommandRunner } from '@core/types/common';
import { logger } from '@infra/utils/logger';

export interface CreateBranchResult {
  branch: string;
  committed: boolean;
}

/**
 * Create a new git branch, run a callback (the fix pipeline), and commit on success.
 *
 * Contract:
 * - Creates the branch BEFORE any mutation.
 * - Runs `fn()` (the fix pipeline).
 * - If fn() succeeds: stages all changes and creates a commit.
 * - If fn() throws: checks out originalBranch, re-throws so the caller sees the error.
 * - Always uses runArgs — never runner.run('git ' + ...) — branch names are external data.
 *
 * @param runner        CommandRunner to use for all git operations.
 * @param cwd           Working directory (project root).
 * @param originalBranch Branch to return to on failure (from detectGitBranch).
 * @param branchName    Name of the new branch to create.
 * @param commitMessage Commit message.
 * @param fn            Async callback that performs the fix pipeline. Must throw on failure.
 */
export async function createBranchAndCommit(
  runner: CommandRunner,
  cwd: string,
  originalBranch: string | null,
  branchName: string,
  commitMessage: string,
  fn: () => Promise<void>,
): Promise<CreateBranchResult> {
  // Create the new branch
  const checkoutResult = await runner.runArgs('git', ['checkout', '-b', branchName], { cwd });
  if (checkoutResult.exitCode !== 0) {
    throw new Error(
      `Failed to create branch "${branchName}": ${checkoutResult.stderr || checkoutResult.stdout}`,
    );
  }
  logger.info(`Created branch: ${branchName}`);

  try {
    await fn();
  } catch (err) {
    // Pipeline failed — roll back to original branch
    logger.warn(`Fix pipeline failed — rolling back to ${originalBranch ?? 'previous state'}`);
    if (originalBranch) {
      await runner.runArgs('git', ['checkout', originalBranch], { cwd });
    }
    throw err;
  }

  // Pipeline succeeded — stage and commit
  await runner.runArgs('git', ['add', '-A'], { cwd });
  const commitResult = await runner.runArgs('git', ['commit', '-m', commitMessage], { cwd });

  if (commitResult.exitCode !== 0) {
    // Possibly nothing to commit (no changes made by fix)
    const msg = (commitResult.stdout + commitResult.stderr).toLowerCase();
    if (msg.includes('nothing to commit') || msg.includes('nothing added to commit')) {
      logger.info('No changes to commit after fix — working tree is clean.');
      return { branch: branchName, committed: false };
    }
    throw new Error(`git commit failed: ${commitResult.stderr || commitResult.stdout}`);
  }

  logger.info(`Committed changes on branch: ${branchName}`);
  return { branch: branchName, committed: true };
}

/**
 * Generate a branch name from a prefix and the current timestamp.
 * Timestamp uses ISO format with colons replaced by hyphens for filesystem safety.
 *
 * Example: 'fix/deep-health-' → 'fix/deep-health-2026-04-25T23-20-00'
 */
export function buildBranchName(prefix: string): string {
  const ts = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
  return `${prefix}${ts}`;
}
