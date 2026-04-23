import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@infra/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { mkdir, writeFile } from 'node:fs/promises';
import { writeAuditTrail } from '@app/audit-trail';
import { logger } from '@infra/utils/logger.js';
import type { AuditTrailRecord } from '@app/audit-trail';

const baseRecord: AuditTrailRecord = {
  timestamp: '2026-04-23T14:30:00.000Z',
  cli_version: '1.0.0',
  dry_run: false,
  scan: null,
  updates: {},
  overall_status: 'success',
  has_pending_vulns: false,
};

describe('writeAuditTrail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('happy path — creates runs dir and writes file', async () => {
    await writeAuditTrail('/proj', baseRecord);

    expect(mkdir).toHaveBeenCalledWith(
      expect.stringContaining('.deep-health/runs'),
      { recursive: true },
    );
    expect(writeFile).toHaveBeenCalledTimes(1);
    const [filePath] = vi.mocked(writeFile).mock.calls[0];
    expect(filePath).toContain('.deep-health/runs');
    expect(filePath).toContain('.json');
  });

  it('replaces colons in timestamp with hyphens in filename', async () => {
    await writeAuditTrail('/proj', baseRecord);

    const [filePath] = vi.mocked(writeFile).mock.calls[0];
    expect(filePath).toContain('2026-04-23T14-30-00.000Z.json');
    expect(filePath).not.toContain('14:30:00');
  });

  it('swallows mkdir failure and logs a warning', async () => {
    vi.mocked(mkdir).mockRejectedValueOnce(
      Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
    );

    await expect(writeAuditTrail('/proj', baseRecord)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[audit trail] Failed to write audit trail'),
    );
  });

  it('swallows writeFile failure and logs a warning', async () => {
    vi.mocked(writeFile).mockRejectedValueOnce(new Error('disk full'));

    await expect(writeAuditTrail('/proj', baseRecord)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[audit trail] Failed to write audit trail'),
    );
  });

  it('serialises the record as JSON and passes it to writeFile', async () => {
    const record: AuditTrailRecord = {
      ...baseRecord,
      overall_status: 'success',
      has_pending_vulns: true,
    };

    await writeAuditTrail('/proj', record);

    const [, content] = vi.mocked(writeFile).mock.calls[0];
    const parsed = JSON.parse(content as string) as AuditTrailRecord;
    expect(parsed).toEqual(record);
  });

  it('calls logger.info with the file path on success', async () => {
    await writeAuditTrail('/proj', baseRecord);

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('.deep-health/runs'),
    );
  });
});
