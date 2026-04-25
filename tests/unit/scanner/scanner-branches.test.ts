/**
 * Branch coverage top-up for the scanner module.
 * Targets: src/modules/scanner/index.ts lines 84-85 (bootstrapDefaultEngines idempotency)
 * and the runScanner OSV engine not found branch.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@infra/utils/git-branch', () => ({
  detectGitBranch: vi.fn().mockResolvedValue('main'),
}));

import { ScannerEngineRegistry } from '@modules/scanner/registry';
import { bootstrapDefaultEngines, runScanner, defaultScannerRegistry, OSV_ENGINE_ID } from '@modules/scanner/index';
import type { CommandRunner } from '@core/types/common';
import type { ProjectConfig } from '@core/types/config';
import type { ScanResultJson } from '@core/types/scan';

function makeRunner(): CommandRunner {
  return {
    run: vi.fn().mockResolvedValue({ stdout: '{"results":[]}', stderr: '', exitCode: 0, command: '', dryRun: false }),
    runArgs: vi.fn(),
    dryRun: false,
    environment: 'local' as const,
  };
}

const minimalConfig: ProjectConfig = {
  project: { name: 'test', client: 'acme' },
  ecosystems: [],
} as unknown as ProjectConfig;

describe('bootstrapDefaultEngines()', () => {
  it('is idempotent — calling twice does not duplicate registrations', () => {
    const registry = new ScannerEngineRegistry();
    bootstrapDefaultEngines(registry);
    const countAfterFirst = registry.getAll().length;
    bootstrapDefaultEngines(registry);
    expect(registry.getAll().length).toBe(countAfterFirst);
  });
});

describe('runScanner() — branches', () => {
  it('throws when OSV engine is not registered in the provided registry', async () => {
    const emptyRegistry = new ScannerEngineRegistry();
    await expect(runScanner(makeRunner(), minimalConfig, '/cwd', undefined, emptyRegistry))
      .rejects.toThrow('OSV scanner engine');
  });

  it('bootstraps default engines when using defaultScannerRegistry (lines 83-85)', async () => {
    // Spy on the defaultScannerRegistry's OSV engine scan method
    bootstrapDefaultEngines(defaultScannerRegistry);
    const osvEngine = defaultScannerRegistry.get(OSV_ENGINE_ID)!;
    const mockScanResult: ScanResultJson = {
      $schema: 'osv-scan-result/v1',
      agent: 'osv',
      status: 'success',
      environment: 'local',
      ecosystems: {},
      error: null,
    };
    const scanSpy = vi.spyOn(osvEngine, 'scan').mockResolvedValue(mockScanResult);

    const result = await runScanner(makeRunner(), minimalConfig, '/cwd');

    expect(scanSpy).toHaveBeenCalled();
    expect(result.agent).toBe('osv');
    scanSpy.mockRestore();
  });
});
