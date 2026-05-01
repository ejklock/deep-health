import type { CommandRunner } from '@core/types/common';
import { logger } from '@infra/utils/logger';

export interface CreateBranchResult {
  branch: string;
  committed: boolean;
  exitCode: number;
}

/**
 * Create a new git branch, run a callback (the fix pipeline), and commit on success.
 *
 * Contract:
 * - Creates the branch BEFORE any mutation.
 * - Runs `fn()` (the fix pipeline).
 * - If fn() returns 0: stages all changes and creates a commit; returns { branch, committed, exitCode: 0 }.
 * - If fn() returns non-zero: rolls back (checkout originalBranch, branch -D); returns { branch, committed: false, exitCode: N } without throwing.
 * - If fn() throws: checks out originalBranch, re-throws so the caller sees the error.
 * - Always uses runArgs — never runner.run('git ' + ...) — branch names are external data.
 *
 * @param runner        CommandRunner to use for all git operations.
 * @param cwd           Working directory (project root).
 * @param originalBranch Branch to return to on failure (from detectGitBranch).
 * @param branchName    Name of the new branch to create.
 * @param commitMessage Commit message.
 * @param fn            Async callback that performs the fix pipeline. Returns an exit code (0 = success).
 */
export async function createBranchAndCommit(
  runner: CommandRunner,
  cwd: string,
  originalBranch: string | null,
  branchName: string,
  commitMessage: string,
  fn: () => Promise<number>,
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
    const exitCode = await fn();
    if (exitCode !== 0) {
      // Pipeline ran but returned a non-zero code — rollback without throwing
      logger.warn(`Fix pipeline returned exit code ${exitCode} — rolling back to ${originalBranch ?? 'previous state'}`);
      if (originalBranch) {
        await runner.runArgs('git', ['checkout', originalBranch], { cwd });
        const deleteResult = await runner.runArgs('git', ['branch', '-D', branchName], { cwd });
        if (deleteResult.exitCode === 0) {
          logger.info(`Deleted empty branch: ${branchName}`);
        } else {
          logger.warn(`Could not delete branch ${branchName}: ${deleteResult.stderr || deleteResult.stdout}`);
        }
      }
      return { branch: branchName, committed: false, exitCode };
    }
  } catch (err) {
    // Pipeline failed — switch back to original branch and delete the empty fix branch
    logger.warn(`Fix pipeline failed — rolling back to ${originalBranch ?? 'previous state'}`);
    if (originalBranch) {
      await runner.runArgs('git', ['checkout', originalBranch], { cwd });
      // Delete the fix branch; it has no commits so force-delete is safe
      const deleteResult = await runner.runArgs('git', ['branch', '-D', branchName], { cwd });
      if (deleteResult.exitCode === 0) {
        logger.info(`Deleted empty branch: ${branchName}`);
      } else {
        logger.warn(`Could not delete branch ${branchName}: ${deleteResult.stderr || deleteResult.stdout}`);
      }
    }
    throw err;
  }

  // Pipeline succeeded (exitCode === 0) — stage and commit
  await runner.runArgs('git', ['add', '-A'], { cwd });
  const commitResult = await runner.runArgs('git', ['commit', '-m', commitMessage], { cwd });

  if (commitResult.exitCode !== 0) {
    // Possibly nothing to commit (no changes made by fix)
    const msg = (commitResult.stdout + commitResult.stderr).toLowerCase();
    if (msg.includes('nothing to commit') || msg.includes('nothing added to commit')) {
      logger.info('No changes to commit after fix — working tree is clean.');
      return { branch: branchName, committed: false, exitCode: 0 };
    }
    throw new Error(`git commit failed: ${commitResult.stderr || commitResult.stdout}`);
  }

  logger.info(`Committed changes on branch: ${branchName}`);
  return { branch: branchName, committed: true, exitCode: 0 };
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
