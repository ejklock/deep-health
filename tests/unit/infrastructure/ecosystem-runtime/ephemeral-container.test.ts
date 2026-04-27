/**
 * Tests for EphemeralEcosystemContainer — specifically entrypointOverride injection
 * into `docker run` args, and general _buildDockerArgs correctness for both RunModes.
 *
 * Covers the regression case: --entrypoint "" must be injected when entrypointOverride=""
 * (for project-built images) so the image ENTRYPOINT cannot shadow the ecosystem CLI.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@infra/utils/docker-platform', () => ({
  needsHostGateway: () => false,
  resolvePlatform: (p: string | undefined) => p,
}));

vi.mock('@infra/utils/retry', () => ({
  withRetry: async (fn: () => Promise<unknown>) => fn(),
  isDockerTransientError: () => false,
}));

import { EphemeralEcosystemContainer } from '@infra/ecosystem-runtime/ephemeral-container';
import type { RunMode } from '@infra/ecosystem-runtime/types';

function makeContainer(opts: {
  runMode?: RunMode;
  image?: string;
  entrypointOverride?: string;
}) {
  return new EphemeralEcosystemContainer({
    runMode: opts.runMode ?? { kind: 'direct-exec', binary: 'npm' },
    projectDir: '/project',
    image: opts.image ?? 'node:20',
    logPrefix: 'npm',
    entrypointOverride: opts.entrypointOverride,
  });
}

describe('EphemeralEcosystemContainer — _buildDockerArgs', () => {
  // ─── entrypointOverride propagation ────────────────────────────────────────

  it('injects --entrypoint "" into docker run args when entrypointOverride is set to ""', () => {
    const container = makeContainer({ entrypointOverride: '' });
    const args = container._buildDockerArgs(['install']);

    const entrypointIdx = args.indexOf('--entrypoint');
    expect(entrypointIdx).toBeGreaterThan(-1);
    expect(args[entrypointIdx + 1]).toBe('');
  });

  it('does NOT inject --entrypoint when entrypointOverride is undefined', () => {
    const container = makeContainer({ entrypointOverride: undefined });
    const args = container._buildDockerArgs(['install']);
    expect(args).not.toContain('--entrypoint');
  });

  it('injects --entrypoint with a custom value when entrypointOverride is a non-empty string', () => {
    const container = makeContainer({ entrypointOverride: '/custom/entrypoint' });
    const args = container._buildDockerArgs(['run']);
    const idx = args.indexOf('--entrypoint');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('/custom/entrypoint');
  });

  // ─── --entrypoint appears BEFORE the image name ───────────────────────────

  it('places --entrypoint before the image name in the arg list', () => {
    const container = makeContainer({ image: 'deep-health-project/npm:abc123', entrypointOverride: '' });
    const args = container._buildDockerArgs(['ci']);

    const entrypointIdx = args.indexOf('--entrypoint');
    const imageIdx = args.indexOf('deep-health-project/npm:abc123');
    expect(entrypointIdx).toBeGreaterThan(-1);
    expect(imageIdx).toBeGreaterThan(-1);
    expect(entrypointIdx).toBeLessThan(imageIdx);
  });

  // ─── direct-exec without preamble ─────────────────────────────────────────

  it('produces correct args for direct-exec without preamble', () => {
    const container = makeContainer({
      runMode: { kind: 'direct-exec', binary: 'npm' },
      image: 'node:20',
    });
    const args = container._buildDockerArgs(['install', '--frozen-lockfile']);

    expect(args[0]).toBe('run');
    expect(args[1]).toBe('--rm');
    expect(args).toContain('node:20');
    expect(args).toContain('npm');
    expect(args).toContain('install');
    expect(args).toContain('--frozen-lockfile');
  });

  // ─── direct-exec with preamble ────────────────────────────────────────────

  it('wraps argv in sh -lc with preamble for direct-exec with preamble', () => {
    const container = makeContainer({
      runMode: {
        kind: 'direct-exec',
        binary: 'npm',
        preamble: () => 'apt-get install -y libvips',
      },
      image: 'node:20',
    });
    const args = container._buildDockerArgs(['install']);

    expect(args).toContain('sh');
    expect(args).toContain('-lc');
    const shCmd = args[args.indexOf('-lc') + 1];
    expect(shCmd).toContain('apt-get install -y libvips');
    expect(shCmd).toContain('exec "$@"');
  });

  // ─── shell-wrap without preamble ──────────────────────────────────────────

  it('joins tokens in sh -lc for shell-wrap without preamble', () => {
    const container = makeContainer({
      runMode: { kind: 'shell-wrap' },
      image: 'composer:2',
    });
    const args = container._buildDockerArgs(['install', '--no-interaction']);

    expect(args).toContain('sh');
    expect(args).toContain('-lc');
    const shCmd = args[args.indexOf('-lc') + 1];
    expect(shCmd).toBe('install --no-interaction');
  });

  // ─── shell-wrap with preamble ─────────────────────────────────────────────

  it('prepends preamble before joined tokens in shell-wrap with preamble', () => {
    const container = makeContainer({
      runMode: {
        kind: 'shell-wrap',
        preamble: () => 'curl -sS https://getcomposer.org/installer | php',
      },
      image: 'php:8.2-cli',
    });
    const args = container._buildDockerArgs(['install']);

    const shCmd = args[args.indexOf('-lc') + 1];
    expect(shCmd).toContain('curl -sS https://getcomposer.org/installer | php');
    expect(shCmd).toContain('install');
  });

  // ─── Security: --cap-drop=ALL and --security-opt ──────────────────────────

  it('always includes --cap-drop=ALL and --security-opt no-new-privileges', () => {
    const container = makeContainer({});
    const args = container._buildDockerArgs(['install']);
    expect(args).toContain('--cap-drop=ALL');
    expect(args).toContain('--security-opt');
    expect(args).toContain('no-new-privileges');
  });

  // ─── Volume mount ─────────────────────────────────────────────────────────

  it('mounts projectDir at /project with --workdir /project', () => {
    const container = makeContainer({});
    const args = container._buildDockerArgs(['install']);
    expect(args).toContain('--volume');
    const volIdx = args.indexOf('--volume');
    expect(args[volIdx + 1]).toContain('/project:/project');
    expect(args).toContain('--workdir');
    expect(args[args.indexOf('--workdir') + 1]).toBe('/project');
  });
});
