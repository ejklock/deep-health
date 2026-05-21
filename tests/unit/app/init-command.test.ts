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
  normalizeSonarProjectKey: vi.fn((name: string) => name.replace(/\s+/g, '-')),
}));

vi.mock('@infra/utils/prompt', () => ({
  prompt: vi.fn(),
}));

vi.mock('@infra/utils/inquirer-prompts', () => ({
  confirmPrompt: vi.fn(),
  selectPrompt: vi.fn(),
  checkboxPrompt: vi.fn(),
}));

vi.mock('@infra/utils/detect-ecosystems', () => ({
  detectEcosystems: vi.fn(),
}));

import { writeFile, mkdir, access } from 'node:fs/promises';
import { generateConfigYaml } from '@infra/config/generator';
import { prompt } from '@infra/utils/prompt';
import { confirmPrompt, selectPrompt, checkboxPrompt } from '@infra/utils/inquirer-prompts';
import { detectEcosystems } from '@infra/utils/detect-ecosystems';
import { runInitCommand } from '@app/commands/init';
import { ConfigLoadError } from '@core/errors';

const mockPrompt = vi.mocked(prompt);
const mockAccess = vi.mocked(access);
const mockConfirm = vi.mocked(confirmPrompt);
const mockSelect = vi.mocked(selectPrompt);
const mockCheckbox = vi.mocked(checkboxPrompt);
const mockDetectEcosystems = vi.mocked(detectEcosystems);

// ─── Non-interactive mode ─────────────────────────────────────────────────────

