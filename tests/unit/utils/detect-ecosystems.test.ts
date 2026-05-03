import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({
  access: vi.fn(),
}));

import { access } from 'node:fs/promises';
import { detectEcosystems } from '@infra/utils/detect-ecosystems';
import type { EcosystemPlugin } from '@modules/ecosystem/types';

const mockAccess = vi.mocked(access);

// Minimal fake plugins — only the fields detectEcosystems uses
function makePlugin(id: string, lockfiles: string[]): EcosystemPlugin {
  return {
    id,
    name: id,
    lockfiles,
    osvEcosystems: [],
    supportedFixers: [],
    defaultValidationCommands: [],
    defaultAdvisors: [],
    buildScanArgs: () => [],
    runUpdater: async () => ({ status: 'ok', packages: [], validations: [] }),
    postUpdateOsvVerify: 'never',
  } as unknown as EcosystemPlugin;
}

const npmPlugin = makePlugin('npm', ['package.json', 'package-lock.json']);
const composerPlugin = makePlugin('composer', ['composer.json', 'composer.lock']);
const pipPlugin = makePlugin('pip', ['requirements.txt']);

describe('detectEcosystems', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('detects npm when package.json exists', async () => {
    mockAccess.mockImplementation(async (p) => {
      if (String(p).endsWith('package.json')) return;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const result = await detectEcosystems('/repo', [npmPlugin, composerPlugin, pipPlugin]);

    expect(result).toEqual(new Set(['npm']));
  });

  it('detects npm when only package-lock.json exists (no package.json)', async () => {
    mockAccess.mockImplementation(async (p) => {
      if (String(p).endsWith('package-lock.json')) return;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const result = await detectEcosystems('/repo', [npmPlugin]);

    expect(result.has('npm')).toBe(true);
  });

  it('detects composer when composer.json exists', async () => {
    mockAccess.mockImplementation(async (p) => {
      if (String(p).endsWith('composer.json')) return;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const result = await detectEcosystems('/repo', [npmPlugin, composerPlugin, pipPlugin]);

    expect(result).toEqual(new Set(['composer']));
  });

  it('detects both npm and composer when both manifest files exist', async () => {
    mockAccess.mockImplementation(async (p) => {
      const str = String(p);
      if (str.endsWith('package.json') || str.endsWith('composer.json')) return;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const result = await detectEcosystems('/repo', [npmPlugin, composerPlugin, pipPlugin]);

    expect(result).toEqual(new Set(['npm', 'composer']));
  });

  it('detects all three ecosystems when all manifests exist', async () => {
    mockAccess.mockResolvedValue(undefined);

    const result = await detectEcosystems('/repo', [npmPlugin, composerPlugin, pipPlugin]);

    expect(result).toEqual(new Set(['npm', 'composer', 'pip']));
  });

  it('returns empty set when no lockfiles exist', async () => {
    mockAccess.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const result = await detectEcosystems('/repo', [npmPlugin, composerPlugin, pipPlugin]);

    expect(result.size).toBe(0);
  });

  it('returns empty set when plugins array is empty', async () => {
    const result = await detectEcosystems('/repo', []);
    expect(result.size).toBe(0);
    expect(mockAccess).not.toHaveBeenCalled();
  });

  it('does not crash when access throws with unexpected error (e.g. EACCES) — treats as not detected', async () => {
    mockAccess.mockRejectedValue(
      Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
    );

    const result = await detectEcosystems('/repo', [npmPlugin]);

    expect(result.size).toBe(0);
  });

  it('stops checking remaining lockfiles for a plugin once one is found (breaks early)', async () => {
    mockAccess.mockImplementation(async (p) => {
      if (String(p).endsWith('package.json')) return;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    await detectEcosystems('/repo', [npmPlugin]);

    // package.json is first in the lockfiles list — access should be called once for npm
    const npmCalls = mockAccess.mock.calls.filter(([p]) =>
      String(p).includes('package'),
    );
    // package.json found first → package-lock.json must NOT have been checked
    expect(npmCalls.length).toBe(1);
    expect(String(npmCalls[0]![0])).toMatch(/package\.json$/);
  });

  it('detects pip when requirements.txt exists', async () => {
    mockAccess.mockImplementation(async (p) => {
      if (String(p).endsWith('requirements.txt')) return;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const result = await detectEcosystems('/repo', [npmPlugin, composerPlugin, pipPlugin]);

    expect(result).toEqual(new Set(['pip']));
  });

  it('resolves lockfile path relative to cwd', async () => {
    mockAccess.mockResolvedValue(undefined);

    await detectEcosystems('/my/project', [npmPlugin]);

    expect(mockAccess).toHaveBeenCalledWith(
      expect.stringContaining('/my/project/package.json'),
    );
  });
});
