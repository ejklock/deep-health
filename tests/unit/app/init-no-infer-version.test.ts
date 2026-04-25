/**
 * Coverage top-up for init.ts line 141:
 *  - plugin.inferVersion is falsy → the `: undefined` branch fires
 *
 * Requires mocking @modules/ecosystem/index to return a plugin without inferVersion.
 */
import { describe, it, expect, vi } from 'vitest';

const mockPlugin = {
  id: 'npm',
  name: 'NPM',
  supportedFixers: ['osv'],
  defaultValidationCommands: [],
  defaultAdvisors: [],
  // intentionally no inferVersion
};

vi.mock('@modules/ecosystem/index.js', () => ({
  defaultRegistry: {
    getAll: () => [mockPlugin],
    get: (id: string) => id === 'npm' ? mockPlugin : undefined,
  },
}));

vi.mock('@infra/config/generator.js', () => ({
  generateConfigYaml: vi.fn().mockReturnValue('config: yaml'),
}));

vi.mock('@infra/utils/prompt.js', () => ({
  prompt: vi.fn().mockResolvedValue(''),
}));

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@app/commands/sonar-properties-template.js', () => ({
  writeSonarPropertiesTemplateIfMissing: vi.fn().mockResolvedValue(undefined),
}));

import { runInitCommand } from '@app/commands/init';
import { prompt } from '@infra/utils/prompt.js';

describe('init.ts line 141 — plugin without inferVersion uses undefined (: undefined branch)', () => {
  it('runs successfully when a plugin has no inferVersion method', async () => {
    const mockPrompt = prompt as ReturnType<typeof vi.fn>;
    // Answer prompts: project name, client, include npm (y), fixer (blank→default), osv scanner runner, etc.
    mockPrompt.mockResolvedValue('');

    await expect(
      runInitCommand({
        cwd: '/project',
        force: true,
        nonInteractive: true,
        projectName: 'TestProject',
        client: 'TestClient',
        output: '/project/project-config.yml',
      }),
    ).resolves.not.toThrow();
  });
});
