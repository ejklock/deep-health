/**
 * Branch coverage for resolveCliVersion line 59:
 * - pkg.version is a string → returns it (left branch)
 * - pkg.version is not a string → returns 'unknown' (right branch)
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('node:module', () => ({
  createRequire: vi.fn(() => (_path: string) => ({ version: 42 })),
}));

import { resolveCliVersion } from '@app/audit-trail';

describe('resolveCliVersion — non-string version fallback (line 59 false branch)', () => {
  it('returns "unknown" when pkg.version is not a string', async () => {
    const version = await resolveCliVersion();
    expect(version).toBe('unknown');
  });
});
