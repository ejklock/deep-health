/**
 * Branch coverage top-up for src/app/commands/init.ts
 * Updated for the @inquirer/prompts-based interactive API (checkboxPrompt /
 * selectPrompt / confirmPrompt). All interactive tests mock the
 * @infra/utils/inquirer-prompts seam; nonInteractive tests remain unchanged.
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

vi.mock('@infra/utils/inquirer-prompts', () => ({
  confirmPrompt: vi.fn(),
  selectPrompt: vi.fn(),
  checkboxPrompt: vi.fn(),
}));

vi.mock('@app/commands/sonar-properties-template', () => ({
  writeSonarPropertiesTemplateIfMissing: vi.fn(),
}));

import { prompt } from '@infra/utils/prompt';
import { confirmPrompt, selectPrompt, checkboxPrompt } from '@infra/utils/inquirer-prompts';
import { generateConfigYaml } from '@infra/config/generator';
import { runInitCommand } from '@app/commands/init';
import { writeSonarPropertiesTemplateIfMissing } from '@app/commands/sonar-properties-template';

const mockPrompt = vi.mocked(prompt);
const mockConfirm = vi.mocked(confirmPrompt);
const mockSelect = vi.mocked(selectPrompt);
const mockCheckbox = vi.mocked(checkboxPrompt);
const mockWriteSonar = vi.mocked(writeSonarPropertiesTemplateIfMissing);

/**
 * Standard interactive setup helper.
 * - ecosystems: what checkboxPrompt returns
 * - sonar: confirmPrompt response when msg includes 'SonarQube'
 * - markdown: confirmPrompt response when msg includes 'Generate markdown' or 'markdown'
 * All other confirms (validation commands, advisors) return false.
 * selectPrompt always returns 'en' for the language prompt, and first choice for all others.
 */
function setupInteractiveMocks({
  sonar = false,
  markdown = true,
  ecosystems = ['npm', 'composer', 'pip'],
}: { sonar?: boolean; markdown?: boolean; ecosystems?: string[] } = {}) {
  mockCheckbox.mockResolvedValue(ecosystems as ReturnType<typeof mockCheckbox.mock.results[0]['value']> extends Promise<infer U> ? U : never);
  mockSelect.mockImplementation((msg: string, choices: Array<{ name: string; value: string }>) => {
    // Language / Idioma is always the first prompt — return 'en' so subsequent EN strings work
    if (msg.includes('Language') || msg.includes('Idioma')) return Promise.resolve('en');
    return Promise.resolve(choices[0].value);
  });
  mockConfirm.mockImplementation((msg: string) => {
    if (msg.includes('SonarQube')) return Promise.resolve(sonar);
    if (msg.includes('Generate markdown') || msg.includes('markdown')) return Promise.resolve(markdown);
    return Promise.resolve(false); // decline validation commands, advisors
  });
  mockPrompt.mockImplementation((_q: string, def?: string) => Promise.resolve(def ?? ''));
}

// ─── Sonar properties path ────────────────────────────────────────────────────

