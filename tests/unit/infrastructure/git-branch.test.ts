import { describe, it, expect, vi } from 'vitest';
import { detectGitBranch } from '@infra/utils/git-branch';
import type { CommandRunner, CommandResult, CommandRunnerOptions, ExecutionEnv } from '@core/types/common';

// ─── Mock CommandRunner ──────────────────────────────────────────────────────

class MockRunner implements CommandRunner {
  readonly dryRun = false;
  readonly environment: ExecutionEnv = 'local';
  readonly calledCommands: string[] = [];
  private responses: Map<string, Partial<CommandResult>>;

  constructor(responses: Record<string, Partial<CommandResult>> = {}) {
    this.responses = new Map(Object.entries(responses));
  }

  async run(command: string, _opts?: CommandRunnerOptions): Promise<CommandResult> {
    this.calledCommands.push(command);
    for (const [key, resp] of this.responses) {
      if (command.includes(key)) {
        return {
          stdout: resp.stdout ?? '',
          stderr: resp.stderr ?? '',
          exitCode: resp.exitCode ?? 0,
          command,
          dryRun: false,
        };
      }
    }
    return { stdout: '', stderr: '', exitCode: 0, command, dryRun: false };
  }
}

/** A runner that always throws on run() */
class ThrowingRunner implements CommandRunner {
  readonly dryRun = false;
  readonly environment: ExecutionEnv = 'local';

  async run(_command: string, _opts?: CommandRunnerOptions): Promise<CommandResult> {
    throw new Error('runner.run() threw unexpectedly');
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('detectGitBranch()', () => {
  describe('happy path — branch detected', () => {
    it('returns the branch name when git outputs a non-HEAD branch', async () => {
      const runner = new MockRunner({
        'git rev-parse': { exitCode: 0, stdout: 'main\n' },
      });
      const result = await detectGitBranch('/project', runner);
      expect(result).toBe('main');
    });

    it('trims trailing whitespace/newlines from the branch name', async () => {
      const runner = new MockRunner({
        'git rev-parse': { exitCode: 0, stdout: '  feature/my-feature  \n' },
      });
      const result = await detectGitBranch('/project', runner);
      expect(result).toBe('feature/my-feature');
    });

    it('returns branch name with slashes (e.g. feature/foo)', async () => {
      const runner = new MockRunner({
        'git rev-parse': { exitCode: 0, stdout: 'feature/JIRA-123-add-thing\n' },
      });
      const result = await detectGitBranch('/project', runner);
      expect(result).toBe('feature/JIRA-123-add-thing');
    });

    it('returns develop branch name', async () => {
      const runner = new MockRunner({
        'git rev-parse': { exitCode: 0, stdout: 'develop\n' },
      });
      const result = await detectGitBranch('/project', runner);
      expect(result).toBe('develop');
    });
  });

  describe('null cases — branch not meaningful', () => {
    it('returns null when git outputs "HEAD" (detached HEAD state)', async () => {
      const runner = new MockRunner({
        'git rev-parse': { exitCode: 0, stdout: 'HEAD\n' },
      });
      const result = await detectGitBranch('/project', runner);
      expect(result).toBeNull();
    });

    it('returns null when git exits with non-zero (not a git repo)', async () => {
      const runner = new MockRunner({
        'git rev-parse': { exitCode: 128, stderr: 'fatal: not a git repository' },
      });
      const result = await detectGitBranch('/project', runner);
      expect(result).toBeNull();
    });

    it('returns null when git outputs empty string', async () => {
      const runner = new MockRunner({
        'git rev-parse': { exitCode: 0, stdout: '' },
      });
      const result = await detectGitBranch('/project', runner);
      expect(result).toBeNull();
    });

    it('returns null when git outputs only whitespace', async () => {
      const runner = new MockRunner({
        'git rev-parse': { exitCode: 0, stdout: '   \n' },
      });
      const result = await detectGitBranch('/project', runner);
      expect(result).toBeNull();
    });
  });

  describe('never throws', () => {
    it('returns null (does not throw) when the runner throws', async () => {
      const runner = new ThrowingRunner();
      // Must not throw — must return null
      await expect(detectGitBranch('/project', runner)).resolves.toBeNull();
    });

    it('returns null (does not throw) when runner.run rejects with an error', async () => {
      const runner = {
        dryRun: false,
        environment: 'local' as ExecutionEnv,
        run: vi.fn().mockRejectedValue(new Error('permission denied')),
      } satisfies CommandRunner;

      await expect(detectGitBranch('/project', runner)).resolves.toBeNull();
    });
  });

  describe('command used', () => {
    it('calls git rev-parse --abbrev-ref HEAD', async () => {
      const runner = new MockRunner({
        'git rev-parse': { exitCode: 0, stdout: 'main\n' },
      });
      await detectGitBranch('/project', runner);
      expect(runner.calledCommands).toContain('git rev-parse --abbrev-ref HEAD');
    });
  });
});
