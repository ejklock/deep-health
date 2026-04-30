/**
 * Tests the `findFreePort` null-address branch (lines 22-24 in docker-sonarqube.ts).
 *
 * We need a separate file so `vi.mock('node:net', ...)` doesn't interfere
 * with the net usage in docker-sonarqube.test.ts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], callback: (err: null | Error, result: { stdout: string; stderr: string }) => void) => {
    callback(null, { stdout: '', stderr: '' });
  }),
}));

vi.mock('@infra/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), phase: vi.fn(), skip: vi.fn(), header: vi.fn() },
}));

vi.mock('@infra/utils/shutdown-hooks.js', () => ({
  registerShutdownHook: vi.fn().mockReturnValue(() => undefined),
}));

const { mockNetCreateServer } = vi.hoisted(() => {
  const mockServer = {
    listen: vi.fn(),
    address: vi.fn().mockReturnValue(null), // returns null → triggers lines 22-24
    close: vi.fn(),
    on: vi.fn(),
  };

  return { mockNetCreateServer: vi.fn().mockReturnValue(mockServer) };
});

vi.mock('node:net', () => ({
  createServer: mockNetCreateServer,
}));

import { DockerSonarQubeProvisioner } from '@infra/provisioner/docker-sonarqube';
import type { CommandRunner, CommandResult, CommandRunnerOptions, ExecutionEnv } from '@core/types/common';

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('DockerSonarQubeProvisioner — findFreePort null address (lines 22-24)', () => {
  it('rejects with error when server.address() returns null after listen', async () => {
    // Wire up the mock server so listen() calls its callback synchronously
    mockNetCreateServer.mockReturnValue({
      listen: vi.fn((_port: number, _host: string, cb: () => void) => { cb(); }),
      address: vi.fn().mockReturnValue(null), // null address → lines 22-24
      close: vi.fn((cb?: (err?: Error) => void) => { cb?.(); }),
      on: vi.fn(),
    });

    const runner: CommandRunner = {
      dryRun: false,
      environment: 'local' as ExecutionEnv,
      run: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', command: '', dryRun: false } as CommandResult),
      runArgs: vi.fn((_f: string, _a: string[], _o?: CommandRunnerOptions) =>
        Promise.resolve({ exitCode: 0, stdout: '', stderr: '', command: '', dryRun: false } as CommandResult),
      ),
    };

    const provisioner = new DockerSonarQubeProvisioner({ projectName: 'test', runner });

    await expect(provisioner.provision()).rejects.toThrow('Could not determine free port');
  });
});
