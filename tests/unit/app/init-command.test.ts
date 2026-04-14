import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn(),
  access: vi.fn().mockRejectedValue(new Error('not found')),
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

import { writeFile, mkdir } from 'node:fs/promises';
import { generateConfigYaml } from '@infra/config/generator';
import { prompt } from '@infra/utils/prompt';
import { runInitCommand } from '@app/commands/init';

const mockPrompt = vi.mocked(prompt);

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
        ecosystemConfigs: expect.arrayContaining([
          expect.objectContaining({ id: 'npm', version: '20' }),
          expect.objectContaining({ id: 'composer', version: undefined }),
        ]),
      }),
    );
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
        ecosystemConfigs: expect.arrayContaining([
          // npm: inferred "20" accepted → version: "20"
          expect.objectContaining({ id: 'npm', version: '20' }),
        ]),
      }),
    );

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
        ecosystemConfigs: expect.arrayContaining([
          // Blank response → version should be undefined
          expect.objectContaining({ id: 'npm', version: undefined }),
        ]),
      }),
    );
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
