/**
 * Tests for buildProjectImage — project-owned Dockerfile → stable local Docker image.
 *
 * All Docker operations are mocked via vi.mock('node:child_process') so no real
 * Docker daemon is required. Tests focus on:
 *  - Cache hit (docker image inspect succeeds → build skipped)
 *  - Cache miss (docker image inspect fails → docker build is run)
 *  - Cache invalidation (Dockerfile content changes → new tag → docker build runs again)
 *  - Binary presence probing (success + missing binary error path)
 *  - Dockerfile not found error
 *  - docker build failure error
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';

// ── Mock child_process ─────────────────────────────────────────────────────────

vi.mock('node:child_process', () => {
  const execFileMock = vi.fn();
  const execFileSyncMock = vi.fn();
  return {
    execFile: execFileMock,
    execFileSync: execFileSyncMock,
  };
});

// ── Mock util.promisify to return controllable async versions ──────────────────

vi.mock('node:util', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:util')>();
  return {
    ...original,
    promisify: (fn: unknown) => {
      // Return a mock function that delegates to the mock — not the real fn
      return (...args: unknown[]) => (fn as Mock)(...args);
    },
  };
});

vi.mock('@infra/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), phase: vi.fn(), skip: vi.fn(), header: vi.fn(), tagged: vi.fn() },
}));

vi.mock('@infra/ecosystem-runtime/resolve-build-context-boundary', () => ({
  resolveAllowedBuildContextRoot: vi.fn().mockResolvedValue({ root: '', source: 'project-dir' }),
  assertBuildContextWithinBoundary: vi.fn().mockResolvedValue(undefined),
}));

import { execFile } from 'node:child_process';
import { buildProjectImage } from '@infra/ecosystem-runtime/build-project-image';
import {
  resolveAllowedBuildContextRoot,
  assertBuildContextWithinBoundary,
} from '@infra/ecosystem-runtime/resolve-build-context-boundary';

const mockExecFile = vi.mocked(execFile);
const mockResolveRoot = vi.mocked(resolveAllowedBuildContextRoot);
const mockAssertBoundary = vi.mocked(assertBuildContextWithinBoundary);

/** Resolve the stable image tag the way buildProjectImage does: sha256 of file contents. */
async function stableTag(contents: string, logPrefix: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  const sha256 = createHash('sha256').update(contents).digest('hex');
  return `deep-health-project/${logPrefix}:${sha256.slice(0, 12)}`;
}