describe('runInitCommand() — sonar properties created path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes sonar-project.properties and prints step 3/4 when created=true', async () => {
    setupInteractiveMocks({ sonar: true, markdown: false });
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
    const calls = stdoutSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((s) => s.includes('sonar-project.properties'))).toBe(true);
    expect(calls.some((s) => s.includes('Review sonar-project.properties') || s.includes('3.'))).toBe(true);

    stdoutSpy.mockRestore();
  });

  it('prints "Found existing sonar-project.properties" and step 3 when file exists', async () => {
    setupInteractiveMocks({ sonar: true, markdown: false });
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

// ─── readFile mock shared by several describe blocks ─────────────────────────

import { readFile } from 'node:fs/promises';
const mockReadFile = vi.mocked(readFile);

// ─── Non-interactive: composer with inferred version ──────────────────────────

describe('runInitCommand — composer non-interactive with inferred version', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses inferredVersion as composerRuntimeVersion in non-interactive mode', async () => {
    mockReadFile.mockImplementation(async (p: unknown) => {
      const path = String(p);
      if (path.endsWith('.php-version')) return '8.2.0' as unknown as Buffer;
      if (path.endsWith('composer.json')) return JSON.stringify({ require: { php: '>=8.2' } }) as unknown as Buffer;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

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

// ─── outputs: undefined when markdown disabled ────────────────────────────────

describe('runInitCommand — outputs: undefined path', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes outputs: undefined when markdown disabled', async () => {
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    mockCheckbox.mockResolvedValue(['npm']);
    mockSelect.mockImplementation((msg: string, c: Array<{ name: string; value: string }>) => {
      if (msg.includes('Language') || msg.includes('Idioma')) return Promise.resolve('en');
      return Promise.resolve(c[0].value);
    });
    mockConfirm.mockResolvedValue(false); // declines SonarQube AND 'Generate markdown'
    mockPrompt.mockImplementation((_q: string, def?: string) => Promise.resolve(def ?? ''));

    mockWriteSonar.mockResolvedValue('created');

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

// ─── Output default path (non-interactive) ────────────────────────────────────

describe('runInitCommand — output default path', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses DEFAULT_CONFIG_PATH when opts.output is not specified', async () => {
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
      // output intentionally omitted → DEFAULT_CONFIG_PATH
    });
    stdoutSpy.mockRestore();
    expect(vi.mocked(writeFile)).toHaveBeenCalled();
  });
});

// ─── Client prompt ────────────────────────────────────────────────────────────

describe('runInitCommand — client prompt', () => {
  beforeEach(() => vi.clearAllMocks());

  it('prompts for client name when opts.client is not provided', async () => {
    const { writeFile, access } = await import('node:fs/promises');
    vi.mocked(access).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    vi.mocked(writeFile).mockResolvedValue(undefined);
    mockWriteSonar.mockResolvedValue('created');

    // Ecosystem/fixer/image source handled by inquirer mocks (no ecosystems selected → loop skipped)
    mockCheckbox.mockResolvedValue([]);
    mockSelect.mockImplementation((msg: string, c: Array<{ name: string; value: string }>) => {
      if (msg.includes('Language') || msg.includes('Idioma')) return Promise.resolve('en');
      return Promise.resolve(c[0].value);
    });
    mockConfirm.mockResolvedValue(false);

    const mockPromptLocal = vi.mocked(prompt);
    mockPromptLocal.mockImplementation(async (question: string, defaultValue?: string) => {
      // EN locale uses 'Client name'
      if (question.includes('Client name') || question.includes('Nome do cliente')) return 'PromptedClient';
      return defaultValue ?? '';
    });

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await runInitCommand({
      cwd: '/repo',
      force: true,
      projectName: 'P',
      output: 'project-config.yml',
      // client intentionally omitted → triggers prompt
    });
    stdoutSpy.mockRestore();

    expect(mockPromptLocal).toHaveBeenCalledWith(
      expect.stringMatching(/Client name|Nome do cliente/),
      expect.any(String),
    );
  });
});

// ─── Fixer strategy via selectPrompt (replaces obsolete invalid-fixer test) ───

describe('runInitCommand — fixer strategy via selectPrompt', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls selectPrompt for fixer strategy with plugin.supportedFixers as choices', async () => {
    const { writeFile, access } = await import('node:fs/promises');
    vi.mocked(access).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    vi.mocked(writeFile).mockResolvedValue(undefined);
    mockWriteSonar.mockResolvedValue('created');

    mockCheckbox.mockResolvedValue(['npm']);
    mockSelect.mockImplementation((msg: string, c: Array<{ name: string; value: string }>) => {
      if (msg.includes('Language') || msg.includes('Idioma')) return Promise.resolve('en');
      return Promise.resolve(c[0].value);
    });
    mockConfirm.mockResolvedValue(false);
    mockPrompt.mockImplementation((_q: string, def?: string) => Promise.resolve(def ?? ''));

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await runInitCommand({
      cwd: '/repo',
      force: true,
      projectName: 'P',
      client: 'C',
      output: 'project-config.yml',
    });
    stdoutSpy.mockRestore();

    // selectPrompt must have been called with a message containing 'Fixer strategy' (EN locale)
    const fixerCall = mockSelect.mock.calls.find(([msg]) =>
      typeof msg === 'string' && msg.includes('Fixer strategy'),
    );
    expect(fixerCall).toBeDefined();

    // Choices must include npm's supported fixers: ['osv', 'npm-audit', 'osv-then-audit']
    const choices = fixerCall![1] as Array<{ name: string; value: string }>;
    expect(choices.map((c) => c.value)).toEqual(
      expect.arrayContaining(['osv', 'npm-audit', 'osv-then-audit']),
    );
    expect(vi.mocked(generateConfigYaml)).toHaveBeenCalled();
  });
});

// ─── Non-interactive: inferVersion absent ─────────────────────────────────────

