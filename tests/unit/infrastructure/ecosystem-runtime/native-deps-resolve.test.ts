/**
 * Tests for native_deps preamble synthesis in resolveEcosystemRuntime.
 *
 * Verifies that when native_deps is present in scanner config, the resolved
 * container receives a RunMode with a preamble that installs the requested
 * OS packages via apt-get before running the ecosystem CLI.
 *
 * Also verifies that an existing plugin preamble (e.g. composer bootstrap)
 * is composed after the native_deps preamble, not replaced.
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

import { resolveEcosystemRuntime } from '@infra/ecosystem-runtime/resolve';
import { EphemeralEcosystemContainer } from '@infra/ecosystem-runtime/ephemeral-container';
import type { EcosystemPlugin } from '@modules/ecosystem/types';
import type { ProjectConfig } from '@core/types/config';
import type { CommandRunner } from '@core/types/common';

const MockContainer = vi.mocked(EphemeralEcosystemContainer);

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
      containerBinaries: ['npm'],
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

describe('resolveEcosystemRuntime — native_deps preamble', () => {
  beforeEach(() => {
    MockContainer.mockClear();
    MockContainer.mockImplementation(() => ({} as any));
  });

  it('passes runMode with apt-get preamble when native_deps is configured', async () => {
    const plugin = makePlugin();
    const config = makeConfig({
      npm: { native_deps: ['libvips-dev', 'build-essential'] },
    });

    await resolveEcosystemRuntime(plugin, makeHostRunner(), config, '/project');

    expect(MockContainer).toHaveBeenCalledOnce();
    const { runMode } = (MockContainer as Mock).mock.calls[0][0] as { runMode: any };

    expect(runMode.preamble).toBeDefined();
    const preamble = runMode.preamble('node:14');
    expect(preamble).toBe(
      'apt-get update -qq -o APT::Sandbox::User=root && apt-get install -y --no-install-recommends -o APT::Sandbox::User=root libvips-dev build-essential',
    );
  });

  it('does not add preamble when native_deps is absent', async () => {
    const plugin = makePlugin();
    const config = makeConfig({ npm: { runtime_version: '20' } });

    await resolveEcosystemRuntime(plugin, makeHostRunner(), config, '/project');

    const { runMode } = (MockContainer as Mock).mock.calls[0][0] as { runMode: any };
    expect(runMode.preamble).toBeUndefined();
  });

  it('does not add preamble when native_deps is an empty array', async () => {
    const plugin = makePlugin();
    const config = makeConfig({ npm: { native_deps: [] } });

    await resolveEcosystemRuntime(plugin, makeHostRunner(), config, '/project');

    const { runMode } = (MockContainer as Mock).mock.calls[0][0] as { runMode: any };
    expect(runMode.preamble).toBeUndefined();
  });

  it('composes native_deps preamble before an existing plugin preamble', async () => {
    const pluginPreamble = vi.fn((_image: string) => 'existing-bootstrap-cmd');
    const plugin = makePlugin({
      id: 'composer',
      runtimeSpec: {
        defaultImage: 'composer:2',
        resolveImage: () => 'php:8.2-cli',
        containerBinaries: ['composer'],
        runMode: { kind: 'shell-wrap', preamble: pluginPreamble },
      },
    });
    const config = makeConfig({ composer: { native_deps: ['imagemagick'] } } as any);

    await resolveEcosystemRuntime(plugin, makeHostRunner(), config, '/project');

    const { runMode } = (MockContainer as Mock).mock.calls[0][0] as { runMode: any };
    const preamble = runMode.preamble('php:8.2-cli');

    // native_deps apt-get must come first, then the plugin's own bootstrap
    expect(preamble).toBe(
      'apt-get update -qq -o APT::Sandbox::User=root && apt-get install -y --no-install-recommends -o APT::Sandbox::User=root imagemagick && existing-bootstrap-cmd',
    );
    expect(pluginPreamble).toHaveBeenCalledWith('php:8.2-cli');
  });

  it('uses only native_deps preamble when plugin preamble returns undefined for the image', async () => {
    const plugin = makePlugin({
      runtimeSpec: {
        defaultImage: 'node:lts',
        resolveImage: () => 'node:lts',
        containerBinaries: ['npm'],
        runMode: {
          kind: 'direct-exec',
          binary: 'npm',
          preamble: (_image: string) => undefined,
        },
      },
    });
    const config = makeConfig({ npm: { native_deps: ['python3'] } });

    await resolveEcosystemRuntime(plugin, makeHostRunner(), config, '/project');

    const { runMode } = (MockContainer as Mock).mock.calls[0][0] as { runMode: any };
    const preamble = runMode.preamble('node:lts');

    expect(preamble).toBe(
      'apt-get update -qq -o APT::Sandbox::User=root && apt-get install -y --no-install-recommends -o APT::Sandbox::User=root python3',
    );
  });
});