describe('buildProjectImage', () => {
  let tmpDir: string;

  beforeEach(async () => {
    mockExecFile.mockReset();
    mockResolveRoot.mockResolvedValue({ root: '', source: 'project-dir' });
    mockAssertBoundary.mockResolvedValue(undefined);
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'build-project-image-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. Dockerfile not found
  // ─────────────────────────────────────────────────────────────────────────────

  it('throws a descriptive error when the Dockerfile is missing', async () => {
    await expect(
      buildProjectImage({
        projectDir: tmpDir,
        dockerfilePath: 'Nonexistent.Dockerfile',
        logPrefix: 'npm',
      }),
    ).rejects.toThrow(/Dockerfile not found at/);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Cache hit — build is skipped
  // ─────────────────────────────────────────────────────────────────────────────

  it('returns cached image tag without rebuilding when the tag already exists locally', async () => {
    const dockerfileContents = 'FROM node:20\nRUN npm install -g npm@latest\n';
    await fs.writeFile(path.join(tmpDir, 'Dockerfile'), dockerfileContents);

    const expectedImage = await stableTag(dockerfileContents, 'npm');

    // Simulate: docker image inspect exits 0 (cache hit)
    mockExecFile.mockResolvedValueOnce({ stdout: '[]', stderr: '' } as any);

    const result = await buildProjectImage({
      projectDir: tmpDir,
      dockerfilePath: 'Dockerfile',
      logPrefix: 'npm',
    });

    expect(result.image).toBe(expectedImage);
    expect(result.entrypointOverride).toBe('');
    // Only 1 execFile call: docker image inspect; docker build was NOT called
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(mockExecFile).toHaveBeenCalledWith('docker', ['image', 'inspect', expectedImage]);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. Cache miss — build is triggered
  // ─────────────────────────────────────────────────────────────────────────────

  it('builds the image when the tag does not exist locally', async () => {
    const dockerfileContents = 'FROM python:3.11-slim\n';
    await fs.writeFile(path.join(tmpDir, 'Dockerfile'), dockerfileContents);

    const expectedImage = await stableTag(dockerfileContents, 'pip');

    // docker image inspect fails → cache miss
    mockExecFile.mockRejectedValueOnce(new Error('No such image'));
    // du -sk for warnIfLargeContext
    mockExecFile.mockResolvedValueOnce({ stdout: '100\t/tmp', stderr: '' } as any);
    // docker build succeeds
    mockExecFile.mockResolvedValueOnce({ stdout: '', stderr: '' } as any);

    const result = await buildProjectImage({
      projectDir: tmpDir,
      dockerfilePath: 'Dockerfile',
      logPrefix: 'pip',
    });

    expect(result.image).toBe(expectedImage);
    expect(result.entrypointOverride).toBe('');

    const calls = mockExecFile.mock.calls;
    const buildCall = calls.find((c) => c[0] === 'docker' && Array.isArray(c[1]) && c[1].includes('build'));
    expect(buildCall).toBeDefined();
    expect(buildCall?.[1]).toContain('--tag');
    expect(buildCall?.[1]).toContain(expectedImage);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. Cache invalidation — different Dockerfile content → different tag
  // ─────────────────────────────────────────────────────────────────────────────

  it('derives a new image tag when Dockerfile content changes (invalidating the old tag)', async () => {
    const v1 = 'FROM node:20\n';
    const v2 = 'FROM node:22\n';

    const tag1 = await stableTag(v1, 'npm');
    const tag2 = await stableTag(v2, 'npm');

    expect(tag1).not.toBe(tag2);

    // v1 build: inspect fails → build succeeds
    await fs.writeFile(path.join(tmpDir, 'Dockerfile'), v1);
    mockExecFile
      .mockRejectedValueOnce(new Error('No such image'))  // inspect miss
      .mockResolvedValueOnce({ stdout: '100\t/tmp', stderr: '' } as any)  // du
      .mockResolvedValueOnce({ stdout: '', stderr: '' } as any);  // build

    const r1 = await buildProjectImage({ projectDir: tmpDir, dockerfilePath: 'Dockerfile', logPrefix: 'npm' });
    expect(r1.image).toBe(tag1);

    // Update Dockerfile to v2
    await fs.writeFile(path.join(tmpDir, 'Dockerfile'), v2);
    mockExecFile
      .mockRejectedValueOnce(new Error('No such image'))  // inspect miss for new tag
      .mockResolvedValueOnce({ stdout: '100\t/tmp', stderr: '' } as any)  // du
      .mockResolvedValueOnce({ stdout: '', stderr: '' } as any);  // build

    const r2 = await buildProjectImage({ projectDir: tmpDir, dockerfilePath: 'Dockerfile', logPrefix: 'npm' });
    expect(r2.image).toBe(tag2);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. docker build failure → throws
  // ─────────────────────────────────────────────────────────────────────────────

  it('throws a descriptive error when docker build fails', async () => {
    await fs.writeFile(path.join(tmpDir, 'Dockerfile'), 'FROM node:20\n');

    mockExecFile
      .mockRejectedValueOnce(new Error('No such image'))  // inspect miss
      .mockResolvedValueOnce({ stdout: '100\t/tmp', stderr: '' } as any)  // du
      .mockRejectedValueOnce(Object.assign(new Error('build failed'), { stderr: 'step 1/1: COPY fail' }));  // build

    await expect(
      buildProjectImage({ projectDir: tmpDir, dockerfilePath: 'Dockerfile', logPrefix: 'npm' }),
    ).rejects.toThrow(/docker build failed/);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. Binary presence probe — all binaries found
  // ─────────────────────────────────────────────────────────────────────────────

  it('returns successfully when all required binaries are present in the built image', async () => {
    const dockerfileContents = 'FROM node:20\n';
    await fs.writeFile(path.join(tmpDir, 'Dockerfile'), dockerfileContents);

    const expectedImage = await stableTag(dockerfileContents, 'npm');

    mockExecFile
      .mockRejectedValueOnce(new Error('No such image'))  // inspect miss
      .mockResolvedValueOnce({ stdout: '100\t/tmp', stderr: '' } as any)  // du
      .mockResolvedValueOnce({ stdout: '', stderr: '' } as any)  // docker build
      .mockResolvedValueOnce({ stdout: '/usr/local/bin/npm\n', stderr: '' } as any);  // which npm

    const result = await buildProjectImage({
      projectDir: tmpDir,
      dockerfilePath: 'Dockerfile',
      logPrefix: 'npm',
      requiredBinaries: ['npm'],
    });

    expect(result.image).toBe(expectedImage);

    // Verify that `which npm` was probed inside the image
    const probeCalls = mockExecFile.mock.calls.filter(
      (c) => c[0] === 'docker' && Array.isArray(c[1]) && c[1].includes('--entrypoint') && c[1].includes('which npm'),
    );
    expect(probeCalls.length).toBeGreaterThanOrEqual(1);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 7. Binary presence probe — binary missing → throws before returning tag
  // ─────────────────────────────────────────────────────────────────────────────

  it('throws an error listing missing binaries when a required binary is absent in the image', async () => {
    const dockerfileContents = 'FROM ubuntu:24.04\n';
    await fs.writeFile(path.join(tmpDir, 'Dockerfile'), dockerfileContents);

    mockExecFile
      .mockRejectedValueOnce(new Error('No such image'))  // inspect miss
      .mockResolvedValueOnce({ stdout: '100\t/tmp', stderr: '' } as any)  // du
      .mockResolvedValueOnce({ stdout: '', stderr: '' } as any)  // docker build
      .mockRejectedValueOnce(new Error('which: npm: not found'))  // which npm probe fails
      .mockResolvedValueOnce({ stdout: '/usr/bin/npx\n', stderr: '' } as any);  // which npx ok

    await expect(
      buildProjectImage({
        projectDir: tmpDir,
        dockerfilePath: 'Dockerfile',
        logPrefix: 'npm',
        requiredBinaries: ['npm', 'npx'],
      }),
    ).rejects.toThrow(/missing required.*binary.*npm/);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 8. No requiredBinaries — probe step is skipped entirely
  // ─────────────────────────────────────────────────────────────────────────────

  it('skips binary probing when requiredBinaries is not provided', async () => {
    const dockerfileContents = 'FROM node:20\n';
    await fs.writeFile(path.join(tmpDir, 'Dockerfile'), dockerfileContents);

    mockExecFile
      .mockRejectedValueOnce(new Error('No such image'))  // inspect miss
      .mockResolvedValueOnce({ stdout: '100\t/tmp', stderr: '' } as any)  // du
      .mockResolvedValueOnce({ stdout: '', stderr: '' } as any);  // docker build

    const result = await buildProjectImage({
      projectDir: tmpDir,
      dockerfilePath: 'Dockerfile',
      logPrefix: 'npm',
      // requiredBinaries deliberately omitted
    });

    expect(result.image).toBeDefined();
    // Exactly 3 calls: inspect, du, build; no probe calls
    expect(mockExecFile).toHaveBeenCalledTimes(3);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 9. buildContext — Dockerfile resolved relative to context dir, not projectDir
  // ─────────────────────────────────────────────────────────────────────────────

  it('resolves Dockerfile relative to buildContext when buildContext is set', async () => {
    // Simulate structure: projectDir = tmpDir, buildContext = docker/ (in-bounds subdirectory)
    const projectDir = tmpDir;
    const dockerSubdir = path.join(tmpDir, 'docker');
    await fs.mkdir(dockerSubdir, { recursive: true });

    const dockerfileContents = 'FROM node:20\n';
    // Dockerfile lives inside the docker/ subdirectory
    await fs.writeFile(path.join(dockerSubdir, 'Dockerfile'), dockerfileContents);

    const expectedImage = await stableTag(dockerfileContents, 'npm');

    // Cache miss → build
    mockExecFile
      .mockRejectedValueOnce(new Error('No such image'))
      .mockResolvedValueOnce({ stdout: '100\t/tmp', stderr: '' } as any)
      .mockResolvedValueOnce({ stdout: '', stderr: '' } as any);

    const result = await buildProjectImage({
      projectDir,
      dockerfilePath: 'Dockerfile',
      logPrefix: 'npm',
      buildContext: 'docker',
    });

    expect(result.image).toBe(expectedImage);

    const buildCall = mockExecFile.mock.calls.find(
      (c) => c[0] === 'docker' && Array.isArray(c[1]) && c[1].includes('build'),
    );
    expect(buildCall).toBeDefined();
    const args = buildCall![1] as string[];
    // Context dir should be the resolved docker/ subdirectory
    const contextArg = args[args.length - 1];
    expect(contextArg).toBe(dockerSubdir);
    // Dockerfile should be resolved to docker/Dockerfile
    const fileIdx = args.indexOf('--file');
    expect(args[fileIdx + 1]).toBe(path.join(dockerSubdir, 'Dockerfile'));
  });

  it('passes --build-arg entries to docker build when buildArgs is set', async () => {
    await fs.writeFile(path.join(tmpDir, 'Dockerfile'), 'FROM node:20\n');

    mockExecFile
      .mockRejectedValueOnce(new Error('No such image'))
      .mockResolvedValueOnce({ stdout: '100\t/tmp', stderr: '' } as any)
      .mockResolvedValueOnce({ stdout: '', stderr: '' } as any);

    await buildProjectImage({
      projectDir: tmpDir,
      dockerfilePath: 'Dockerfile',
      logPrefix: 'npm',
      buildArgs: { NODE_VERSION: '20', APP_ENV: 'test' },
    });

    const buildCall = mockExecFile.mock.calls.find(
      (c) => c[0] === 'docker' && Array.isArray(c[1]) && c[1].includes('build'),
    );
    expect(buildCall).toBeDefined();
    const args = buildCall![1] as string[];
    expect(args).toContain('--build-arg');
    expect(args).toContain('NODE_VERSION=20');
    expect(args).toContain('APP_ENV=test');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 11. entrypointOverride is always "" (empty string) — not undefined
  // ─────────────────────────────────────────────────────────────────────────────

  it('always returns entrypointOverride as empty string ""', async () => {
    const dockerfileContents = 'FROM node:20\n';
    await fs.writeFile(path.join(tmpDir, 'Dockerfile'), dockerfileContents);

    // Cache hit path
    mockExecFile.mockResolvedValueOnce({ stdout: '[]', stderr: '' } as any);

    const result = await buildProjectImage({
      projectDir: tmpDir,
      dockerfilePath: 'Dockerfile',
      logPrefix: 'npm',
    });

    expect(result.entrypointOverride).toBe('');
    expect(typeof result.entrypointOverride).toBe('string');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 12. Binary probe on cache hit — binaries present → success
  // ─────────────────────────────────────────────────────────────────────────────

  it('probes binaries on cache hit and succeeds when all binaries are present', async () => {
    const dockerfileContents = 'FROM node:20\n';
    await fs.writeFile(path.join(tmpDir, 'Dockerfile'), dockerfileContents);
    const expectedImage = await stableTag(dockerfileContents, 'npm');

    // Simulate: docker image inspect exits 0 (cache hit)
    mockExecFile.mockResolvedValueOnce({ stdout: '[]', stderr: '' } as any);
    // which npm succeeds
    mockExecFile.mockResolvedValueOnce({ stdout: '/usr/local/bin/npm\n', stderr: '' } as any);

    const result = await buildProjectImage({
      projectDir: tmpDir,
      dockerfilePath: 'Dockerfile',
      logPrefix: 'npm',
      requiredBinaries: ['npm'],
    });

    expect(result.image).toBe(expectedImage);
    // 2 calls: docker image inspect (cache hit) + docker run which npm
    expect(mockExecFile).toHaveBeenCalledTimes(2);
    const probeCalls = mockExecFile.mock.calls.filter(
      (c) => c[0] === 'docker' && Array.isArray(c[1]) && c[1].includes('--entrypoint'),
    );
    expect(probeCalls.length).toBe(1);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 13. Binary probe on cache hit — binary missing → diagnostic error
  // ─────────────────────────────────────────────────────────────────────────────

  it('throws a diagnostic error when a required binary is missing in a cached image', async () => {
    const dockerfileContents = 'FROM ubuntu:24.04\n';
    await fs.writeFile(path.join(tmpDir, 'Dockerfile'), dockerfileContents);

    // Simulate: docker image inspect exits 0 (cache hit)
    mockExecFile.mockResolvedValueOnce({ stdout: '[]', stderr: '' } as any);
    // which composer fails (not installed in cached image)
    mockExecFile.mockRejectedValueOnce(new Error('which: composer: not found'));

    await expect(
      buildProjectImage({
        projectDir: tmpDir,
        dockerfilePath: 'Dockerfile',
        logPrefix: 'composer',
        requiredBinaries: ['composer'],
      }),
    ).rejects.toThrow(/missing required.*binary.*composer/);

    // Must have called: docker image inspect (cache hit) + docker run which composer
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 14. Security: absolute dockerfilePath is rejected
  // ─────────────────────────────────────────────────────────────────────────────

  it('throws when dockerfilePath is an absolute path', async () => {
    await expect(
      buildProjectImage({
        projectDir: tmpDir,
        dockerfilePath: '/etc/passwd',
        logPrefix: 'npm',
      }),
    ).rejects.toThrow(/absolute paths are rejected/);

    // No Docker calls should have been made
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Boundary enforcement tests
  // ─────────────────────────────────────────────────────────────────────────────

  it('calls assertBuildContextWithinBoundary with contextDir and git root when buildContext is set', async () => {
    const dockerSubdir = path.join(tmpDir, 'docker');
    await fs.mkdir(dockerSubdir, { recursive: true });
    await fs.writeFile(path.join(dockerSubdir, 'Dockerfile'), 'FROM node:20\n');

    const gitRoot = '/repo';
    mockResolveRoot.mockResolvedValue({ root: gitRoot, source: 'git' });

    // cache hit so we don't need extra mocks
    mockExecFile.mockResolvedValueOnce({ stdout: '[]', stderr: '' } as any);

    await buildProjectImage({
      projectDir: tmpDir,
      dockerfilePath: 'Dockerfile',
      logPrefix: 'npm',
      buildContext: 'docker',
    });

    expect(mockAssertBoundary).toHaveBeenCalledWith(
      expect.objectContaining({
        contextDir: dockerSubdir,
        allowedRoot: gitRoot,
        boundarySource: 'git',
        logPrefix: 'npm',
      }),
    );
  });

  it('forwards allowBuildContextEscape to assertBuildContextWithinBoundary', async () => {
    await fs.writeFile(path.join(tmpDir, 'Dockerfile'), 'FROM node:20\n');
    mockExecFile.mockResolvedValueOnce({ stdout: '[]', stderr: '' } as any);

    await buildProjectImage({
      projectDir: tmpDir,
      dockerfilePath: 'Dockerfile',
      logPrefix: 'composer',
      allowBuildContextEscape: true,
    });

    expect(mockAssertBoundary).toHaveBeenCalledWith(
      expect.objectContaining({ allowEscape: true }),
    );
  });

  it('propagates throw from assertBuildContextWithinBoundary', async () => {
    await fs.writeFile(path.join(tmpDir, 'Dockerfile'), 'FROM node:20\n');

    mockAssertBoundary.mockRejectedValueOnce(
      new Error('[ecosystem-runtime/npm] build_context resolves outside the allowed project boundary.'),
    );

    await expect(
      buildProjectImage({
        projectDir: tmpDir,
        dockerfilePath: 'Dockerfile',
        logPrefix: 'npm',
      }),
    ).rejects.toThrow(/build_context resolves outside/);

    // docker commands must NOT have been called after the boundary throw
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});
