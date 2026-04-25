/**
 * Tests for src/infrastructure/storage/google-drive.ts
 * Mocks googleapis to avoid real network calls.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock googleapis before import
const mockFilesCreate = vi.fn();
const mockSetCredentials = vi.fn();
const mockOn = vi.fn();
const mockOAuth2 = vi.fn(() => ({
  setCredentials: mockSetCredentials,
  on: mockOn,
}));

vi.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: mockOAuth2 },
    drive: vi.fn(() => ({
      files: { create: mockFilesCreate },
    })),
  },
}));

vi.mock('@infra/storage/google-drive-auth', () => ({
  loadStoredTokens: vi.fn(),
  saveTokens: vi.fn().mockResolvedValue(undefined),
}));

import { GoogleDriveProvider, createGoogleDriveProvider } from '@infra/storage/google-drive';
import { loadStoredTokens } from '@infra/storage/google-drive-auth';

const mockTokens = {
  access_token: 'access',
  refresh_token: 'refresh',
  expiry_date: 9999999999999,
  token_type: 'Bearer',
};

describe('GoogleDriveProvider.upload()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOn.mockReturnValue(undefined);
    mockSetCredentials.mockReturnValue(undefined);
  });

  it('uploads a file and returns the result', async () => {
    mockFilesCreate.mockResolvedValue({
      data: { id: 'file123', webViewLink: 'https://drive.google.com/view/file123' },
    });

    const provider = new GoogleDriveProvider('folder123', mockTokens);
    const result = await provider.upload('report.md', '# content');

    expect(result.provider).toBe('google_drive');
    expect(result.id).toBe('file123');
    expect(result.url).toBe('https://drive.google.com/view/file123');
  });

  it('uses fallback URL when webViewLink is absent', async () => {
    mockFilesCreate.mockResolvedValue({
      data: { id: 'file456', webViewLink: undefined },
    });

    const provider = new GoogleDriveProvider('folder123', mockTokens);
    const result = await provider.upload('report.md', '# content');

    expect(result.url).toContain('file456');
  });

  it('uses empty string id when response id is absent', async () => {
    mockFilesCreate.mockResolvedValue({
      data: { id: undefined, webViewLink: undefined },
    });

    const provider = new GoogleDriveProvider('folder123', mockTokens);
    const result = await provider.upload('report.md', 'content');

    expect(result.id).toBe('');
  });

  it('registers token refresh handler via oauth2Client.on', async () => {
    mockFilesCreate.mockResolvedValue({ data: { id: 'x', webViewLink: 'https://example.com' } });

    const provider = new GoogleDriveProvider('folder123', mockTokens);
    await provider.upload('file.md', 'body');

    expect(mockOn).toHaveBeenCalledWith('tokens', expect.any(Function));
  });

  it('token refresh handler saves updated tokens (best-effort)', async () => {
    mockFilesCreate.mockResolvedValue({ data: { id: 'x', webViewLink: 'https://example.com' } });

    const provider = new GoogleDriveProvider('folder123', mockTokens);
    await provider.upload('file.md', 'body');

    // Get the tokens handler from the mock
    const [, handler] = mockOn.mock.calls[0] as [string, (t: Record<string, unknown>) => void];
    
    const { saveTokens } = await import('@infra/storage/google-drive-auth');
    handler({ access_token: 'new-access', refresh_token: null, expiry_date: null, token_type: null });
    // saveTokens is called asynchronously (best-effort) — just verify no throw
    await new Promise((r) => setTimeout(r, 10));
    expect(saveTokens).toHaveBeenCalled();
  });

  it('falls back to stored access_token when newTokens.access_token is null (line 30 ?? branch)', async () => {
    const provider = new GoogleDriveProvider('folder123', mockTokens);
    await provider.upload('file.md', 'body');

    const [, handler] = mockOn.mock.calls[0] as [string, (t: Record<string, unknown>) => void];
    const { saveTokens } = await import('@infra/storage/google-drive-auth');

    // All fields null — triggers fallback to this.tokens.* for all four ?? branches
    handler({ access_token: null, refresh_token: null, expiry_date: null, token_type: null });
    await new Promise((r) => setTimeout(r, 10));
    expect(saveTokens).toHaveBeenCalledWith(expect.objectContaining({
      access_token: mockTokens.access_token,
    }));
  });
});

describe('createGoogleDriveProvider()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws when tokens are not found', async () => {
    vi.mocked(loadStoredTokens).mockResolvedValue(null);
    await expect(createGoogleDriveProvider({ provider: 'google_drive', folder_id: 'f' }, '/cwd'))
      .rejects.toThrow('Google Drive tokens not found');
  });

  it('returns a GoogleDriveProvider when tokens are present', async () => {
    vi.mocked(loadStoredTokens).mockResolvedValue(mockTokens);
    const provider = await createGoogleDriveProvider({ provider: 'google_drive', folder_id: 'folder1' }, '/cwd');
    expect(provider).toBeInstanceOf(GoogleDriveProvider);
  });
});
