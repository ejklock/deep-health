import { describe, it, expect, vi } from 'vitest';
import { runOrchestrator } from '@orchestration/orchestrator';
import { ScannerEngineRegistry } from '@modules/scanner/registry';
import { OsvScannerEngine } from '@modules/scanner/osv-engine';
import type { CommandRunner, CommandResult, CommandRunnerOptions, ExecutionEnv } from '@core/types/common';
import type { ProjectConfig } from '@core/types/config';
import { ComposerDockerRunner } from '@infra/provisioner/composer-runner';
import * as ecosystemRuntime from '@infra/ecosystem-runtime';

class MockCommandRunner implements CommandRunner {
  readonly dryRun: boolean;
  readonly environment: ExecutionEnv;
  readonly calledCommands: string[] = [];
  private responses: Map<string, Partial<CommandResult>>;
  private defaultResponse: Partial<CommandResult>;

  constructor(
    responses: Record<string, Partial<CommandResult>> = {},
    options: { dryRun?: boolean; environment?: ExecutionEnv; defaultExitCode?: number } = {},
  ) {
    this.dryRun = options.dryRun ?? false;
    this.environment = options.environment ?? 'local';
    this.responses = new Map(Object.entries(responses));
    this.defaultResponse = { stdout: '', stderr: '', exitCode: options.defaultExitCode ?? 0 };
  }

  async run(command: string, _options?: CommandRunnerOptions): Promise<CommandResult> {
    this.calledCommands.push(command);
    for (const [key, response] of this.responses) {
      if (command.includes(key)) {
        return {
          stdout: response.stdout ?? '',
          stderr: response.stderr ?? '',
          exitCode: response.exitCode ?? 0,
          command,
          dryRun: this.dryRun,
        };
      }
    }

    return {
      stdout: this.defaultResponse.stdout ?? '',
      stderr: this.defaultResponse.stderr ?? '',
      exitCode: this.defaultResponse.exitCode ?? 0,
      command,
      dryRun: this.dryRun,
    };
  }

  async runArgs(file: string, args: string[], options?: CommandRunnerOptions): Promise<CommandResult> {
    return this.run([file, ...args].join(' '), options);
  }
}

function makeRegistry(): ScannerEngineRegistry {
  const reg = new ScannerEngineRegistry();
  reg.register(new OsvScannerEngine());
  return reg;
}

function baseComposerConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  const { scanners: overrideScanners, ...restOverrides } = overrides;
  return {
    project: { name: 'Composer Runtime Test', client: 'Test' },
    ecosystems: [
      {
        id: 'composer',
        validationCommands: [{ name: 'tests', command: 'php artisan test --compact' }],
        advisors: [{ name: 'audit', command: 'composer audit' }],
      },
    ],
    protected_packages: { composer: [], npm: [], pip: [] },
    safe_update_policy: {
      allow_patch_and_minor_within_constraints: true,
      require_authorization_for_constraint_change: true,
    },
    conflict_resolution: 'stop_and_ask',
    scanners: {
      // Keep OSV local in tests so scan path does not require Docker.
      osv: { runner: 'local' },
      ...(overrideScanners ?? {}),
    },
    ...restOverrides,
  };
}

function composerScanWithAutoSafe(): string {
  return JSON.stringify({
    results: [
      {
        source: { path: 'composer.lock', type: 'lockfile' },
        packages: [
          {
            package: { name: 'laravel/framework', version: '10.8.0', ecosystem: 'packagist' },
            vulnerabilities: [
              {
                id: 'GHSA-test-composer-1',
                summary: 'Test composer vuln',
                affected: [
                  {
                    package: { ecosystem: 'Packagist', name: 'laravel/framework' },
                    ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '10.8.2' }] }],
                  },
                ],
              },
            ],
            groups: [{ ids: ['GHSA-test-composer-1'] }],
          },
        ],
      },
    ],
  });
}

