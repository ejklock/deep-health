/**
 * Unit tests for resolveOsvRuntime — the infrastructure helper that builds
 * a CommandRunner for osv-scanner residual verification.
 *
 * Covers:
 *  1. local mode  — returns hostRunner directly (same reference)
 *  2. docker mode (default image) — returns EcosystemContainerCommandRunner built with osvRuntimeSpec.defaultImage
 *  3. docker mode (custom image)  — custom image overrides spec defaultImage
 *  4. no scanners config          — falls through to docker mode, no crash
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@infra/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    phase: vi.fn(),
    skip: vi.fn(),
    header: vi.fn(),
    tagged: vi.fn(),
  },
}));

vi.mock('@infra/ecosystem-runtime/ephemeral-container', () => ({
  EphemeralEcosystemContainer: vi.fn().mockImplementation((opts: unknown) => ({ _opts: opts })),
}));

vi.mock('@infra/ecosystem-runtime/command-runner', () => ({
  EcosystemContainerCommandRunner: vi.fn().mockImplementation((opts: unknown) => ({ _opts: opts })),
}));

import { resolveOsvRuntime } from '@infra/ecosystem-runtime/resolve-osv';
import { EphemeralEcosystemContainer } from '@infra/ecosystem-runtime/ephemeral-container';
import { EcosystemContainerCommandRunner } from '@infra/ecosystem-runtime/command-runner';
import { osvRuntimeSpec } from '@infra/ecosystem-runtime/osv-runtime-spec';
import type { CommandRunner } from '@core/types/common';
import type { ProjectConfig } from '@core/types/config';

const MockContainer = vi.mocked(EphemeralEcosystemContainer);
const MockCommandRunner = vi.mocked(EcosystemContainerCommandRunner);

function makeHostRunner(): CommandRunner {
  return {
    dryRun: false,
    environment: 'local',
    run: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, command: '', dryRun: false }),
    runArgs: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, command: '', dryRun: false }),
  };
}

function makeConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    project: { name: 'Test', client: 'Test' },
    ecosystems: [],
    protected_packages: {},
    safe_update_policy: {
      allow_patch_and_minor_within_constraints: true,
      require_authorization_for_constraint_change: false,
    },
    conflict_resolution: 'manual',
    ...overrides,
  } as ProjectConfig;
}

describe('resolveOsvRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('local mode — returns hostRunner directly (same reference)', () => {
    const hostRunner = makeHostRunner();
    const config = makeConfig({ scanners: { osv: { runner: 'local' } } });

    const result = resolveOsvRuntime(config, '/project', hostRunner);

    expect(result).toBe(hostRunner);
    expect(MockContainer).not.toHaveBeenCalled();
    expect(MockCommandRunner).not.toHaveBeenCalled();
  });

  it('docker mode (default image) — builds EcosystemContainerCommandRunner with osvRuntimeSpec.defaultImage', () => {
    const hostRunner = makeHostRunner();
    const config = makeConfig({ scanners: { osv: { runner: 'docker' } } });

    resolveOsvRuntime(config, '/project', hostRunner);

    expect(MockContainer).toHaveBeenCalledOnce();
    const containerOpts = MockContainer.mock.calls[0][0];
    expect(containerOpts.image).toBe(osvRuntimeSpec.defaultImage);
    expect(containerOpts.readonly).toBe(true);
    expect(containerOpts.projectDir).toBe('/project');
    expect(containerOpts.logPrefix).toBe('osv');

    expect(MockCommandRunner).toHaveBeenCalledOnce();
    const runnerOpts = MockCommandRunner.mock.calls[0][0];
    expect(runnerOpts.hostRunner).toBe(hostRunner);
    expect(runnerOpts.dryRun).toBe(false);
  });

  it('docker mode (custom image) — uses config.scanners.osv.image to override default', () => {
    const hostRunner = makeHostRunner();
    const customImage = 'ghcr.io/google/osv-scanner:v1.9.0';
    const config = makeConfig({ scanners: { osv: { runner: 'docker', image: customImage } } });

    resolveOsvRuntime(config, '/project', hostRunner);

    expect(MockContainer).toHaveBeenCalledOnce();
    const containerOpts = MockContainer.mock.calls[0][0];
    expect(containerOpts.image).toBe(customImage);
  });

  it('no scanners config — falls through to docker mode with default image (no crash)', () => {
    const hostRunner = makeHostRunner();
    // config.scanners is undefined
    const config = makeConfig();

    resolveOsvRuntime(config, '/project', hostRunner);

    expect(MockContainer).toHaveBeenCalledOnce();
    const containerOpts = MockContainer.mock.calls[0][0];
    expect(containerOpts.image).toBe(osvRuntimeSpec.defaultImage);
    expect(MockCommandRunner).toHaveBeenCalledOnce();
  });
});
