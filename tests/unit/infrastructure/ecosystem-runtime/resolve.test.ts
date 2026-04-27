/**
 * Tests for resolveEcosystemRuntime — dockerfile image-source path.
 *
 * Covers:
 *  - image_source='dockerfile' calls buildProjectImage with correct args
 *  - entrypointOverride from buildProjectImage is forwarded to EphemeralEcosystemContainer
 *  - requiredBinaries (from spec.containerBinaries) are passed to buildProjectImage
 *  - image_source='dockerfile' without dockerfile_path throws
 *  - image_source='pull' (default) does NOT call buildProjectImage
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('@infra/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@infra/ecosystem-runtime/ephemeral-container', () => ({
  EphemeralEcosystemContainer: vi.fn(),
}));

vi.mock('@infra/ecosystem-runtime/command-runner', () => ({
  EcosystemContainerCommandRunner: vi.fn().mockReturnValue({}),
}));

vi.mock('@infra/ecosystem-runtime/build-project-image', () => ({
  buildProjectImage: vi.fn(),
}));

import { resolveEcosystemRuntime } from '@infra/ecosystem-runtime/resolve';
import { EphemeralEcosystemContainer } from '@infra/ecosystem-runtime/ephemeral-container';
import { buildProjectImage } from '@infra/ecosystem-runtime/build-project-image';
import type { EcosystemPlugin } from '@modules/ecosystem/types';
import type { ProjectConfig } from '@core/types/config';
import type { CommandRunner } from '@core/types/common';

const MockContainer = vi.mocked(EphemeralEcosystemContainer);
const mockBuildProjectImage = vi.mocked(buildProjectImage);

function makeHostRunner(): CommandRunner {
  return {
    dryRun: false,
    environment: 'local',
    run: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, command: '', dryRun: false }),
    runArgs: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, command: '', dryRun: false }),
  };
}

function makePlugin(overrides: Partial<EcosystemPlugin> = {}): EcosystemPlugin {
  return {
    id: 'npm',
    name: 'npm',
    lockfiles: ['package.json', 'package-lock.json'],
    osvEcosystems: ['npm'],
    reportLabel: 'npm',
    runtimeSpec: {
      defaultImage: 'node:lts',
      resolveImage: () => 'node:lts',
      containerBinaries: ['npm', 'npx'],
      runMode: { kind: 'direct-exec', binary: 'npm' },
    },
    buildScanArgs: () => [],
    getProtectedPackages: () => [],
    runUpdater: vi.fn(),
    ...overrides,
  };
}

function makeConfig(scanners: ProjectConfig['scanners'] = {}): ProjectConfig {
  return {
    project: { name: 'Test', client: 'Test' },
    ecosystems: [{ id: 'npm' }],
    protected_packages: {},
    safe_update_policy: {
      allow_patch_and_minor_within_constraints: true,
      require_authorization_for_constraint_change: false,
    },
    conflict_resolution: 'manual',
    scanners,
  };
}

describe('resolveEcosystemRuntime — dockerfile image-source', () => {
  beforeEach(() => {
    MockContainer.mockClear();
    MockContainer.mockImplementation(() => ({} as any));
    mockBuildProjectImage.mockReset();
  });

  it('calls buildProjectImage with projectDir, dockerfilePath, logPrefix, and containerBinaries', async () => {
    mockBuildProjectImage.mockResolvedValue({
      image: 'deep-health-project/npm:abc123',
      entrypointOverride: '',
    });

    const plugin = makePlugin();
    const config = makeConfig({
      npm: { image_source: 'dockerfile', dockerfile_path: '.docker/node.Dockerfile' },
    });

    await resolveEcosystemRuntime(plugin, makeHostRunner(), config, '/my/project');

    expect(mockBuildProjectImage).toHaveBeenCalledOnce();
    expect(mockBuildProjectImage).toHaveBeenCalledWith({
      projectDir: '/my/project',
      dockerfilePath: '.docker/node.Dockerfile',
      logPrefix: 'npm',
      requiredBinaries: ['npm', 'npx'],
    });
  });

  it('forwards entrypointOverride from buildProjectImage result to EphemeralEcosystemContainer', async () => {
    mockBuildProjectImage.mockResolvedValue({
      image: 'deep-health-project/npm:abc123',
      entrypointOverride: '',
    });

    const plugin = makePlugin();
    const config = makeConfig({
      npm: { image_source: 'dockerfile', dockerfile_path: 'Dockerfile' },
    });

    await resolveEcosystemRuntime(plugin, makeHostRunner(), config, '/project');

    const containerOptions = (MockContainer as Mock).mock.calls[0][0] as Record<string, unknown>;
    expect(containerOptions.entrypointOverride).toBe('');
    expect(containerOptions.image).toBe('deep-health-project/npm:abc123');
  });

  it('throws when image_source="dockerfile" but dockerfile_path is missing', async () => {
    const plugin = makePlugin();
    const config = makeConfig({
      npm: { image_source: 'dockerfile' } as any,
    });

    await expect(
      resolveEcosystemRuntime(plugin, makeHostRunner(), config, '/project'),
    ).rejects.toThrow(/dockerfile_path/);
  });

  it('does NOT call buildProjectImage when image_source is "pull" (default)', async () => {
    const plugin = makePlugin();
    const config = makeConfig({ npm: { runtime_version: '20' } });

    await resolveEcosystemRuntime(plugin, makeHostRunner(), config, '/project');

    expect(mockBuildProjectImage).not.toHaveBeenCalled();
  });

  it('does NOT call buildProjectImage when image_source is absent (defaults to pull)', async () => {
    const plugin = makePlugin();
    const config = makeConfig({});

    await resolveEcosystemRuntime(plugin, makeHostRunner(), config, '/project');

    expect(mockBuildProjectImage).not.toHaveBeenCalled();
  });

  it('uses the image returned by buildProjectImage (not the spec default image)', async () => {
    const projectBuiltImage = 'deep-health-project/npm:deadbeef1234';
    mockBuildProjectImage.mockResolvedValue({
      image: projectBuiltImage,
      entrypointOverride: '',
    });

    const plugin = makePlugin();
    const config = makeConfig({
      npm: { image_source: 'dockerfile', dockerfile_path: 'Dockerfile' },
    });

    await resolveEcosystemRuntime(plugin, makeHostRunner(), config, '/project');

    const containerOptions = (MockContainer as Mock).mock.calls[0][0] as Record<string, unknown>;
    expect(containerOptions.image).toBe(projectBuiltImage);
    // Must NOT be the spec default
    expect(containerOptions.image).not.toBe('node:lts');
  });

  it('passes requiredBinaries derived from spec.containerBinaries (composer plugin)', async () => {
    mockBuildProjectImage.mockResolvedValue({
      image: 'deep-health-project/composer:abc',
      entrypointOverride: '',
    });

    const composerPlugin = makePlugin({
      id: 'composer',
      runtimeSpec: {
        defaultImage: 'composer:2',
        resolveImage: () => 'php:8.2-cli',
        containerBinaries: ['composer', 'php'],
        runMode: { kind: 'shell-wrap' },
      },
    });
    const config = makeConfig({
      composer: { image_source: 'dockerfile', dockerfile_path: '.docker/php.Dockerfile' },
    } as any);

    await resolveEcosystemRuntime(composerPlugin, makeHostRunner(), config, '/project');

    expect(mockBuildProjectImage).toHaveBeenCalledWith(
      expect.objectContaining({ requiredBinaries: ['composer', 'php'] }),
    );
  });
});
