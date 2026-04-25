/**
 * Branch coverage for src/modules/ecosystem/plugins/composer.ts
 * — getProtectedPackages ?? [] branch (line 87)
 * — runUpdater ctx.validationCommands ?? [] branch (line 97)
 */
import { describe, it, expect, vi } from 'vitest';

const { mockRunComposerUpdater } = vi.hoisted(() => ({
  mockRunComposerUpdater: vi.fn().mockResolvedValue({
    agent: 'composer',
    status: 'success',
    environment: 'local',
    packages_updated: [],
    validations: [],
  }),
}));

vi.mock('@modules/ecosystem/plugins/composer-updater', () => ({
  runComposerUpdater: mockRunComposerUpdater,
}));

// Also mock fs/promises so inferVersion doesn't touch disk
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
}));

import { composerPlugin } from '@modules/ecosystem/plugins/composer';
import type { EcosystemUpdaterContext } from '@modules/ecosystem/types';

function makeCtx(overrides: Partial<EcosystemUpdaterContext> = {}): EcosystemUpdaterContext {
  return {
    runner: { run: vi.fn(), runArgs: vi.fn(), dryRun: false, environment: 'local' } as any,
    config: {
      ecosystems: { composer: { enabled: true } },
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

describe('composerPlugin.getProtectedPackages — ?? [] branch', () => {
  it('returns [] when protected_packages has no composer key (line 87 ?? [])', () => {
    const config = { protected_packages: {} } as any;
    expect(composerPlugin.getProtectedPackages!(config)).toEqual([]);
  });

  it('returns array when protected_packages has composer key', () => {
    const config = { protected_packages: { composer: [{ name: 'vendor/pkg' }] } } as any;
    expect(composerPlugin.getProtectedPackages!(config)).toEqual([{ name: 'vendor/pkg' }]);
  });
});

describe('composerPlugin.runUpdater — validationCommands ?? [] branch', () => {
  it('calls runComposerUpdater with [] when ctx.validationCommands is undefined (line 97)', async () => {
    const ctx = makeCtx(); // no validationCommands
    await composerPlugin.runUpdater!(ctx);
    expect(mockRunComposerUpdater).toHaveBeenCalledWith(
      ctx.runner,
      ctx.config,
      ctx.scanResult,
      ctx.cwd,
      ctx.authorizeBreaking,
      [], // ?? [] result
    );
  });

  it('calls runComposerUpdater with provided validationCommands', async () => {
    const ctx = makeCtx({ validationCommands: ['php artisan'] });
    await composerPlugin.runUpdater!(ctx);
    expect(mockRunComposerUpdater).toHaveBeenCalledWith(
      ctx.runner,
      ctx.config,
      ctx.scanResult,
      ctx.cwd,
      ctx.authorizeBreaking,
      ['php artisan'],
    );
  });
});
