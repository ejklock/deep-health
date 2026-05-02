import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@infra/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), phase: vi.fn(), skip: vi.fn(), header: vi.fn(), tagged: vi.fn() },
}));

import { applyOsvNoOp } from '@modules/ecosystem/fixers/osv-fixer';
import type { CommandRunner } from '@core/types/common';
import type { ScanResultJson } from '@core/types/scan';

function makeRunner(): CommandRunner {
  return {
    run: vi.fn(),
    runArgs: vi.fn(),
    dryRun: false,
    environment: 'local',
  } as unknown as CommandRunner;
}

function emptyScan(): ScanResultJson {
  return {
    $schema: 'osv-scan-result/v1',
    agent: 'osv',
    status: 'success',
    environment: 'local',
    ecosystems: {},
    error: null,
  };
}

// ─── AC3: osv-fixer returns packages from osvFixOutcome ───────────────────────

describe('applyOsvNoOp — AC3: osvFixOutcome present', () => {
  beforeEach(() => vi.clearAllMocks());

  it('(AC3a) returns packagesUpdated from osvFixOutcome.packagesUpdated when present and applied=true', async () => {
    const result = await applyOsvNoOp({
      runner: makeRunner(),
      cwd: '/project',
      scanResult: emptyScan(),
      authorizeBreaking: false,
      osvFixOutcome: {
        applied: true,
        packagesUpdated: [
          { name: 'lodash', versionFrom: '4.17.20', versionTo: '4.17.21' },
          { name: 'axios', versionFrom: '1.6.0', versionTo: '1.7.0' },
        ],
      },
    });

    expect(result.breakingInstallError).toBeNull();
    expect(result.packagesUpdated).toContain('lodash@4.17.21');
    expect(result.packagesUpdated).toContain('axios@1.7.0');
    expect(result.packagesUpdated).toHaveLength(2);
  });

  it('(AC3b) returns empty packagesUpdated when osvFixOutcome is absent', async () => {
    const result = await applyOsvNoOp({
      runner: makeRunner(),
      cwd: '/project',
      scanResult: emptyScan(),
      authorizeBreaking: false,
      // no osvFixOutcome
    });

    expect(result.breakingInstallError).toBeNull();
    expect(result.packagesUpdated).toHaveLength(0);
  });

  it('(AC3c) returns empty packagesUpdated when osvFixOutcome.packagesUpdated is empty (applied=false)', async () => {
    const result = await applyOsvNoOp({
      runner: makeRunner(),
      cwd: '/project',
      scanResult: emptyScan(),
      authorizeBreaking: false,
      osvFixOutcome: {
        applied: false,
        packagesUpdated: [],
      },
    });

    expect(result.breakingInstallError).toBeNull();
    expect(result.packagesUpdated).toHaveLength(0);
  });

  it('(AC3d) formats each package as "name@versionTo"', async () => {
    const result = await applyOsvNoOp({
      runner: makeRunner(),
      cwd: '/project',
      scanResult: emptyScan(),
      authorizeBreaking: false,
      osvFixOutcome: {
        applied: true,
        packagesUpdated: [
          { name: 'minimist', versionFrom: '1.2.5', versionTo: '1.2.8' },
        ],
      },
    });

    expect(result.packagesUpdated[0]).toBe('minimist@1.2.8');
  });
});