describe('runInitCommand — inferVersion absent on plugin', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sets inferredVersion to undefined when plugin has no inferVersion', async () => {
    const { writeFile, access } = await import('node:fs/promises');
    vi.mocked(access).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    vi.mocked(writeFile).mockResolvedValue(undefined);
    mockWriteSonar.mockResolvedValue('created');

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

// ─── Interactive: composer inferred version ───────────────────────────────────

describe('runInitCommand — composer interactive with inferred version', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows inferred PHP version in prompt and does NOT ask for framework profile (removed field)', async () => {
    const { writeFile, access } = await import('node:fs/promises');
    vi.mocked(access).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    vi.mocked(writeFile).mockResolvedValue(undefined);
    mockWriteSonar.mockResolvedValue('created');

    const { readFile: rf } = await import('node:fs/promises');
    vi.mocked(rf).mockImplementation(async (p: unknown) => {
      const path = String(p);
      if (path.endsWith('.php-version')) return '8.2.0' as unknown as Buffer;
      if (path.endsWith('composer.json')) return JSON.stringify({ require: { php: '>=8.2' } }) as unknown as Buffer;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    // Only composer selected — no npm/pip loop overhead
    mockCheckbox.mockResolvedValue(['composer']);
    mockSelect.mockImplementation((msg: string, c: Array<{ name: string; value: string }>) => {
      if (msg.includes('Language') || msg.includes('Idioma')) return Promise.resolve('en');
      return Promise.resolve(c[0].value);
    });
    mockConfirm.mockResolvedValue(false); // skip validation/advisors/sonar/markdown

    const mockPromptLocal = vi.mocked(prompt);
    const promptQuestions: string[] = [];
    mockPromptLocal.mockImplementation(async (question: string, defaultValue?: string) => {
      promptQuestions.push(question);
      if (question.includes('PHP language version')) return '8.2.0';
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

// ─── Branch coverage top-up ───────────────────────────────────────────────────

describe('runInitCommand() — branch coverage top-up', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteSonar.mockResolvedValue('created');
  });

  it('calls prompt for projectName and client when not provided in opts', async () => {
    const promptted: string[] = [];

    // No ecosystems selected — skips per-ecosystem loop entirely
    mockCheckbox.mockResolvedValue([]);
    mockSelect.mockImplementation((msg: string, c: Array<{ name: string; value: string }>) => {
      if (msg.includes('Language') || msg.includes('Idioma')) return Promise.resolve('en');
      return Promise.resolve(c[0].value);
    });
    mockConfirm.mockResolvedValue(false);

    mockPrompt.mockImplementation(async (question: string, defaultValue?: string) => {
      promptted.push(question);
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

    // EN locale: 'Project name' and 'Client name'
    expect(promptted.some((q) => q.includes('Project name') || q.includes('Nome do projeto'))).toBe(true);
    expect(promptted.some((q) => q.includes('Client name') || q.includes('Nome do cliente'))).toBe(true);
  });

  it('selectPrompt called with "Language / Idioma" first; generateConfigYaml called with reportLanguage: en', async () => {
    setupInteractiveMocks();
    mockCheckbox.mockResolvedValue([]);
    mockSelect.mockImplementation(async (msg: string, choices: Array<{ name: string; value: string }>) => {
      if (msg === 'Language / Idioma') return 'en';
      return choices[0].value;
    });
    mockConfirm.mockResolvedValue(false);
    mockPrompt.mockImplementation((_q: string, def?: string) => Promise.resolve(def ?? ''));

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await runInitCommand({
      cwd: '/repo',
      force: true,
      projectName: 'Proj',
      client: 'Client',
      output: 'project-config.yml',
    });

    stdoutSpy.mockRestore();

    expect(vi.mocked(generateConfigYaml)).toHaveBeenCalledWith(
      expect.objectContaining({ reportLanguage: 'en' }),
    );
  });

  it('uses default reports dir when dirAnswer is empty string (line 213 || branch)', async () => {
    mockCheckbox.mockResolvedValue([]);
    mockSelect.mockImplementation((msg: string, c: Array<{ name: string; value: string }>) => {
      if (msg.includes('Language') || msg.includes('Idioma')) return Promise.resolve('en');
      return Promise.resolve(c[0].value);
    });
    mockConfirm.mockImplementation((msg: string) => {
      if (msg.includes('Generate markdown') || msg.includes('markdown')) return Promise.resolve(true);
      return Promise.resolve(false); // decline SonarQube and others
    });
    mockPrompt.mockImplementation(async (question: string, defaultValue?: string) => {
      if (question.includes('output directory') || question.includes('saída')) return '   '; // whitespace → trim → empty → fallback
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
