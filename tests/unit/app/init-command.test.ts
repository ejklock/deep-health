import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn(),
  access: vi.fn().mockRejectedValue(new Error('not found')),
  mkdir: vi.fn(),
}));

vi.mock('@infra/config/generator', () => ({
  generateConfigYaml: vi.fn(() => 'project:\n  name: demo\n'),
}));

vi.mock('@infra/utils/prompt', () => ({
  prompt: vi.fn(),
}));

import { writeFile, mkdir } from 'node:fs/promises';
import { generateConfigYaml } from '@infra/config/generator';
import { runInitCommand } from '@app/commands/init';

describe('runInitCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('generates declarative config via ecosystemConfigs in non-interactive mode', async () => {
    await runInitCommand({
      execution: 'local',
      dockerService: 'app',
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
});
