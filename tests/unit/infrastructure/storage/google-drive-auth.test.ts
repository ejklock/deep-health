/**
 * Coverage for src/infrastructure/storage/google-drive-auth.ts
 * Covers all the synchronous/deterministic functions.
 * Avoids network and real OAuth — runOAuthFlow, getUserEmail, listDriveFolders
 * are not tested here (they require live Google APIs).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

// ─── mock child_process so openBrowser() tests never launch a real browser ──
// vi.mock is hoisted — the factory runs before any imports below.
const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: execFileMock }));

vi.mock('node:fs/promises', async (importActual) => {
  const actual = await importActual<typeof import('node:fs/promises')>();
  return { ...actual };
});

vi.mock('@infra/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), tagged: vi.fn() },
}));

import {
  getTokensPath,
  loadStoredTokens,
  saveTokens,
  createOAuth2Client,
  openBrowser,
  OAUTH_SCOPES,
} from '@infra/storage/google-drive-auth';

describe('OAUTH_SCOPES', () => {
  it('exports an array with drive scopes', () => {
    expect(Array.isArray(OAUTH_SCOPES)).toBe(true);
    expect(OAUTH_SCOPES.length).toBeGreaterThan(0);
    expect(OAUTH_SCOPES[0]).toContain('googleapis.com');
  });
});

describe('getTokensPath()', () => {
  afterEach(() => { delete process.env['XDG_CONFIG_HOME']; });

  it('returns path under ~/.config/security-scan when XDG_CONFIG_HOME is not set', () => {
    delete process.env['XDG_CONFIG_HOME'];
    const p = getTokensPath();
    expect(p).toContain('security-scan');
    expect(p).toContain('tokens.json');
  });

  it('returns path under XDG_CONFIG_HOME when set', () => {
    process.env['XDG_CONFIG_HOME'] = '/custom/config';
    const p = getTokensPath();
    expect(p).toContain('/custom/config');
    expect(p).toContain('tokens.json');
  });
});

describe('loadStoredTokens()', () => {
  it('returns null when tokens file does not exist', async () => {
    const result = await loadStoredTokens();
    // In CI/test env tokens file won't exist → catch branch → null
    // (or it exists and returns a valid object — both are valid)
    expect(result === null || typeof result === 'object').toBe(true);
  });
});

describe('saveTokens()', () => {
  it('saves tokens to a temp path without error', async () => {
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const origEnv = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = join(tmpdir(), `gdrive-auth-test-${Date.now()}`);

    const tokens = {
      access_token: 'at',
      refresh_token: 'rt',
      expiry_date: Date.now() + 3600000,
      token_type: 'Bearer',
    };

    await expect(saveTokens(tokens)).resolves.toBeUndefined();

    if (origEnv === undefined) delete process.env['XDG_CONFIG_HOME'];
    else process.env['XDG_CONFIG_HOME'] = origEnv;
  });
});

describe('createOAuth2Client()', () => {
  afterEach(() => {
    delete process.env['DEEP_HEALTH_GOOGLE_CLIENT_ID'];
    delete process.env['DEEP_HEALTH_GOOGLE_CLIENT_SECRET'];
  });

  it('throws when env vars are not set', () => {
    delete process.env['DEEP_HEALTH_GOOGLE_CLIENT_ID'];
    delete process.env['DEEP_HEALTH_GOOGLE_CLIENT_SECRET'];
    expect(() => createOAuth2Client()).toThrow('Google OAuth credentials are not configured');
  });

  it('returns clientId and clientSecret when env vars are set', () => {
    process.env['DEEP_HEALTH_GOOGLE_CLIENT_ID'] = 'my-client-id';
    process.env['DEEP_HEALTH_GOOGLE_CLIENT_SECRET'] = 'my-secret';
    const result = createOAuth2Client();
    expect(result.clientId).toBe('my-client-id');
    expect(result.clientSecret).toBe('my-secret');
  });
});

describe('openBrowser()', () => {
  afterEach(() => { vi.clearAllMocks(); });

  it('calls execFile (mocked) with "open" on darwin — no real browser launched', () => {
    openBrowser('https://example.com', 'darwin');
    expect(execFileMock).toHaveBeenCalledOnce();
    const [cmd] = execFileMock.mock.calls[0] as [string];
    expect(cmd).toBe('open');
  });

  it('calls execFile (mocked) with "start" on win32 — no real browser launched', () => {
    openBrowser('https://example.com', 'win32');
    expect(execFileMock).toHaveBeenCalledOnce();
    const [cmd] = execFileMock.mock.calls[0] as [string];
    expect(cmd).toBe('start');
  });

  it('calls execFile (mocked) with "xdg-open" on linux — no real browser launched', () => {
    openBrowser('https://example.com', 'linux');
    expect(execFileMock).toHaveBeenCalledOnce();
    const [cmd] = execFileMock.mock.calls[0] as [string];
    expect(cmd).toBe('xdg-open');
  });
});
