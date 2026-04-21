/**
 * Unit tests for pure helpers in src/infrastructure/utils/osv-commands.ts.
 *
 * Focus: `buildOsvToolArgs` and `buildOsvDockerRunArgs`.
 * These are pure functions — no mocks required.
 *
 * Note: `toContainerPath` and `translateLockfileArgsForContainer` have been
 * removed — path translation is no longer needed because `buildOsvDockerRunArgs`
 * sets `--workdir /project`, allowing raw plugin lockfile args to be passed
 * directly to the container.
 */
import { describe, it, expect } from 'vitest';
import {
  buildOsvToolArgs,
  buildOsvDockerRunArgs,
  OSV_DEFAULT_IMAGE,
} from '@infra/utils/osv-commands';

// ─── buildOsvToolArgs ─────────────────────────────────────────────────────────

describe('buildOsvToolArgs', () => {
  it('appends --format json to lockfile args', () => {
    const result = buildOsvToolArgs(['--lockfile', 'package-lock.json']);
    expect(result).toEqual(['--lockfile', 'package-lock.json', '--format', 'json']);
  });

  it('works with empty lockfile args', () => {
    expect(buildOsvToolArgs([])).toEqual(['--format', 'json']);
  });

  it('--format json is always the last two elements', () => {
    const result = buildOsvToolArgs(['--lockfile', 'a', '--lockfile', 'b']);
    expect(result[result.length - 2]).toBe('--format');
    expect(result[result.length - 1]).toBe('json');
  });
});

// ─── buildOsvDockerRunArgs ────────────────────────────────────────────────────

describe('buildOsvDockerRunArgs', () => {
  it('starts with run --rm', () => {
    const args = buildOsvDockerRunArgs('/app', OSV_DEFAULT_IMAGE, []);
    expect(args[0]).toBe('run');
    expect(args[1]).toBe('--rm');
  });

  it('includes --volume <projectDir>:/project:ro by default', () => {
    const args = buildOsvDockerRunArgs('/my/project', OSV_DEFAULT_IMAGE, []);
    const volIdx = args.indexOf('--volume');
    expect(volIdx).toBeGreaterThanOrEqual(0);
    expect(args[volIdx + 1]).toBe('/my/project:/project:ro');
  });

  it('includes --volume <projectDir>:/project:ro when readonly=true', () => {
    const args = buildOsvDockerRunArgs('/my/project', OSV_DEFAULT_IMAGE, [], undefined, true);
    const volIdx = args.indexOf('--volume');
    expect(args[volIdx + 1]).toBe('/my/project:/project:ro');
  });

  it('includes --volume <projectDir>:/project:rw when readonly=false', () => {
    const args = buildOsvDockerRunArgs('/my/project', OSV_DEFAULT_IMAGE, [], undefined, false);
    const volIdx = args.indexOf('--volume');
    expect(volIdx).toBeGreaterThanOrEqual(0);
    expect(args[volIdx + 1]).toBe('/my/project:/project:rw');
  });

  it('includes --workdir /project after --volume', () => {
    const args = buildOsvDockerRunArgs('/app', OSV_DEFAULT_IMAGE, []);
    const wdIdx = args.indexOf('--workdir');
    expect(wdIdx).toBeGreaterThanOrEqual(0);
    expect(args[wdIdx + 1]).toBe('/project');
    // --workdir must appear after --volume
    const volIdx = args.indexOf('--volume');
    expect(wdIdx).toBeGreaterThan(volIdx);
  });

  it('places --workdir /project before the image', () => {
    const args = buildOsvDockerRunArgs('/app', OSV_DEFAULT_IMAGE, []);
    const wdIdx = args.indexOf('--workdir');
    const imageIdx = args.indexOf(OSV_DEFAULT_IMAGE);
    expect(wdIdx).toBeGreaterThanOrEqual(0);
    expect(imageIdx).toBeGreaterThan(wdIdx);
  });

  it('includes the image', () => {
    const args = buildOsvDockerRunArgs('/app', 'ghcr.io/google/osv-scanner:v1', []);
    expect(args).toContain('ghcr.io/google/osv-scanner:v1');
  });

  it('appends --format json at the end', () => {
    const args = buildOsvDockerRunArgs('/app', OSV_DEFAULT_IMAGE, []);
    expect(args[args.length - 2]).toBe('--format');
    expect(args[args.length - 1]).toBe('json');
  });

  it('omits --platform when not provided', () => {
    const args = buildOsvDockerRunArgs('/app', OSV_DEFAULT_IMAGE, []);
    expect(args).not.toContain('--platform');
  });

  it('includes --platform when provided', () => {
    const args = buildOsvDockerRunArgs('/app', OSV_DEFAULT_IMAGE, [], 'linux/amd64');
    const idx = args.indexOf('--platform');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('linux/amd64');
  });

  it('passes raw plugin lockfile args through to tool args without modification', () => {
    const rawArgs = ['--lockfile', 'package-lock.json', '--lockfile', 'composer.lock'];
    const args = buildOsvDockerRunArgs('/app', OSV_DEFAULT_IMAGE, rawArgs);
    expect(args).toContain('--lockfile');
    expect(args).toContain('package-lock.json');
    expect(args).toContain('composer.lock');
  });
});
