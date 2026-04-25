/**
 * Tests for src/app/output-writer.ts
 * Covers writeOutput (file and stdout paths) and formatScanSummary.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

import { mkdir, writeFile } from 'node:fs/promises';
import { writeOutput, formatScanSummary } from '@app/output-writer';
import type { ScanResultJson } from '@core/types/scan';

const baseScan: ScanResultJson = {
  status: 'success',
  environment: 'local',
  agent: 'osv-scanner',
  ecosystems: {
    npm: {
      vulnerabilities_total: 2,
      auto_safe: 1,
      breaking: 1,
      manual: 0,
      vulnerabilities: [],
    },
  },
  error: undefined,
};

describe('writeOutput()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes to file when outputPath is provided', async () => {
    await writeOutput('content', '/some/path/report.md');
    expect(mkdir).toHaveBeenCalledWith('/some/path', { recursive: true });
    expect(writeFile).toHaveBeenCalledWith('/some/path/report.md', 'content', 'utf-8');
  });

  it('writes to stdout when no outputPath', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await writeOutput('hello output');
    expect(stdoutSpy).toHaveBeenCalledWith('hello output\n');
    stdoutSpy.mockRestore();
  });
});

describe('formatScanSummary()', () => {
  it('includes date header', () => {
    const result = formatScanSummary(baseScan);
    expect(result).toContain('OSV Scan Report');
  });

  it('includes environment label', () => {
    const result = formatScanSummary(baseScan);
    expect(result).toContain('local');
  });

  it('includes ecosystem stats', () => {
    const result = formatScanSummary(baseScan);
    expect(result).toContain('npm');
    expect(result).toContain('Total: 2');
    expect(result).toContain('Auto-safe: 1');
    expect(result).toContain('Breaking: 1');
  });

  it('includes error warning when scan.error is set', () => {
    const scanWithError: ScanResultJson = { ...baseScan, status: 'error', error: 'scanner failed' };
    const result = formatScanSummary(scanWithError);
    expect(result).toContain('Warning');
    expect(result).toContain('scanner failed');
  });

  it('does not include Warning line when no error', () => {
    const result = formatScanSummary(baseScan);
    expect(result).not.toContain('Warning:');
  });
});
