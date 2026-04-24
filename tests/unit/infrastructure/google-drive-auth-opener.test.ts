/**
 * Direct tests for the OAuth browser opener shell-free argv execution contract.
 *
 * Covers the Tester gap:
 *   "No direct tests found for OAuth opener shell-free execution path."
 *
 * SEC-004: The URL must be passed as a discrete argv element (not interpolated
 * into a shell string) so that shell metacharacters in the URL cannot cause
 * injection. execFile spawns the OS opener directly — no shell is involved.
 *
 * These tests exercise the PRODUCTION openBrowser function exported from
 * google-drive-auth.ts, not a mirrored helper.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── mock child_process BEFORE any test code runs ───────────────────────────
// vi.mock is hoisted — use vi.hoisted to declare the mock before the factory.

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

// ─── import production implementation ────────────────────────────────────────
// openBrowser is the real production function from google-drive-auth.ts.
// The optional `platform` parameter exists solely for testability; production
// callers omit it (defaults to process.platform). No behavior change.

import { openBrowser } from '@infra/storage/google-drive-auth';

// ─── tests ───────────────────────────────────────────────────────────────────

describe('OAuth opener — shell-free argv execution contract (SEC-004)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execFileMock.mockReturnValue({ unref: () => {} });
  });

  it('invokes execFile with shell: false (not spawnSync or exec)', () => {
    const url = 'https://accounts.google.com/o/oauth2/auth?client_id=test';
    openBrowser(url, 'darwin');

    expect(execFileMock).toHaveBeenCalledOnce();
    const [_cmd, _argv, opts] = execFileMock.mock.calls[0] as [string, string[], { shell: boolean }];
    expect(opts.shell).toBe(false);
  });

  it('passes the URL as a discrete argv element (not concatenated into a command string)', () => {
    const url = 'https://accounts.google.com/o/oauth2/auth?client_id=test&scope=drive';
    openBrowser(url, 'darwin');

    const [_cmd, argv] = execFileMock.mock.calls[0] as [string, string[]];
    expect(argv).toEqual([url]);
  });

  it('uses "open" on macOS', () => {
    openBrowser('https://example.com', 'darwin');
    const [cmd] = execFileMock.mock.calls[0] as [string];
    expect(cmd).toBe('open');
  });

  it('uses "xdg-open" on Linux', () => {
    openBrowser('https://example.com', 'linux');
    const [cmd] = execFileMock.mock.calls[0] as [string];
    expect(cmd).toBe('xdg-open');
  });

  it('uses "start" on Windows', () => {
    openBrowser('https://example.com', 'win32');
    const [cmd] = execFileMock.mock.calls[0] as [string];
    expect(cmd).toBe('start');
  });

  it('URL with shell metacharacters is passed verbatim — no injection possible', () => {
    const maliciousUrl =
      'https://example.com/path?foo=bar&baz=$(rm+-rf+/)#anchor';
    openBrowser(maliciousUrl, 'linux');

    const [_cmd, argv, opts] = execFileMock.mock.calls[0] as [string, string[], { shell: boolean }];
    // The URL is passed verbatim as a single argv element
    expect(argv).toEqual([maliciousUrl]);
    // No shell, so metacharacters cannot be interpreted
    expect(opts.shell).toBe(false);
  });
});
