/**
 * Tests for resolve-build-context-boundary.
 *
 * Covers:
 *  - resolveAllowedBuildContextRoot: git root detection, fallback to projectDir,
 *    stdout trimming, and module-level caching behaviour
 *  - assertBuildContextWithinBoundary: inside/outside boundary logic, allowEscape
 *    flag, boundary-source label in error messages, and symlink resolution via
 *    real temp directories (fs.realpath is NOT mocked)
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';

// ── Mock child_process ─────────────────────────────────────────────────────────

vi.mock('node:child_process', () => {
  const execFileMock = vi.fn();
  return { execFile: execFileMock };
});

// ── Mock util.promisify to return controllable async versions ──────────────────

vi.mock('node:util', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:util')>();
  return {
    ...original,
    promisify: (fn: unknown) => (...args: unknown[]) => (fn as Mock)(...args),
  };
});

vi.mock('@infra/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), phase: vi.fn(), skip: vi.fn(), header: vi.fn() },
}));

import { execFile } from 'node:child_process';
import {
  resolveAllowedBuildContextRoot,
  assertBuildContextWithinBoundary,
  _testOnlyCacheMap,
} from '@infra/ecosystem-runtime/resolve-build-context-boundary';
import { logger } from '@infra/utils/logger';

const mockExecFile = vi.mocked(execFile);

// ─────────────────────────────────────────────────────────────────────────────
// resolveAllowedBuildContextRoot
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveAllowedBuildContextRoot', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    _testOnlyCacheMap.clear();
  });

  it('returns git root with source "git" when git rev-parse succeeds', async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: '/repo\n', stderr: '' } as any);

    const result = await resolveAllowedBuildContextRoot('/some/project');

    expect(result).toEqual({ root: '/repo', source: 'git' });
  });

  it('falls back to projectDir with source "project-dir" when execFile rejects with ENOENT', async () => {
    const err = Object.assign(new Error('git not found'), { code: 'ENOENT' });
    mockExecFile.mockRejectedValueOnce(err);

    const result = await resolveAllowedBuildContextRoot('/some/project');

    expect(result).toEqual({ root: '/some/project', source: 'project-dir' });
  });

  it('falls back to projectDir with source "project-dir" on non-zero exit', async () => {
    const err = Object.assign(new Error('not a git repo'), { code: 128 });
    mockExecFile.mockRejectedValueOnce(err);

    const result = await resolveAllowedBuildContextRoot('/some/project');

    expect(result).toEqual({ root: '/some/project', source: 'project-dir' });
  });

  it('trims surrounding whitespace from stdout', async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: '  /repo  \n', stderr: '' } as any);

    const result = await resolveAllowedBuildContextRoot('/some/project');

    expect(result.root).toBe('/repo');
  });

  it('calls execFile only once for the same projectDir (cache hit)', async () => {
    mockExecFile.mockResolvedValue({ stdout: '/repo\n', stderr: '' } as any);

    await resolveAllowedBuildContextRoot('/cached/dir');
    await resolveAllowedBuildContextRoot('/cached/dir');

    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('caches different projectDirs independently (two separate subprocess calls)', async () => {
    mockExecFile
      .mockResolvedValueOnce({ stdout: '/repo-a\n', stderr: '' } as any)
      .mockResolvedValueOnce({ stdout: '/repo-b\n', stderr: '' } as any);

    const a = await resolveAllowedBuildContextRoot('/dir-a');
    const b = await resolveAllowedBuildContextRoot('/dir-b');

    expect(a).toEqual({ root: '/repo-a', source: 'git' });
    expect(b).toEqual({ root: '/repo-b', source: 'git' });
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// assertBuildContextWithinBoundary
// (uses real temp directories — fs.realpath is NOT mocked)
// ─────────────────────────────────────────────────────────────────────────────

describe('assertBuildContextWithinBoundary', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.mocked(logger.warn).mockReset();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'build-ctx-boundary-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ── Inside boundary ────────────────────────────────────────────────────────

  it('resolves silently when contextDir equals allowedRoot', async () => {
    await expect(
      assertBuildContextWithinBoundary({
        contextDir: tmpDir,
        allowedRoot: tmpDir,
        boundarySource: 'git',
        logPrefix: 'npm',
      }),
    ).resolves.toBeUndefined();
  });

  it('resolves silently when contextDir is a direct subdirectory of allowedRoot', async () => {
    const subDir = path.join(tmpDir, 'sub');
    await fs.mkdir(subDir);

    await expect(
      assertBuildContextWithinBoundary({
        contextDir: subDir,
        allowedRoot: tmpDir,
        boundarySource: 'git',
        logPrefix: 'npm',
      }),
    ).resolves.toBeUndefined();
  });

  it('resolves silently when contextDir is deeply nested inside allowedRoot', async () => {
    const deepDir = path.join(tmpDir, 'a', 'b', 'c');
    await fs.mkdir(deepDir, { recursive: true });

    await expect(
      assertBuildContextWithinBoundary({
        contextDir: deepDir,
        allowedRoot: tmpDir,
        boundarySource: 'git',
        logPrefix: 'npm',
      }),
    ).resolves.toBeUndefined();
  });

  // ── Outside boundary — no escape ───────────────────────────────────────────

  it('throws when contextDir is outside allowedRoot and allowEscape is not set', async () => {
    const innerDir = path.join(tmpDir, 'inner');
    await fs.mkdir(innerDir);

    // allowedRoot = inner, contextDir = parent (outside)
    await expect(
      assertBuildContextWithinBoundary({
        contextDir: tmpDir,
        allowedRoot: innerDir,
        boundarySource: 'git',
        logPrefix: 'npm',
      }),
    ).rejects.toThrow();
  });

  it('throws when contextDir is outside allowedRoot and allowEscape is explicitly false', async () => {
    const innerDir = path.join(tmpDir, 'inner');
    await fs.mkdir(innerDir);

    await expect(
      assertBuildContextWithinBoundary({
        contextDir: tmpDir,
        allowedRoot: innerDir,
        boundarySource: 'git',
        logPrefix: 'npm',
        allowEscape: false,
      }),
    ).rejects.toThrow();
  });

  // ── Outside boundary — escape allowed ─────────────────────────────────────

  it('does not throw and calls logger.warn when contextDir is outside and allowEscape is true', async () => {
    const innerDir = path.join(tmpDir, 'inner');
    await fs.mkdir(innerDir);

    await expect(
      assertBuildContextWithinBoundary({
        contextDir: tmpDir,
        allowedRoot: innerDir,
        boundarySource: 'git',
        logPrefix: 'npm',
        allowEscape: true,
      }),
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  // ── Error message contents ─────────────────────────────────────────────────

  it('error message contains "git root" when boundarySource is "git"', async () => {
    const innerDir = path.join(tmpDir, 'inner');
    await fs.mkdir(innerDir);

    await expect(
      assertBuildContextWithinBoundary({
        contextDir: tmpDir,
        allowedRoot: innerDir,
        boundarySource: 'git',
        logPrefix: 'npm',
      }),
    ).rejects.toThrow(/git root/);
  });

  it('error message contains "project directory" when boundarySource is "project-dir"', async () => {
    const innerDir = path.join(tmpDir, 'inner');
    await fs.mkdir(innerDir);

    await expect(
      assertBuildContextWithinBoundary({
        contextDir: tmpDir,
        allowedRoot: innerDir,
        boundarySource: 'project-dir',
        logPrefix: 'npm',
      }),
    ).rejects.toThrow(/project directory/);
  });

  it('error message contains "allow_build_context_escape" hint when outside and no escape', async () => {
    const innerDir = path.join(tmpDir, 'inner');
    await fs.mkdir(innerDir);

    await expect(
      assertBuildContextWithinBoundary({
        contextDir: tmpDir,
        allowedRoot: innerDir,
        boundarySource: 'git',
        logPrefix: 'npm',
      }),
    ).rejects.toThrow(/allow_build_context_escape/);
  });

  it('error message contains both contextDir and allowedRoot paths', async () => {
    const innerDir = path.join(tmpDir, 'inner');
    await fs.mkdir(innerDir);

    let caughtMessage = '';
    try {
      await assertBuildContextWithinBoundary({
        contextDir: tmpDir,
        allowedRoot: innerDir,
        boundarySource: 'git',
        logPrefix: 'npm',
      });
    } catch (err: unknown) {
      caughtMessage = (err as Error).message;
    }

    expect(caughtMessage).toContain(tmpDir);
    expect(caughtMessage).toContain(innerDir);
  });

  // ── Warning message contents ───────────────────────────────────────────────

  it('warning message contains both paths when outside and allowEscape is true', async () => {
    const innerDir = path.join(tmpDir, 'inner');
    await fs.mkdir(innerDir);

    await assertBuildContextWithinBoundary({
      contextDir: tmpDir,
      allowedRoot: innerDir,
      boundarySource: 'git',
      logPrefix: 'npm',
      allowEscape: true,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(tmpDir),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(innerDir),
    );
  });

  it('warning message contains "allow_build_context_escape: false" when allowEscape is true', async () => {
    const innerDir = path.join(tmpDir, 'inner');
    await fs.mkdir(innerDir);

    await assertBuildContextWithinBoundary({
      contextDir: tmpDir,
      allowedRoot: innerDir,
      boundarySource: 'git',
      logPrefix: 'npm',
      allowEscape: true,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('allow_build_context_escape: false'),
    );
  });

  // ── Symlink resolution ─────────────────────────────────────────────────────

  it('throws when contextDir is a symlink inside allowedRoot that resolves outside (symlink escape)', async () => {
    // Structure: tmpDir/inner/ is the boundary; tmpDir/inner/link -> tmpDir (outside)
    const innerDir = path.join(tmpDir, 'inner');
    await fs.mkdir(innerDir);

    const symlinkPath = path.join(innerDir, 'escape-link');
    await fs.symlink(tmpDir, symlinkPath);

    // symlinkPath appears to be inside innerDir, but realpath resolves to tmpDir (outside)
    await expect(
      assertBuildContextWithinBoundary({
        contextDir: symlinkPath,
        allowedRoot: innerDir,
        boundarySource: 'project-dir',
        logPrefix: 'npm',
      }),
    ).rejects.toThrow(/allow_build_context_escape/);
  });
});
