/**
 * Branch coverage for resolveCliVersion line 59 true branch:
 * pkg.version IS a string → returns it.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('node:module', () => ({
  createRequire: vi.fn(() => (_path: string) => ({ version: '1.2.3' })),
}));

import { resolveCliVersion } from '@app/audit-trail';

describe('resolveCliVersion — string version path (line 59 true branch)', () => {
  it('returns the version string when pkg.version is a string', async () => {
    const version = await resolveCliVersion();
    expect(version).toBe('1.2.3');
  });
});
