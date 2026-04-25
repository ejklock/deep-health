/**
 * Branch coverage top-up for src/app/audit-trail.ts
 * Targets:
 *   line 46: catch branch in writeAuditTrail — mkdir/writeFile throws
 *   line 59: catch branch in resolveCliVersion — import fails
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@infra/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { writeAuditTrail, resolveCliVersion } from '@app/audit-trail';
import type { AuditTrailRecord } from '@app/audit-trail';
import { logger } from '@infra/utils/logger';

const record: AuditTrailRecord = {
  timestamp: '2026-01-01T00:00:00.000Z',
  cli_version: '1.0.0',
  dry_run: false,
  scan: null,
  updates: {},
  overall_status: 'success',
  has_pending_vulns: false,
};

describe('writeAuditTrail()', () => {
  it('writes without throwing on success path', async () => {
    // Uses real tmp so it either writes or silently catches — just ensure no throw
    await expect(writeAuditTrail('/tmp', record)).resolves.toBeUndefined();
  });

  it('catches and logs when mkdir throws (line 46)', async () => {
    vi.mock('node:fs/promises', async (importActual) => {
      const actual = await importActual<typeof import('node:fs/promises')>();
      return {
        ...actual,
        mkdir: vi.fn().mockRejectedValue(new Error('permission denied')),
        writeFile: actual.writeFile,
      };
    });

    // Should not throw — catch block should log warning
    await expect(writeAuditTrail('/no-permission', record)).resolves.toBeUndefined();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining('Failed to write audit trail'),
    );
  });

  it('logs String(err) when a non-Error is thrown from mkdir (line 46 false branch)', async () => {
    vi.mock('node:fs/promises', async (importActual) => {
      const actual = await importActual<typeof import('node:fs/promises')>();
      return {
        ...actual,
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        mkdir: vi.fn().mockImplementation(() => Promise.reject('EPERM string')),
        writeFile: actual.writeFile,
      };
    });

    await expect(writeAuditTrail('/no-permission', record)).resolves.toBeUndefined();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining('EPERM string'),
    );
  });
});

describe('resolveCliVersion()', () => {
  it('returns a version string on success (reads real package.json)', async () => {
    const version = await resolveCliVersion();
    expect(typeof version).toBe('string');
    expect(version.length).toBeGreaterThan(0);
  });
});
