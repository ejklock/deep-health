import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn(),
  access: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
  mkdir: vi.fn(),
  // plugins call readFile for inferVersion; return ENOENT so inference yields undefined
  readFile: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
}));

vi.mock('@infra/config/generator', () => ({
  generateConfigYaml: vi.fn(() => 'project:\n  name: demo\n'),
}));

vi.mock('@infra/utils/prompt', () => ({
  prompt: vi.fn(),
}));

import { writeFile, mkdir, access } from 'node:fs/promises';
import { generateConfigYaml } from '@infra/config/generator';
import { prompt } from '@infra/utils/prompt';
import { runInitCommand } from '@app/commands/init';
import { ConfigLoadError } from '@core/errors';

const mockPrompt = vi.mocked(prompt);
const mockAccess = vi.mocked(access);

// ─── Non-interactive mode ─────────────────────────────────────────────────────

describe('runInitCommand — non-interactive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('generates declarative config via ecosystemConfigs in non-interactive mode', async () => {
    await runInitCommand({
      cwd: '/repo',
      force: true,
      nonInteractive: true,
      projectName: 'My Project',
      client: 'My Client',
      output: 'project-config.yml',
    });

    expect(generateConfigYaml).toHaveBeenCalledWith(
      expect.objectContaining({
        ecosystemConfigs: expect.arrayContaining([
          expect.objectContaining({ id: 'composer' }),
          expect.objectContaining({ id: 'npm' }),
        ]),
        outputs: { formats: ['markdown'], dir: '.deep-health/reports' },
      }),
    );

    expect(mkdir).toHaveBeenCalled();
    expect(writeFile).toHaveBeenCalled();
  });

  it('passes inferred version from plugin.inferVersion in non-interactive mode', async () => {
    const { readFile } = await import('node:fs/promises');
    const mockReadFile = vi.mocked(readFile);

    // npm: .nvmrc and .node-version absent → falls through to package.json
    // composer: .php-version absent → falls through to composer.json (also absent)
    mockReadFile.mockImplementation(async (path: any) => {
      const p = String(path);
      if (p.endsWith('package.json')) {
        return JSON.stringify({ engines: { node: '>=20' } }) as any;
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    await runInitCommand({
      cwd: '/repo',
      force: true,
      nonInteractive: true,
      projectName: 'Versioned Project',
      client: 'Client',
      output: 'project-config.yml',
    });

    expect(generateConfigYaml).toHaveBeenCalledWith(
      expect.objectContaining({
        // npm runtime version is now routed to scanners.npm.runtime_version, not ecosystem entry
        npmRuntimeVersion: '20',
        ecosystemConfigs: expect.arrayContaining([
          // version must NOT be present on npm ecosystem entry
          expect.objectContaining({ id: 'npm' }),
          expect.objectContaining({ id: 'composer' }),
        ]),
      }),
    );
    // Verify version is NOT on the npm ecosystem entry
    const call = vi.mocked(generateConfigYaml).mock.calls[0]![0];
    const npmEntry = call.ecosystemConfigs?.find((e) => e.id === 'npm');
    expect(npmEntry?.version).toBeUndefined();
  });
});

// ─── Interactive mode ─────────────────────────────────────────────────────────

describe('runInitCommand — interactive version prompts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows inferred version as default and uses it when user accepts', async () => {
    const { readFile } = await import('node:fs/promises');
    const mockReadFile = vi.mocked(readFile);

    // npm: infer "20" from package.json; composer: nothing
    mockReadFile.mockImplementation(async (p: any) => {
      const path = String(p);
      if (path.endsWith('package.json'))
        return JSON.stringify({ engines: { node: '>=20' } }) as any;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    // Sequence of prompts: projectName, client,
    // include npm?, include composer?,
    // [npm] fixer, [npm] validation cmd, [npm] advisor, [npm] version,
    // [composer] validation cmd, [composer] advisor, [composer] version,
    // enable sonarqube?, report language, enable markdown?, output dir
    mockPrompt.mockImplementation(async (question: string, defaultValue?: string) => {
      // Version prompt for npm — user accepts the inferred default
      if (question.includes('Runtime version') && question.includes('npm')) {
        return defaultValue ?? ''; // accept inferred default "20"
      }
      // Version prompt for composer — user accepts blank default (no inferred)
      if (question.includes('Runtime version') && question.includes('Composer')) {
        return defaultValue ?? ''; // blank → omit
      }
      // Boolean-style prompts (promptBoolean uses prompt internally)
      if (question.includes('Include npm') || question.includes('Include Composer')) {
        return 'y';
      }
      // All other prompts: accept default
      return defaultValue ?? '';
    });

    await runInitCommand({
      cwd: '/repo',
      force: true,
      projectName: 'Interactive Project',
      client: 'Client',
      output: 'project-config.yml',
    });

    expect(generateConfigYaml).toHaveBeenCalledWith(
      expect.objectContaining({
        // npm runtime version routed to top-level npmRuntimeVersion, not ecosystem entry
        npmRuntimeVersion: '20',
        ecosystemConfigs: expect.arrayContaining([
          expect.objectContaining({ id: 'npm' }),
        ]),
      }),
    );
    // Verify version is NOT on the npm ecosystem entry
    const npmEntryCheck = vi.mocked(generateConfigYaml).mock.calls[0]![0];
    const npmEcoEntry = npmEntryCheck.ecosystemConfigs?.find((e) => e.id === 'npm');
    expect(npmEcoEntry?.version).toBeUndefined();

    // Verify that the version prompt for npm was called with the inferred value as default
    const npmVersionPromptCall = mockPrompt.mock.calls.find(
      ([q]: [string, ...unknown[]]) =>
        typeof q === 'string' && q.includes('Runtime version') && q.includes('inferred: 20'),
    );
    expect(npmVersionPromptCall).toBeDefined();
  });

  it('omits version when user responds with blank to the version prompt', async () => {
    const { readFile } = await import('node:fs/promises');
    const mockReadFile = vi.mocked(readFile);

    // npm: infer "20" from package.json
    mockReadFile.mockImplementation(async (p: any) => {
      const path = String(p);
      if (path.endsWith('package.json'))
        return JSON.stringify({ engines: { node: '20' } }) as any;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    mockPrompt.mockImplementation(async (question: string, defaultValue?: string) => {
      // User explicitly blanks out the version
      if (question.includes('Runtime version')) return '';
      if (question.includes('Include npm') || question.includes('Include Composer')) return 'y';
      return defaultValue ?? '';
    });

    await runInitCommand({
      cwd: '/repo',
      force: true,
      projectName: 'Blank Version Project',
      client: 'Client',
      output: 'project-config.yml',
    });

    expect(generateConfigYaml).toHaveBeenCalledWith(
      expect.objectContaining({
        // Blank response → npmRuntimeVersion should be undefined
        npmRuntimeVersion: undefined,
        ecosystemConfigs: expect.arrayContaining([
          expect.objectContaining({ id: 'npm' }),
        ]),
      }),
    );
    // Verify version is NOT on the npm ecosystem entry
    const blankVersionCall = vi.mocked(generateConfigYaml).mock.calls[0]![0];
    const npmBlankEntry = blankVersionCall.ecosystemConfigs?.find((e) => e.id === 'npm');
    expect(npmBlankEntry?.version).toBeUndefined();
  });

  it('does not prompt for version of a non-selected ecosystem', async () => {
    const { readFile } = await import('node:fs/promises');
    const mockReadFile = vi.mocked(readFile);

    mockReadFile.mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );

    const versionPromptQuestions: string[] = [];

    mockPrompt.mockImplementation(async (question: string, defaultValue?: string) => {
      if (question.includes('Runtime version')) {
        versionPromptQuestions.push(question);
      }
      // Only select npm; decline composer
      if (question.includes('Include npm')) return 'y';
      if (question.includes('Include Composer')) return 'n';
      return defaultValue ?? '';
    });

    await runInitCommand({
      cwd: '/repo',
      force: true,
      projectName: 'Npm Only Project',
      client: 'Client',
      output: 'project-config.yml',
    });

    // Version prompt should only appear for npm, never for composer
    expect(versionPromptQuestions.some((q) => q.includes('npm'))).toBe(true);
    expect(versionPromptQuestions.some((q) => q.includes('Composer'))).toBe(false);

    // ecosystemConfigs should only contain npm
    expect(generateConfigYaml).toHaveBeenCalledWith(
      expect.objectContaining({
        ecosystemConfigs: expect.arrayContaining([expect.objectContaining({ id: 'npm' })]),
      }),
    );
    const call = vi.mocked(generateConfigYaml).mock.calls[0]![0];
    const composerEntry = call.ecosystemConfigs?.find((e) => e.id === 'composer');
    expect(composerEntry).toBeUndefined();
  });
});

// ─── Existing file guard ──────────────────────────────────────────────────────

describe('runInitCommand — existing file guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset access mock entirely (clears all queued once-mocks) then set default to reject
    mockAccess.mockReset();
    // Simulate "file not found" (ENOENT) so the guard proceeds by default
    mockAccess.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  });

  it('throws ConfigLoadError (exit code 3 semantics) when output file exists and --force is not set', async () => {
    // Simulate file already exists
    mockAccess.mockResolvedValueOnce(undefined);

    await expect(
      runInitCommand({
        cwd: '/repo',
        force: false,
        nonInteractive: true,
        output: 'project-config.yml',
      }),
    ).rejects.toThrow(ConfigLoadError);
  });

  it('includes the output path and --force hint in the thrown error message', async () => {
    mockAccess.mockResolvedValueOnce(undefined);

    const err = await runInitCommand({
      cwd: '/repo',
      force: false,
      nonInteractive: true,
      output: 'project-config.yml',
    }).catch((e) => e);

    expect(err).toBeInstanceOf(ConfigLoadError);
    expect(err.message).toMatch(/File already exists/);
    expect(err.message).toMatch(/--force/);
  });

  it('proceeds normally when --force is set even if file exists', async () => {
    // When --force is true, access is not called at all (guard is skipped)

    await expect(
      runInitCommand({
        cwd: '/repo',
        force: true,
        nonInteractive: true,
        projectName: 'Force Project',
        client: 'Client',
        output: 'project-config.yml',
      }),
    ).resolves.toBeUndefined();

    expect(writeFile).toHaveBeenCalled();
  });

  it('proceeds normally when file does not exist and --force is not set', async () => {
    // access rejects (set in beforeEach) → file does not exist → proceed

    await expect(
      runInitCommand({
        cwd: '/repo',
        force: false,
        nonInteractive: true,
        projectName: 'New Project',
        client: 'Client',
        output: 'project-config.yml',
      }),
    ).resolves.toBeUndefined();

    expect(writeFile).toHaveBeenCalled();
  });

  it('proceeds when access rejects with an ENOENT error (code check)', async () => {
    // Explicitly set ENOENT with code
    mockAccess.mockRejectedValueOnce(
      Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }),
    );

    await expect(
      runInitCommand({
        cwd: '/repo',
        force: false,
        nonInteractive: true,
        projectName: 'ENOENT Project',
        client: 'Client',
        output: 'project-config.yml',
      }),
    ).resolves.toBeUndefined();

    expect(writeFile).toHaveBeenCalled();
  });

  it('re-throws unexpected fs errors (e.g. EACCES) instead of swallowing them', async () => {
    const permissionError = Object.assign(new Error('EACCES: permission denied'), {
      code: 'EACCES',
    });
    mockAccess.mockRejectedValueOnce(permissionError);

    await expect(
      runInitCommand({
        cwd: '/repo',
        force: false,
        nonInteractive: true,
        projectName: 'Permission Project',
        client: 'Client',
        output: 'project-config.yml',
      }),
    ).rejects.toThrow('EACCES: permission denied');

    expect(writeFile).not.toHaveBeenCalled();
  });
});
