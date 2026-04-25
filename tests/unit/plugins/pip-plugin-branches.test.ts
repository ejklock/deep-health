/**
 * Branch coverage for src/modules/ecosystem/plugins/pip.ts
 * — getProtectedPackages ?? [] branch (line 94)
 * — runUpdater ctx.validationCommands ?? [] branch (line 104)
 */
import { describe, it, expect, vi } from 'vitest';

const { mockRunPipUpdater } = vi.hoisted(() => ({
  mockRunPipUpdater: vi.fn().mockResolvedValue({
    agent: 'pip',
    status: 'success',
    environment: 'local',
    packages_updated: [],
    validations: [],
  }),
}));

vi.mock('@modules/ecosystem/plugins/pip-updater', () => ({
  runPipUpdater: mockRunPipUpdater,
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
}));

import { pipPlugin } from '@modules/ecosystem/plugins/pip';
import type { EcosystemUpdaterContext } from '@modules/ecosystem/types';

function makeCtx(overrides: Partial<EcosystemUpdaterContext> = {}): EcosystemUpdaterContext {
  return {
    runner: { run: vi.fn(), runArgs: vi.fn(), dryRun: false, environment: 'local' } as any,
    config: {
      ecosystems: { pip: { enabled: true } },
      protected_packages: {},
    } as any,
    scanResult: {
      $schema: 'osv-scan-result/v1',
      agent: 'osv',
      status: 'success',
      environment: 'local',
      ecosystems: {},
      error: null,
    } as any,
    cwd: '/project',
    authorizeBreaking: false,
    ...overrides,
  };
}

describe('pipPlugin.getProtectedPackages — ?? [] branch (line 94)', () => {
  it('returns [] when protected_packages has no pip key', () => {
    const config = { protected_packages: {} } as any;
    expect(pipPlugin.getProtectedPackages!(config)).toEqual([]);
  });

  it('returns array when protected_packages has pip key', () => {
    const config = { protected_packages: { pip: [{ name: 'requests' }] } } as any;
    expect(pipPlugin.getProtectedPackages!(config)).toEqual([{ name: 'requests' }]);
  });
});

describe('pipPlugin.runUpdater — validationCommands ?? [] branch (line 104)', () => {
  it('calls runPipUpdater with [] when ctx.validationCommands is undefined', async () => {
    const ctx = makeCtx();
    await pipPlugin.runUpdater!(ctx);
    expect(mockRunPipUpdater).toHaveBeenCalledWith(
      ctx.runner,
      ctx.config,
      ctx.scanResult,
      ctx.cwd,
      ctx.authorizeBreaking,
      [],
    );
  });

  it('calls runPipUpdater with provided validationCommands', async () => {
    const ctx = makeCtx({ validationCommands: ['pytest'] });
    await pipPlugin.runUpdater!(ctx);
    expect(mockRunPipUpdater).toHaveBeenCalledWith(
      ctx.runner,
      ctx.config,
      ctx.scanResult,
      ctx.cwd,
      ctx.authorizeBreaking,
      ['pytest'],
    );
  });
});
