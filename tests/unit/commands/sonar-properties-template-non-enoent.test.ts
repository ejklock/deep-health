/**
 * Branch coverage for writeSonarPropertiesTemplateIfMissing line 111:
 * re-throws non-ENOENT errors from `access`.
 *
 * This is a separate file because vi.spyOn cannot override named imports
 * in the main test file (property non-configurable after hoisting).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({
  access: vi.fn().mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' })),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
  chmod: vi.fn(),
}));

import { writeSonarPropertiesTemplateIfMissing } from '@app/commands/sonar-properties-template';

describe('writeSonarPropertiesTemplateIfMissing — non-ENOENT re-throw (line 111)', () => {
  it('re-throws when access throws a non-ENOENT error', async () => {
    await expect(
      writeSonarPropertiesTemplateIfMissing('/some/dir', { projectName: 'test', ecosystemIds: [] }),
    ).rejects.toThrow('EACCES');
  });
});