describe('runInitCommand — non-interactive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no ecosystems detected → fallback to all (preserves pre-detection behavior)
    mockDetectEcosystems.mockResolvedValue(new Set());
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
        outputs: { formats: ['markdown'], dir: '.security-scan/reports' },
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
        // npm language version is now routed to runners.npm.language_version, not ecosystem entry
        npmLanguageVersion: '20',
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

  it('passes inferred composer PHP version to composerRuntimeVersion in non-interactive mode', async () => {
    const { readFile } = await import('node:fs/promises');
    const mockReadFile = vi.mocked(readFile);

    mockReadFile.mockImplementation(async (path: any) => {
      const p = String(path);
      if (p.endsWith('package.json')) {
        return JSON.stringify({ engines: { node: '>=20' } }) as any;
      }
      if (p.endsWith('composer.json')) {
        return JSON.stringify({ require: { php: '^8.2' } }) as any;
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    await runInitCommand({
      cwd: '/repo',
      force: true,
      nonInteractive: true,
      projectName: 'PHP Versioned Project',
      client: 'Client',
      output: 'project-config.yml',
    });

    expect(generateConfigYaml).toHaveBeenCalledWith(
      expect.objectContaining({
        composerLanguageVersion: '8.2',
      }),
    );
  });
});

// ─── Interactive mode ─────────────────────────────────────────────────────────

describe('runInitCommand — interactive version prompts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no ecosystems detected → nothing pre-selected (checkboxPrompt mock controls selection)
    mockDetectEcosystems.mockResolvedValue(new Set());
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

    // checkboxPrompt: select all ecosystems
    mockCheckbox.mockResolvedValue(['npm', 'composer']);
    // selectPrompt: return 'en' for language prompt; first choice for everything else
    mockSelect.mockImplementation(async (msg: string, choices: any[]) => {
      if (msg.includes('Language') || msg.includes('Idioma')) return 'en';
      return choices[0].value;
    });
    // confirmPrompt: skip validation/advisors; no sonarqube; yes markdown
    mockConfirm.mockImplementation(async (msg: string) => {
      if (msg.includes('SonarQube')) return false;
      if (msg.includes('Generate markdown') || msg.includes('markdown')) return true;
      return false; // skip validation commands and advisors
    });

    // prompt: accept defaults for version and free-text
    mockPrompt.mockImplementation(async (_question: string, defaultValue?: string) => {
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
        // npm language version routed to top-level npmLanguageVersion, not ecosystem entry
        npmLanguageVersion: '20',
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
        typeof q === 'string' && q.includes('Language version') && q.includes('inferred: 20'),
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

    mockCheckbox.mockResolvedValue(['npm', 'composer']);
    mockSelect.mockImplementation(async (msg: string, choices: any[]) => {
      if (msg.includes('Language') || msg.includes('Idioma')) return 'en';
      return choices[0].value;
    });
    mockConfirm.mockResolvedValue(false);

    // User explicitly blanks out the version
    mockPrompt.mockImplementation(async (question: string, _defaultValue?: string) => {
      if (question.includes('Language version')) return '';
      return _defaultValue ?? '';
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
        // Blank response → npmLanguageVersion should be undefined
        npmLanguageVersion: undefined,
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

    // Only npm selected — composer excluded
    mockCheckbox.mockResolvedValue(['npm']);
    mockSelect.mockImplementation(async (msg: string, choices: any[]) => {
      if (msg.includes('Language') || msg.includes('Idioma')) return 'en';
      return choices[0].value;
    });
    mockConfirm.mockResolvedValue(false);

    mockPrompt.mockImplementation(async (question: string, defaultValue?: string) => {
      if (question.includes('Language version')) {
        versionPromptQuestions.push(question);
      }
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

describe('runInitCommand — interactive dockerfile image_source prompts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no ecosystems detected → nothing pre-selected (checkboxPrompt mock controls selection)
    mockDetectEcosystems.mockResolvedValue(new Set());
  });

  it('wires image_source -> dockerfile_path -> build_context -> build_args for npm/pip/composer', async () => {
    // All ecosystems selected
    mockCheckbox.mockResolvedValue(['npm', 'composer', 'pip']);
    // selectPrompt: return 'en' for language; 'dockerfile' for image source; first choice for fixer
    mockSelect.mockImplementation(async (msg: string, choices: any[]) => {
      if (msg.includes('Language') || msg.includes('Idioma')) return 'en';
      if (msg.includes('Image source') || msg.includes('Origem')) return 'dockerfile';
      return choices[0].value;
    });
    // confirmPrompt: skip validation/advisors/sonarqube; no markdown
    mockConfirm.mockResolvedValue(false);

    mockPrompt.mockImplementation(async (question: string, defaultValue?: string) => {
      // Skip version prompts
      if (question.includes('Language version') || question.includes('PHP language version') || question.includes('Python language version') || question.includes('PHP') || question.includes('Python')) return '';

      // npm dockerfile flow
      if (question.includes('[npm] Dockerfile path')) return '.docker/node.Dockerfile';
      if (question.includes('[npm] Build context')) return 'docker/';
      if (question.includes('[npm] Build args')) return 'NODE_VERSION=22,APP_ENV=production';

      // composer dockerfile flow
      if (question.includes('[Composer] Dockerfile path')) return '.docker/php.Dockerfile';
      if (question.includes('[Composer] Build context')) return '.docker/';
      if (question.includes('[Composer] Build args')) return 'PHP_VERSION=8.2,APP_ENV=production';

      // pip dockerfile flow
      if (question.includes('[pip] Dockerfile path')) return '.docker/pip.Dockerfile';
      if (question.includes('[pip] Build context')) return 'python/';
      if (question.includes('[pip] Build args')) return 'PYTHON_VERSION=3.11,PIP_INDEX_URL=https://pypi.org/simple';

      return defaultValue ?? '';
    });

    await runInitCommand({
      cwd: '/repo',
      force: true,
      projectName: 'Dockerfile Init Project',
      client: 'ACME',
      output: 'project-config.yml',
    });

    expect(generateConfigYaml).toHaveBeenCalledWith(
      expect.objectContaining({
        npmImageSource: 'dockerfile',
        npmDockerfilePath: '.docker/node.Dockerfile',
        npmBuildContext: 'docker/',
        npmBuildArgs: {
          NODE_VERSION: '22',
          APP_ENV: 'production',
        },
        pipImageSource: 'dockerfile',
        pipDockerfilePath: '.docker/pip.Dockerfile',
        pipBuildContext: 'python/',
        pipBuildArgs: {
          PYTHON_VERSION: '3.11',
          PIP_INDEX_URL: 'https://pypi.org/simple',
        },
        composerImageSource: 'dockerfile',
        composerDockerfilePath: '.docker/php.Dockerfile',
        composerBuildContext: '.docker/',
        composerBuildArgs: {
          PHP_VERSION: '8.2',
          APP_ENV: 'production',
        },
      }),
    );
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
    // Default: no ecosystems detected → fallback to all
    mockDetectEcosystems.mockResolvedValue(new Set());
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

// ─── Ecosystem detection ──────────────────────────────────────────────────────

describe('runInitCommand — ecosystem detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccess.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  });

  it('pre-selects only detected ecosystems in the checkbox prompt (interactive)', async () => {
    // Only npm detected
    mockDetectEcosystems.mockResolvedValue(new Set(['npm']));

    // checkboxPrompt: capture choices and return only npm
    let capturedChoices: Array<{ name: string; value: string; checked: boolean }> = [];
    mockCheckbox.mockImplementation(async (_msg: string, choices: any[]) => {
      capturedChoices = choices;
      return ['npm'];
    });

    mockSelect.mockImplementation(async (msg: string, choices: any[]) => {
      if (msg.includes('Language') || msg.includes('Idioma')) return 'en';
      return choices[0].value;
    });
    mockConfirm.mockImplementation(async (msg: string) => {
      if (msg.includes('SonarQube')) return false;
      if (msg.includes('Generate markdown') || msg.includes('markdown')) return true;
      return false;
    });
    mockPrompt.mockImplementation(async (_question: string, defaultValue?: string) => defaultValue ?? '');

    await runInitCommand({
      cwd: '/repo',
      force: true,
      projectName: 'Detection Project',
      client: 'Client',
      output: 'project-config.yml',
    });

    const npmChoice = capturedChoices.find((c) => c.value === 'npm');
    const composerChoice = capturedChoices.find((c) => c.value === 'composer');
    const pipChoice = capturedChoices.find((c) => c.value === 'pip');

    expect(npmChoice?.checked).toBe(true);
    expect(composerChoice?.checked).toBe(false);
    expect(pipChoice?.checked).toBe(false);
  });

  it('checkbox message includes keyboard hint text', async () => {
    mockDetectEcosystems.mockResolvedValue(new Set());

    let capturedMessage = '';
    mockCheckbox.mockImplementation(async (msg: string, choices: any[]) => {
      capturedMessage = msg;
      return choices.map((c: any) => c.value);
    });

    mockSelect.mockImplementation(async (msg: string, choices: any[]) => {
      if (msg.includes('Language') || msg.includes('Idioma')) return 'en';
      return choices[0].value;
    });
    mockConfirm.mockImplementation(async (msg: string) => {
      if (msg.includes('SonarQube')) return false;
      if (msg.includes('Generate markdown') || msg.includes('markdown')) return true;
      return false;
    });
    mockPrompt.mockImplementation(async (_question: string, defaultValue?: string) => defaultValue ?? '');

    await runInitCommand({
      cwd: '/repo',
      force: true,
      projectName: 'Hint Project',
      client: 'Client',
      output: 'project-config.yml',
    });

    expect(capturedMessage).toMatch(/Space/i);
    expect(capturedMessage).toMatch(/Enter/i);
  });

  it('non-interactive mode uses only detected ecosystems when detection finds some', async () => {
    // Only composer detected
    mockDetectEcosystems.mockResolvedValue(new Set(['composer']));

    await runInitCommand({
      cwd: '/repo',
      force: true,
      nonInteractive: true,
      projectName: 'Detected Composer',
      client: 'Client',
      output: 'project-config.yml',
    });

    const call = vi.mocked(generateConfigYaml).mock.calls[0]![0];
    expect(call.ecosystemConfigs?.map((e) => e.id)).toEqual(['composer']);
  });

  it('non-interactive mode falls back to all ecosystems when nothing is detected', async () => {
    // Nothing detected → fallback to all
    mockDetectEcosystems.mockResolvedValue(new Set());

    await runInitCommand({
      cwd: '/repo',
      force: true,
      nonInteractive: true,
      projectName: 'Fallback Project',
      client: 'Client',
      output: 'project-config.yml',
    });

    const call = vi.mocked(generateConfigYaml).mock.calls[0]![0];
    const ids = call.ecosystemConfigs?.map((e) => e.id) ?? [];
    // All three plugins should be present when nothing detected
    expect(ids).toContain('npm');
    expect(ids).toContain('composer');
    expect(ids).toContain('pip');
  });
});

// ─── SonarQube mode selection ─────────────────────────────────────────────────

describe('runInitCommand — SonarQube mode selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccess.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    mockDetectEcosystems.mockResolvedValue(new Set());
  });

  it('prompts for mode when SonarQube is enabled in interactive mode and passes managed to generateConfigYaml', async () => {
    mockCheckbox.mockResolvedValue(['npm']);
    mockConfirm.mockImplementation(async (msg: string) => {
      if (msg.includes('SonarQube')) return true;
      if (msg.includes('Generate markdown') || msg.includes('markdown')) return true;
      return false;
    });
    // selectPrompt: return 'en' for language; 'managed' for SonarQube mode; first choice for others
    mockSelect.mockImplementation(async (msg: string, choices: any[]) => {
      if (msg.includes('Language') || msg.includes('Idioma')) return 'en';
      if (msg.includes('SonarQube mode')) return 'managed';
      return choices[0].value;
    });
    mockPrompt.mockImplementation(async (_question: string, defaultValue?: string) => defaultValue ?? '');

    await runInitCommand({
      cwd: '/repo',
      force: true,
      projectName: 'Sonar Managed Project',
      client: 'Client',
      output: 'project-config.yml',
    });

    expect(mockSelect).toHaveBeenCalledWith(
      'SonarQube mode',
      expect.arrayContaining([
        expect.objectContaining({ value: 'managed' }),
        expect.objectContaining({ value: 'external' }),
      ]),
      'managed',
    );

    expect(generateConfigYaml).toHaveBeenCalledWith(
      expect.objectContaining({
        enableSonarQube: true,
        sonarQubeMode: 'managed',
      }),
    );
  });

  it('passes external mode to generateConfigYaml when user selects external', async () => {
    mockCheckbox.mockResolvedValue(['npm']);
    mockConfirm.mockImplementation(async (msg: string) => {
      if (msg.includes('SonarQube')) return true;
      if (msg.includes('Generate markdown') || msg.includes('markdown')) return true;
      return false;
    });
    // selectPrompt: return 'en' for language; 'external' for mode; first choice for everything else
    mockSelect.mockImplementation(async (msg: string, choices: any[]) => {
      if (msg.includes('Language') || msg.includes('Idioma')) return 'en';
      if (msg.includes('SonarQube mode')) return 'external';
      return choices[0].value;
    });
    mockPrompt.mockImplementation(async (_question: string, defaultValue?: string) => defaultValue ?? '');

    await runInitCommand({
      cwd: '/repo',
      force: true,
      projectName: 'Sonar External Project',
      client: 'Client',
      output: 'project-config.yml',
    });

    expect(generateConfigYaml).toHaveBeenCalledWith(
      expect.objectContaining({
        enableSonarQube: true,
        sonarQubeMode: 'external',
      }),
    );
  });

  it('does not prompt for mode when SonarQube is disabled', async () => {
    mockCheckbox.mockResolvedValue(['npm']);
    mockConfirm.mockImplementation(async (msg: string) => {
      if (msg.includes('SonarQube')) return false;
      if (msg.includes('Generate markdown') || msg.includes('markdown')) return false;
      return false;
    });

    const selectCalls: string[] = [];
    mockSelect.mockImplementation(async (msg: string, choices: any[]) => {
      selectCalls.push(msg);
      if (msg.includes('Language') || msg.includes('Idioma')) return 'en';
      return choices[0].value;
    });
    mockPrompt.mockImplementation(async (_question: string, defaultValue?: string) => defaultValue ?? '');

    await runInitCommand({
      cwd: '/repo',
      force: true,
      projectName: 'No Sonar Project',
      client: 'Client',
      output: 'project-config.yml',
    });

    expect(selectCalls.some((m) => m.includes('SonarQube mode'))).toBe(false);
    expect(generateConfigYaml).toHaveBeenCalledWith(
      expect.objectContaining({
        enableSonarQube: false,
        sonarQubeMode: 'managed',
      }),
    );
  });

  it('defaults mode to managed in non-interactive mode even when SonarQube would be enabled', async () => {
    await runInitCommand({
      cwd: '/repo',
      force: true,
      nonInteractive: true,
      projectName: 'Non-Interactive Sonar',
      client: 'Client',
      output: 'project-config.yml',
    });

    expect(generateConfigYaml).toHaveBeenCalledWith(
      expect.objectContaining({
        sonarQubeMode: 'managed',
      }),
    );

    // No select prompt should be called in non-interactive mode
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('mode select choices include descriptions mentioning ephemeral container and existing server', async () => {
    mockCheckbox.mockResolvedValue(['npm']);
    mockConfirm.mockImplementation(async (msg: string) => {
      if (msg.includes('SonarQube')) return true;
      return false;
    });

    const capturedChoices: any[] = [];
    mockSelect.mockImplementation(async (msg: string, choices: any[]) => {
      if (msg.includes('Language') || msg.includes('Idioma')) return 'en';
      if (msg.includes('SonarQube mode')) {
        capturedChoices.push(...choices);
        return 'managed';
      }
      return choices[0].value;
    });
    mockPrompt.mockImplementation(async (_question: string, defaultValue?: string) => defaultValue ?? '');

    await runInitCommand({
      cwd: '/repo',
      force: true,
      projectName: 'Choices Verify Project',
      client: 'Client',
      output: 'project-config.yml',
    });

    const managedChoice = capturedChoices.find((c: any) => c.value === 'managed');
    const externalChoice = capturedChoices.find((c: any) => c.value === 'external');

    expect(managedChoice).toBeDefined();
    expect(externalChoice).toBeDefined();
    // managed choice should mention ephemeral container
    expect(managedChoice?.name).toMatch(/ephemeral|container/i);
    // external choice should mention existing server or better performance
    expect(externalChoice?.name).toMatch(/existing|performance/i);
  });
});

// ─── i18n: language prompt and locale selection ───────────────────────────────

describe('runInitCommand — i18n', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccess.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    mockDetectEcosystems.mockResolvedValue(new Set());
  });

  it('language prompt is the FIRST selectPrompt call (before any ecosystem or project prompts)', async () => {
    mockCheckbox.mockResolvedValue([]);
    const selectCallOrder: string[] = [];
    mockSelect.mockImplementation(async (msg: string, choices: any[]) => {
      selectCallOrder.push(msg);
      if (msg.includes('Language') || msg.includes('Idioma')) return 'en';
      return choices[0].value;
    });
    mockConfirm.mockResolvedValue(false);
    mockPrompt.mockImplementation(async (_q: string, def?: string) => def ?? '');

    await runInitCommand({
      cwd: '/repo',
      force: true,
      projectName: 'Lang First Test',
      client: 'Client',
      output: 'project-config.yml',
    });

    // Language / Idioma must be the very first selectPrompt call
    expect(selectCallOrder[0]).toBe('Language / Idioma');
  });

  it('language prompt uses bilingual label "Language / Idioma"', async () => {
    mockCheckbox.mockResolvedValue([]);
    const capturedMessages: string[] = [];
    mockSelect.mockImplementation(async (msg: string, choices: any[]) => {
      capturedMessages.push(msg);
      if (msg.includes('Language') || msg.includes('Idioma')) return 'en';
      return choices[0].value;
    });
    mockConfirm.mockResolvedValue(false);
    mockPrompt.mockImplementation(async (_q: string, def?: string) => def ?? '');

    await runInitCommand({
      cwd: '/repo',
      force: true,
      projectName: 'Bilingual Label Test',
      client: 'Client',
      output: 'project-config.yml',
    });

    expect(capturedMessages).toContain('Language / Idioma');
  });

  it('language prompt choices are "English (en)" and "Português (pt-br)"', async () => {
    mockCheckbox.mockResolvedValue([]);
    let capturedChoices: Array<{ name: string; value: string }> = [];
    mockSelect.mockImplementation(async (msg: string, choices: any[]) => {
      if (msg === 'Language / Idioma') {
        capturedChoices = choices;
        return 'en';
      }
      return choices[0].value;
    });
    mockConfirm.mockResolvedValue(false);
    mockPrompt.mockImplementation(async (_q: string, def?: string) => def ?? '');

    await runInitCommand({
      cwd: '/repo',
      force: true,
      projectName: 'Choices Test',
      client: 'Client',
      output: 'project-config.yml',
    });

    expect(capturedChoices.some((c) => c.value === 'en' && c.name === 'English (en)')).toBe(true);
    expect(capturedChoices.some((c) => c.value === 'pt-br' && c.name === 'Português (pt-br)')).toBe(true);
  });

  it('uses EN strings when language "en" is selected', async () => {
    mockCheckbox.mockResolvedValue([]);
    const confirmMessages: string[] = [];
    mockSelect.mockImplementation(async (msg: string, choices: any[]) => {
      if (msg === 'Language / Idioma') return 'en';
      return choices[0].value;
    });
    mockConfirm.mockImplementation(async (msg: string) => {
      confirmMessages.push(msg);
      return false;
    });
    mockPrompt.mockImplementation(async (_q: string, def?: string) => def ?? '');

    await runInitCommand({
      cwd: '/repo',
      force: true,
      projectName: 'EN Strings Test',
      client: 'Client',
      output: 'project-config.yml',
    });

    // EN locale: enableSonarQubePrompt is 'Enable SonarQube scanner?'
    expect(confirmMessages.some((m) => m.includes('Enable SonarQube scanner?'))).toBe(true);
  });

  it('uses PT-BR strings when language "pt-br" is selected', async () => {
    mockCheckbox.mockResolvedValue([]);
    const confirmMessages: string[] = [];
    mockSelect.mockImplementation(async (msg: string, choices: any[]) => {
      if (msg === 'Language / Idioma') return 'pt-br';
      return choices[0].value;
    });
    mockConfirm.mockImplementation(async (msg: string) => {
      confirmMessages.push(msg);
      return false;
    });
    mockPrompt.mockImplementation(async (_q: string, def?: string) => def ?? '');

    await runInitCommand({
      cwd: '/repo',
      force: true,
      projectName: 'PT-BR Strings Test',
      client: 'Client',
      output: 'project-config.yml',
    });

    // PT-BR locale: enableSonarQubePrompt is 'Habilitar scanner SonarQube?'
    expect(confirmMessages.some((m) => m.includes('Habilitar scanner SonarQube?'))).toBe(true);
  });

  it('non-interactive mode defaults language via resolveDefaultLocale() — no selectPrompt called', async () => {
    await runInitCommand({
      cwd: '/repo',
      force: true,
      nonInteractive: true,
      projectName: 'Non-interactive i18n test',
      client: 'Client',
      output: 'project-config.yml',
    });

    // No selectPrompt should be called in non-interactive mode
    expect(mockSelect).not.toHaveBeenCalled();
    // generateConfigYaml should have been called with a valid reportLanguage
    expect(generateConfigYaml).toHaveBeenCalledWith(
      expect.objectContaining({
        reportLanguage: expect.stringMatching(/^(en|pt-br)$/),
      }),
    );
  });

  it('selected language is passed to generateConfigYaml as reportLanguage (backward compat)', async () => {
    mockCheckbox.mockResolvedValue([]);
    mockSelect.mockImplementation(async (msg: string, choices: any[]) => {
      if (msg === 'Language / Idioma') return 'pt-br';
      return choices[0].value;
    });
    mockConfirm.mockResolvedValue(false);
    mockPrompt.mockImplementation(async (_q: string, def?: string) => def ?? '');

    await runInitCommand({
      cwd: '/repo',
      force: true,
      projectName: 'Backward Compat Test',
      client: 'Client',
      output: 'project-config.yml',
    });

    expect(generateConfigYaml).toHaveBeenCalledWith(
      expect.objectContaining({ reportLanguage: 'pt-br' }),
    );
  });

  it('old "Report language" selectPrompt is no longer called', async () => {
    mockCheckbox.mockResolvedValue([]);
    const selectMessages: string[] = [];
    mockSelect.mockImplementation(async (msg: string, choices: any[]) => {
      selectMessages.push(msg);
      if (msg === 'Language / Idioma') return 'en';
      return choices[0].value;
    });
    mockConfirm.mockResolvedValue(false);
    mockPrompt.mockImplementation(async (_q: string, def?: string) => def ?? '');

    await runInitCommand({
      cwd: '/repo',
      force: true,
      projectName: 'No Old Prompt Test',
      client: 'Client',
      output: 'project-config.yml',
    });

    expect(selectMessages.some((m) => m === 'Report language')).toBe(false);
  });
});
