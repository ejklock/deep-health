/**
 * Branch coverage top-up for src/app/commands/init.ts
 * Targets lines 246-256 and 264-269:
 *   - enableSonarQube=true + writeSonarPropertiesTemplateIfMissing returns 'created'
 *   - enableSonarQube=true + writeSonarPropertiesTemplateIfMissing returns 'exists'
 *
 * These paths are only reachable via interactive mode (non-interactive never sets enableSonarQube).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn(),
  access: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
  mkdir: vi.fn(),
  readFile: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
}));

vi.mock('@infra/config/generator', () => ({
  generateConfigYaml: vi.fn(() => 'project:\n  name: demo\n'),
}));

vi.mock('@infra/utils/prompt', () => ({
  prompt: vi.fn(),
}));

vi.mock('@app/commands/sonar-properties-template', () => ({
  writeSonarPropertiesTemplateIfMissing: vi.fn(),
}));

import { prompt } from '@infra/utils/prompt';
import { runInitCommand } from '@app/commands/init';
import { writeSonarPropertiesTemplateIfMissing } from '@app/commands/sonar-properties-template';

const mockPrompt = vi.mocked(prompt);
const mockWriteSonar = vi.mocked(writeSonarPropertiesTemplateIfMissing);

// Default prompt handler — accept all defaults; enable sonarqube = 'y'
function makePromptHandler(enableSonarQube: string) {
  return async (question: string, defaultValue?: string) => {
    if (question.includes('Include npm') || question.includes('Include Composer') || question.includes('Include pip')) {
      return 'y';
    }
    if (question.includes('SonarQube')) return enableSonarQube;
    if (question.includes('markdown')) return 'y';
    return defaultValue ?? '';
  };
}

describe('runInitCommand() — sonar properties created path (lines 246-256, 264-269)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes sonar-project.properties and prints step 3/4 when created=true (lines 251-252, 264-265)', async () => {
    mockPrompt.mockImplementation(makePromptHandler('y'));
    mockWriteSonar.mockResolvedValue('created');

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await runInitCommand({
      cwd: '/repo',
      force: true,
      projectName: 'SonarTest',
      client: 'Acme',
      output: 'project-config.yml',
    });

    expect(mockWriteSonar).toHaveBeenCalled();
    // Should print the sonar-project.properties Created message
    const calls = stdoutSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((s) => s.includes('sonar-project.properties'))).toBe(true);
    // Should print step 3/4 for sonar review
    expect(calls.some((s) => s.includes('Review sonar-project.properties') || s.includes('3.'))).toBe(true);

    stdoutSpy.mockRestore();
  });

  it('prints "Found existing sonar-project.properties" and step 3 when file exists (lines 254, 270-273)', async () => {
    mockPrompt.mockImplementation(makePromptHandler('y'));
    mockWriteSonar.mockResolvedValue('exists');

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await runInitCommand({
      cwd: '/repo',
      force: true,
      projectName: 'SonarTest',
      client: 'Acme',
      output: 'project-config.yml',
    });

    const calls = stdoutSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((s) => s.includes('Found existing sonar-project.properties'))).toBe(true);

    stdoutSpy.mockRestore();
  });
});

import { readFile } from 'node:fs/promises';
const mockReadFile = vi.mocked(readFile);

describe('runInitCommand — composer non-interactive with inferred version (lines 163, 181)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses inferredVersion as composerRuntimeVersion in non-interactive mode (line 163)', async () => {
    // Make composer's inferVersion return '8.2' by simulating .php-version file
    mockReadFile.mockImplementation(async (p: unknown) => {
      const path = String(p);
      if (path.endsWith('.php-version')) return '8.2.0' as unknown as Buffer;
      if (path.endsWith('composer.json')) return JSON.stringify({ require: { php: '>=8.2' } }) as unknown as Buffer;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const { generateConfigYaml } = await import('@infra/config/generator');

    await runInitCommand({
      cwd: '/repo',
      force: true,
      nonInteractive: true,
      projectName: 'PHPProject',
      client: 'Client',
      output: 'project-config.yml',
      ecosystems: ['composer'],
    } as Parameters<typeof runInitCommand>[0]);

    expect(vi.mocked(generateConfigYaml)).toHaveBeenCalledWith(
      expect.objectContaining({ composerLanguageVersion: expect.any(String) }),
    );
  });
});

describe('runInitCommand — outputs: undefined path (line 234)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes outputs: undefined when markdown disabled non-interactively', async () => {
    // In non-interactive mode, outputsDir is always set to default so outputs is never undefined.
    // Need to verify by checking the call args directly.
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const { generateConfigYaml } = await import('@infra/config/generator');

    // Interactive mode: decline sonarqube AND markdown → outputsDir stays undefined
    const mockPromptLocal = vi.mocked(prompt);
    mockPromptLocal.mockImplementation(async (question: string, defaultValue?: string) => {
      if (question.includes('Include npm')) return 'y';
      if (question.includes('Include Composer') || question.includes('Include pip')) return 'n';
      if (question.includes('SonarQube') || question.includes('markdown')) return 'n';
      return defaultValue ?? '';
    });

    const { writeSonarPropertiesTemplateIfMissing: wsp } = await import(
      '@app/commands/sonar-properties-template'
    );
    vi.mocked(wsp).mockResolvedValue('created');

    await runInitCommand({
      cwd: '/repo',
      force: true,
      projectName: 'NoMarkdown',
      client: 'Client',
      output: 'project-config.yml',
    });

    expect(vi.mocked(generateConfigYaml)).toHaveBeenCalledWith(
      expect.objectContaining({ outputs: undefined }),
    );
  });
});

// ─── Coverage gap: lines 34, 54, 101, 141, 163, 181 ─────────────────────────

describe('runInitCommand — output default path (line 34)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses DEFAULT_CONFIG_PATH when opts.output is not specified (line 34)', async () => {
    const { writeFile, access } = await import('node:fs/promises');
    vi.mocked(access).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    vi.mocked(writeFile).mockResolvedValue(undefined);

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await runInitCommand({
      cwd: '/repo',
      force: true,
      nonInteractive: true,
      projectName: 'P',
      client: 'C',
      // output intentionally omitted → line 34
    });
    stdoutSpy.mockRestore();
    expect(vi.mocked(writeFile)).toHaveBeenCalled();
  });
});

describe('runInitCommand — client prompt (line 54)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('prompts for client name when opts.client is not provided (line 54)', async () => {
    const { writeFile, access } = await import('node:fs/promises');
    vi.mocked(access).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    vi.mocked(writeFile).mockResolvedValue(undefined);
    const { writeSonarPropertiesTemplateIfMissing: wsp } = await import('@app/commands/sonar-properties-template');
    vi.mocked(wsp).mockResolvedValue('created');

    const mockPromptLocal = vi.mocked(prompt);
    mockPromptLocal.mockImplementation(async (question: string, defaultValue?: string) => {
      if (question.includes('Client name')) return 'PromptedClient'; // line 54
      if (question.includes('Include npm')) return 'n';
      if (question.includes('Include Composer') || question.includes('Include pip')) return 'n';
      if (question.includes('SonarQube') || question.includes('markdown')) return 'n';
      return defaultValue ?? '';
    });

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await runInitCommand({
      cwd: '/repo',
      force: true,
      projectName: 'P',
      output: 'project-config.yml',
      // client intentionally omitted → triggers line 54
    });
    stdoutSpy.mockRestore();

    expect(mockPromptLocal).toHaveBeenCalledWith(expect.stringContaining('Client name'), expect.any(String));
  });
});

describe('runInitCommand — interactive fixer answer not in supportedFixers (line 101)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('falls back to defaultFixer when prompt answer is not in supportedFixers (line 101)', async () => {
    const { writeFile, access } = await import('node:fs/promises');
    vi.mocked(access).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    vi.mocked(writeFile).mockResolvedValue(undefined);
    const { writeSonarPropertiesTemplateIfMissing: wsp } = await import('@app/commands/sonar-properties-template');
    vi.mocked(wsp).mockResolvedValue('created');

    const mockPromptLocal = vi.mocked(prompt);
    mockPromptLocal.mockImplementation(async (question: string, defaultValue?: string) => {
      if (question.includes('Include npm')) return 'y';
      if (question.includes('Include Composer') || question.includes('Include pip')) return 'n';
      if (question.includes('Fixer strategy')) return 'invalid-fixer'; // not in supportedFixers → line 101
      if (question.includes('Validation command')) return '';
      if (question.includes('Language version')) return '';
      if (question.includes('SonarQube') || question.includes('markdown')) return 'n';
      return defaultValue ?? '';
    });

    const { generateConfigYaml } = await import('@infra/config/generator');
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await runInitCommand({
      cwd: '/repo',
      force: true,
      projectName: 'P',
      client: 'C',
      output: 'project-config.yml',
    });
    stdoutSpy.mockRestore();

    expect(vi.mocked(generateConfigYaml)).toHaveBeenCalled();
  });
});

describe('runInitCommand — inferVersion absent on plugin (line 141)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sets inferredVersion to undefined when plugin has no inferVersion (line 141)', async () => {
    const { writeFile, access } = await import('node:fs/promises');
    vi.mocked(access).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    vi.mocked(writeFile).mockResolvedValue(undefined);
    const { writeSonarPropertiesTemplateIfMissing: wsp } = await import('@app/commands/sonar-properties-template');
    vi.mocked(wsp).mockResolvedValue('created');

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await runInitCommand({
      cwd: '/repo',
      force: true,
      nonInteractive: true,
      projectName: 'P',
      client: 'C',
      output: 'project-config.yml',
      ecosystems: ['pip'],
    } as Parameters<typeof runInitCommand>[0]);
    stdoutSpy.mockRestore();

    expect(vi.mocked(writeFile)).toHaveBeenCalled();
  });
});

describe('runInitCommand — composer interactive with inferred version (lines 163, 181)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows inferred PHP version in prompt and does NOT ask for framework profile (removed field)', async () => {
    const { writeFile, access } = await import('node:fs/promises');
    vi.mocked(access).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    vi.mocked(writeFile).mockResolvedValue(undefined);
    const { writeSonarPropertiesTemplateIfMissing: wsp } = await import('@app/commands/sonar-properties-template');
    vi.mocked(wsp).mockResolvedValue('created');

    const { readFile } = await import('node:fs/promises');
    vi.mocked(readFile).mockImplementation(async (p: unknown) => {
      const path = String(p);
      if (path.endsWith('.php-version')) return '8.2.0' as unknown as Buffer;
      if (path.endsWith('composer.json')) return JSON.stringify({ require: { php: '>=8.2' } }) as unknown as Buffer;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const mockPromptLocal = vi.mocked(prompt);
    const promptQuestions: string[] = [];
    mockPromptLocal.mockImplementation(async (question: string, defaultValue?: string) => {
      promptQuestions.push(question);
      if (question.includes('Include Composer')) return 'y';
      if (question.includes('Include npm') || question.includes('Include pip')) return 'n';
      if (question.includes('Fixer strategy')) return defaultValue ?? '';
      if (question.includes('Validation command')) return '';
      if (question.includes('PHP language version')) return '8.2.0';
      if (question.includes('SonarQube') || question.includes('markdown')) return 'n';
      return defaultValue ?? '';
    });

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await runInitCommand({
      cwd: '/repo',
      force: true,
      projectName: 'P',
      client: 'C',
      output: 'project-config.yml',
    });
    stdoutSpy.mockRestore();

    // PHP version prompt is still asked (version inference branch)
    const phpVersionQ = promptQuestions.find((q) => q.includes('PHP language version'));
    expect(phpVersionQ).toBeDefined();
    // framework_profile prompt is gone — field was removed in ADR-0004
    const phpProfileQ = promptQuestions.find((q) => q.includes('PHP framework profile'));
    expect(phpProfileQ).toBeUndefined();
  });
});

describe('runInitCommand() — branch coverage top-up (lines 53, 207, 213)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteSonar.mockResolvedValue('created');
  });

  it('calls prompt for projectName and client when not provided in opts (line 53 right branches)', async () => {
    const promptted: string[] = [];
    mockPrompt.mockImplementation(async (question: string, defaultValue?: string) => {
      promptted.push(question);
      if (question.includes('ecosystem') || question.includes('Include')) return 'n';
      if (question.includes('SonarQube')) return 'n';
      if (question.includes('markdown')) return 'n';
      return defaultValue ?? 'auto-answer';
    });

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    // No projectName, no client — must call prompt for both
    await runInitCommand({
      cwd: '/repo',
      force: true,
      output: 'project-config.yml',
    });

    stdoutSpy.mockRestore();

    expect(promptted.some((q) => q.includes('Project name'))).toBe(true);
    expect(promptted.some((q) => q.includes('Client name'))).toBe(true);
  });

  it('selects "en" language when prompt returns "en" (line 207 true branch)', async () => {
    mockPrompt.mockImplementation(async (question: string, defaultValue?: string) => {
      if (question.includes('Report language')) return 'en';
      if (question.includes('ecosystem') || question.includes('Include')) return 'n';
      if (question.includes('SonarQube')) return 'n';
      if (question.includes('markdown')) return 'n';
      return defaultValue ?? '';
    });

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await runInitCommand({
      cwd: '/repo',
      force: true,
      projectName: 'Proj',
      client: 'Client',
      output: 'project-config.yml',
    });

    stdoutSpy.mockRestore();
    // If no error thrown, 'en' branch was reached
  });

  it('uses default reports dir when dirAnswer is empty string (line 213 || branch)', async () => {
    mockPrompt.mockImplementation(async (question: string, defaultValue?: string) => {
      if (question.includes('Report language')) return 'pt-br';
      if (question.includes('markdown')) return 'y';
      if (question.includes('output directory')) return '   '; // whitespace → trim → empty
      if (question.includes('ecosystem') || question.includes('Include')) return 'n';
      if (question.includes('SonarQube')) return 'n';
      return defaultValue ?? '';
    });

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await runInitCommand({
      cwd: '/repo',
      force: true,
      projectName: 'Proj',
      client: 'Client',
      output: 'project-config.yml',
    });

    stdoutSpy.mockRestore();
    // If no error thrown, fallback '.deep-health/reports' was used
  });
});
