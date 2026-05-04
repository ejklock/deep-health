/**
 * Unit tests for npmPlugin.resolveEffectiveFixer
 *
 * Verifies the lockfile-v1 auto-demotion logic that was moved from
 * runEcosystemFix into the npm plugin's resolveEffectiveFixer hook.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@modules/ecosystem/utils/lockfile-utils', () => ({
  readNpmLockfileVersion: vi.fn().mockResolvedValue(null),
}));

import { npmPlugin } from '@modules/ecosystem/plugins/npm';
import { readNpmLockfileVersion } from '@modules/ecosystem/utils/lockfile-utils';
import type { ProjectConfig } from '@core/types/config';

function makeConfig(fixer?: string): ProjectConfig {
  return {
    project: { name: 'Test', client: 'Test' },
    ecosystems: fixer !== undefined
      ? [{ id: 'npm', fixer, validationCommands: [], advisors: [] }]
      : [{ id: 'npm', validationCommands: [], advisors: [] }],
    protected_packages: { npm: [], composer: [], pip: [] },
    safe_update_policy: {
      allow_patch_and_minor_within_constraints: true,
      require_authorization_for_constraint_change: true,
    },
    conflict_resolution: 'stop_and_ask',
    scanners: { osv: { runner: 'local' } },
  } as ProjectConfig;
}

describe('npmPlugin.resolveEffectiveFixer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('(a) lockfileVersion=2 + configured strategy osv → returns osv unchanged', async () => {
    vi.mocked(readNpmLockfileVersion).mockResolvedValue(2);

    const result = await npmPlugin.resolveEffectiveFixer!(makeConfig('osv'), '/project');

    expect(readNpmLockfileVersion).toHaveBeenCalledWith('/project');
    expect(result).toBe('osv');
  });

  it('(a) lockfileVersion=2 + configured strategy osv-then-audit → returns osv-then-audit unchanged', async () => {
    vi.mocked(readNpmLockfileVersion).mockResolvedValue(2);

    const result = await npmPlugin.resolveEffectiveFixer!(makeConfig('osv-then-audit'), '/project');

    expect(result).toBe('osv-then-audit');
  });

  it('(b) lockfileVersion=1 + strategy osv → returns npm-audit (demotion)', async () => {
    vi.mocked(readNpmLockfileVersion).mockResolvedValue(1);

    const result = await npmPlugin.resolveEffectiveFixer!(makeConfig('osv'), '/project');

    expect(readNpmLockfileVersion).toHaveBeenCalledWith('/project');
    expect(result).toBe('npm-audit');
  });

  it('(c) lockfileVersion=1 + strategy osv-then-audit → returns npm-audit (demotion)', async () => {
    vi.mocked(readNpmLockfileVersion).mockResolvedValue(1);

    const result = await npmPlugin.resolveEffectiveFixer!(makeConfig('osv-then-audit'), '/project');

    expect(result).toBe('npm-audit');
  });

  it('(d) strategy npm-audit → returns npm-audit without calling readNpmLockfileVersion', async () => {
    const result = await npmPlugin.resolveEffectiveFixer!(makeConfig('npm-audit'), '/project');

    // readNpmLockfileVersion must NOT be called — no lockfile inspection needed
    expect(readNpmLockfileVersion).not.toHaveBeenCalled();
    expect(result).toBe('npm-audit');
  });

  it('(e) lockfileVersion=null (file missing) → returns original strategy unchanged', async () => {
    vi.mocked(readNpmLockfileVersion).mockResolvedValue(null);

    const result = await npmPlugin.resolveEffectiveFixer!(makeConfig('osv'), '/project');

    expect(readNpmLockfileVersion).toHaveBeenCalledWith('/project');
    expect(result).toBe('osv');
  });

  it('no configured fixer → uses NPM_DEFAULT_FIXER (osv-then-audit) as default', async () => {
    vi.mocked(readNpmLockfileVersion).mockResolvedValue(2);

    // Config has no fixer set for npm
    const result = await npmPlugin.resolveEffectiveFixer!(makeConfig(), '/project');

    // Default is NPM_DEFAULT_FIXER = 'osv-then-audit'; v2 lockfile so no demotion
    expect(result).toBe('osv-then-audit');
  });

  it('no configured fixer + lockfileVersion=1 → demotes default osv-then-audit to npm-audit', async () => {
    vi.mocked(readNpmLockfileVersion).mockResolvedValue(1);

    const result = await npmPlugin.resolveEffectiveFixer!(makeConfig(), '/project');

    expect(result).toBe('npm-audit');
  });
});
