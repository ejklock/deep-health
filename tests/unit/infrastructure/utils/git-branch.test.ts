/**
 * Branch coverage top-up for src/infrastructure/utils/git-branch.ts
 * Targets:
 *   line 54: catch branch — runner.runArgs throws an error
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@infra/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), phase: vi.fn(), skip: vi.fn(), header: vi.fn() },
}));

import { detectGitBranch } from '@infra/utils/git-branch';
import type { CommandRunner } from '@core/types/common';

function makeRunner(impl: () => Promise<any>): CommandRunner {
  return {
    run: vi.fn(),
    runArgs: vi.fn().mockImplementation(impl),
    dryRun: false,
    environment: 'local' as const,
  };
}

describe('detectGitBranch() — error branches', () => {
  it('returns null and logs when runner.runArgs throws (line 52-56)', async () => {
    const runner = makeRunner(() => Promise.reject(new Error('git not found')));
    const result = await detectGitBranch('/cwd', runner);
    expect(result).toBeNull();
  });

  it('returns null and logs when runner.runArgs throws a non-Error', async () => {
    const runner = makeRunner(() => Promise.reject('string error'));
    const result = await detectGitBranch('/cwd', runner);
    expect(result).toBeNull();
  });

  it('returns null when exit code is non-zero (line 33-38)', async () => {
    const runner = makeRunner(() => Promise.resolve({ stdout: '', stderr: 'not a repo', exitCode: 128, command: 'git', dryRun: false }));
    const result = await detectGitBranch('/cwd', runner);
    expect(result).toBeNull();
  });

  it('returns null for detached HEAD output (line 42-48)', async () => {
    const runner = makeRunner(() => Promise.resolve({ stdout: 'HEAD', stderr: '', exitCode: 0, command: 'git', dryRun: false }));
    const result = await detectGitBranch('/cwd', runner);
    expect(result).toBeNull();
  });

  it('returns the branch name on success (line 50-51)', async () => {
    const runner = makeRunner(() => Promise.resolve({ stdout: 'main', stderr: '', exitCode: 0, command: 'git', dryRun: false }));
    const result = await detectGitBranch('/cwd', runner);
    expect(result).toBe('main');
  });
});