describe('runOrchestrator — composer runtime phase 1', () => {
  it('runs composer env-check before update and fails early on env-check error', async () => {
    // Route ecosystem runtime through the host runner so calledCommands is populated.
    const runtimeSpy = vi.spyOn(ecosystemRuntime, 'resolveEcosystemRuntime')
      .mockImplementation((_plugin, hostRunner) => Promise.resolve(hostRunner));

    const config = baseComposerConfig();

    // composer install (env-check) returns non-zero → updater returns error result → gate throws
    const runner = new MockCommandRunner({
      '--lockfile composer.lock --format json': { stdout: composerScanWithAutoSafe(), exitCode: 0 },
      'composer audit': { stdout: '', exitCode: 0 },
      'composer install --no-interaction --no-scripts': { stderr: 'PHP extension missing', exitCode: 2 },
    });

    await expect(
      runOrchestrator(runner, config, {
        configPath: 'project-config.yml',
        cwd: '/repo',
        dryRun: false,
        verbose: false,
        scannerRegistry: makeRegistry(),
      }),
    ).rejects.toThrow(/Composer environment mismatch/);

    expect(runner.calledCommands.some((c) => c.includes('composer install'))).toBe(true);
    expect(runner.calledCommands.some((c) => c.startsWith('composer update'))).toBe(false);

    runtimeSpy.mockRestore();
  });

  it('includes composer install detail in environment mismatch error message', async () => {
    const runtimeSpy = vi.spyOn(ecosystemRuntime, 'resolveEcosystemRuntime')
      .mockImplementation((_plugin, hostRunner) => Promise.resolve(hostRunner));

    const config = baseComposerConfig();
    const runner = new MockCommandRunner({
      '--lockfile composer.lock --format json': { stdout: composerScanWithAutoSafe(), exitCode: 0 },
      'composer audit': { stdout: '', exitCode: 0 },
      'composer install --no-interaction --no-scripts': { stdout: 'install output', stderr: 'install stderr', exitCode: 1 },
    });

    await expect(
      runOrchestrator(runner, config, {
        configPath: 'project-config.yml',
        cwd: '/repo',
        dryRun: false,
        verbose: false,
        scannerRegistry: makeRegistry(),
      }),
    ).rejects.toThrow(/Composer environment mismatch/);

    runtimeSpy.mockRestore();
  });

  it('dry-run skips composer diagnose and update mutation', async () => {
    const runtimeSpy = vi.spyOn(ecosystemRuntime, 'resolveEcosystemRuntime')
      .mockImplementation((_plugin, hostRunner) => Promise.resolve(hostRunner));

    const config = baseComposerConfig();
    const runner = new MockCommandRunner(
      {
        '--lockfile composer.lock --format json': { stdout: composerScanWithAutoSafe(), exitCode: 0 },
        'composer audit': { stdout: '', exitCode: 0 },
      },
      { dryRun: true },
    );

    await runOrchestrator(runner, config, {
      configPath: 'project-config.yml',
      cwd: '/repo',
      dryRun: true,
      verbose: false,
      scannerRegistry: makeRegistry(),
    });

    expect(runner.calledCommands).not.toContain('composer diagnose --no-interaction');
    expect(runner.calledCommands).not.toContain('composer install --no-interaction --no-scripts');
    expect(runner.calledCommands.some((c) => c.startsWith('composer update'))).toBe(false);

    runtimeSpy.mockRestore();
  });

  it('docker mode routes env-check through composer container runner (not host fallback)', async () => {
    const config = baseComposerConfig({
      scanners: { composer: { mode: 'docker', runtime_version: '8.2' } },
    });

    const containerRunSpy = vi
      .spyOn(ComposerDockerRunner.prototype, 'run')
      .mockResolvedValue({ stdout: '', stderr: 'container diagnose fail', exitCode: 1 });

    const runner = new MockCommandRunner({
      '--lockfile composer.lock --format json': { stdout: composerScanWithAutoSafe(), exitCode: 0 },
      'composer audit': { stdout: '', exitCode: 0 },
    });

    await expect(
      runOrchestrator(runner, config, {
        configPath: 'project-config.yml',
        cwd: '/repo',
        dryRun: false,
        verbose: false,
        scannerRegistry: makeRegistry(),
      }),
    ).rejects.toThrow(/Composer environment mismatch/);

    // env-check runs in container — container runner spy should have been called
    expect(containerRunSpy).toHaveBeenCalled();
    // host runner never receives composer update
    expect(runner.calledCommands.some((c) => c.startsWith('composer update'))).toBe(false);

    containerRunSpy.mockRestore();
  });
});
