/**
 * Tests for src/app/commands/cloud-setup.ts — runCloudSetup
 * Mocks prompts, googleapis, and google-drive-auth to avoid real OAuth flows.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs/promises
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  chmod: vi.fn().mockResolvedValue(undefined),
}));

// Mock google-drive-auth
vi.mock('@infra/storage/google-drive-auth', () => ({
  createOAuth2Client: vi.fn(),
  loadStoredTokens: vi.fn(),
  runOAuthFlow: vi.fn(),
  saveTokens: vi.fn().mockResolvedValue(undefined),
}));

// Mock googleapis (for getAuthenticatedEmail and listDriveFolders)
const mockUserinfoGet = vi.fn();
const mockFilesListGdrive = vi.fn();
const mockSetCredentials = vi.fn();
const mockOAuth2Constructor = vi.fn(() => ({ setCredentials: mockSetCredentials }));

vi.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: mockOAuth2Constructor },
    oauth2: vi.fn(() => ({ userinfo: { get: mockUserinfoGet } })),
    drive: vi.fn(() => ({ files: { list: mockFilesListGdrive } })),
  },
}));

// Mock prompts library
const mockPrompts = vi.fn();
vi.mock('prompts', () => ({ default: mockPrompts }));

import { readFile, writeFile } from 'node:fs/promises';
import {
  createOAuth2Client,
  loadStoredTokens,
  runOAuthFlow,
  saveTokens,
} from '@infra/storage/google-drive-auth';
import { runCloudSetup } from '@app/commands/cloud-setup';

const mockTokens = {
  access_token: 'access',
  refresh_token: 'refresh',
  expiry_date: 9999999999999,
  token_type: 'Bearer',
};

const mockConfigContent = `
project:
  name: test-project
  client: acme
`;

describe('runCloudSetup()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createOAuth2Client).mockReturnValue({ clientId: 'id', clientSecret: 'secret' });
    mockSetCredentials.mockReturnValue(undefined);
  });

  it('returns 1 when config file is not found', async () => {
    vi.mocked(readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const code = await runCloudSetup({ configPath: 'project-config.yml', cwd: '/cwd' });
    expect(code).toBe(1);
    stderrSpy.mockRestore();
  });

  it('returns 1 when OAuth env vars are missing', async () => {
    vi.mocked(readFile).mockResolvedValue(mockConfigContent);
    vi.mocked(createOAuth2Client).mockImplementation(() => {
      throw new Error('Google OAuth credentials are not configured.');
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const code = await runCloudSetup({ configPath: 'project-config.yml', cwd: '/cwd' });
    expect(code).toBe(1);
    stderrSpy.mockRestore();
  });

  it('asks to reconnect and proceeds with new OAuth flow when reconnect=true', async () => {
    vi.mocked(readFile).mockResolvedValue(mockConfigContent);
    vi.mocked(loadStoredTokens).mockResolvedValue(mockTokens);
    mockUserinfoGet.mockResolvedValue({ data: { email: 'user@example.com' } });
    vi.mocked(runOAuthFlow).mockResolvedValue(mockTokens);

    mockFilesListGdrive.mockResolvedValue({ data: { files: [{ id: 'f1', name: 'Reports' }] } });

    // First call: reconnect confirm → true
    // Second call: folder select → choose 'f1'
    mockPrompts
      .mockResolvedValueOnce({ reconnect: true })
      .mockResolvedValueOnce({ folderId: 'f1' });

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const code = await runCloudSetup({ configPath: 'project-config.yml', cwd: '/cwd' });
    expect(code).toBe(0);
    expect(runOAuthFlow).toHaveBeenCalled();
    stdoutSpy.mockRestore();
  });

  it('skips OAuth flow when tokens exist and user declines reconnect', async () => {
    vi.mocked(readFile).mockResolvedValue(mockConfigContent);
    vi.mocked(loadStoredTokens).mockResolvedValue(mockTokens);
    mockUserinfoGet.mockResolvedValue({ data: { email: 'user@example.com' } });
    mockFilesListGdrive.mockResolvedValue({ data: { files: [{ id: 'f1', name: 'Reports' }] } });

    // First call: reconnect confirm → false (keep existing)
    // Second call: folder select → choose 'f1'
    mockPrompts
      .mockResolvedValueOnce({ reconnect: false })
      .mockResolvedValueOnce({ folderId: 'f1' });

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const code = await runCloudSetup({ configPath: 'project-config.yml', cwd: '/cwd' });
    expect(code).toBe(0);
    expect(runOAuthFlow).not.toHaveBeenCalled();
    stdoutSpy.mockRestore();
  });

  it('runs OAuth flow when no tokens exist', async () => {
    vi.mocked(readFile).mockResolvedValue(mockConfigContent);
    vi.mocked(loadStoredTokens).mockResolvedValue(null);
    vi.mocked(runOAuthFlow).mockResolvedValue(mockTokens);
    mockUserinfoGet.mockResolvedValue({ data: { email: null } });
    mockFilesListGdrive.mockResolvedValue({ data: { files: [] } });

    mockPrompts.mockResolvedValueOnce({ folderId: '__manual__' }).mockResolvedValueOnce({ manualId: 'manual-folder-id' });

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const code = await runCloudSetup({ configPath: 'project-config.yml', cwd: '/cwd' });
    expect(code).toBe(0);
    expect(runOAuthFlow).toHaveBeenCalled();
    expect(saveTokens).toHaveBeenCalledWith(mockTokens);
    stdoutSpy.mockRestore();
  });

  it('returns 1 when OAuth flow fails', async () => {
    vi.mocked(readFile).mockResolvedValue(mockConfigContent);
    vi.mocked(loadStoredTokens).mockResolvedValue(null);
    vi.mocked(runOAuthFlow).mockRejectedValue(new Error('OAuth timeout'));

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const code = await runCloudSetup({ configPath: 'project-config.yml', cwd: '/cwd' });
    expect(code).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('OAuth flow failed'));
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('returns 0 when folder selection is cancelled (no folderId)', async () => {
    vi.mocked(readFile).mockResolvedValue(mockConfigContent);
    vi.mocked(loadStoredTokens).mockResolvedValue(mockTokens);
    mockUserinfoGet.mockResolvedValue({ data: { email: 'user@example.com' } });
    mockFilesListGdrive.mockResolvedValue({ data: { files: [{ id: 'f1', name: 'Reports' }] } });

    mockPrompts
      .mockResolvedValueOnce({ reconnect: false })
      .mockResolvedValueOnce({ folderId: undefined });

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const code = await runCloudSetup({ configPath: 'project-config.yml', cwd: '/cwd' });
    expect(code).toBe(0);
    stdoutSpy.mockRestore();
  });

  it('returns 0 when manual ID entry is cancelled', async () => {
    vi.mocked(readFile).mockResolvedValue(mockConfigContent);
    vi.mocked(loadStoredTokens).mockResolvedValue(mockTokens);
    mockUserinfoGet.mockResolvedValue({ data: { email: null } });
    mockFilesListGdrive.mockResolvedValue({ data: { files: [] } });

    mockPrompts
      .mockResolvedValueOnce({ reconnect: false })
      .mockResolvedValueOnce({ folderId: '__manual__' })
      .mockResolvedValueOnce({ manualId: undefined });

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const code = await runCloudSetup({ configPath: 'project-config.yml', cwd: '/cwd' });
    expect(code).toBe(0);
    stdoutSpy.mockRestore();
  });

  it('returns 1 when listDriveFolders fails', async () => {
    vi.mocked(readFile).mockResolvedValue(mockConfigContent);
    vi.mocked(loadStoredTokens).mockResolvedValue(mockTokens);
    mockUserinfoGet.mockResolvedValue({ data: { email: 'user@example.com' } });
    mockFilesListGdrive.mockRejectedValue(new Error('network error'));

    mockPrompts.mockResolvedValueOnce({ reconnect: false });

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const code = await runCloudSetup({ configPath: 'project-config.yml', cwd: '/cwd' });
    expect(code).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to list folders'));
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('shows "no folders" message when Drive has no folders', async () => {
    vi.mocked(readFile).mockResolvedValue(mockConfigContent);
    vi.mocked(loadStoredTokens).mockResolvedValue(mockTokens);
    mockUserinfoGet.mockResolvedValue({ data: { email: null } });
    mockFilesListGdrive.mockResolvedValue({ data: { files: [] } });

    mockPrompts
      .mockResolvedValueOnce({ reconnect: false })
      .mockResolvedValueOnce({ folderId: 'f1' });

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await runCloudSetup({ configPath: 'project-config.yml', cwd: '/cwd' });
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('No folders found'));
    stdoutSpy.mockRestore();
  });

  it('returns null email when userinfo.get throws (line 39 catch)', async () => {
    vi.mocked(readFile).mockResolvedValue(mockConfigContent);
    vi.mocked(loadStoredTokens).mockResolvedValue(mockTokens);
    // Throw from userinfo.get → getUserEmail catch returns null (line 39)
    mockUserinfoGet.mockRejectedValue(new Error('auth error'));
    mockFilesListGdrive.mockResolvedValue({ data: { files: [] } });

    mockPrompts
      .mockResolvedValueOnce({ reconnect: false })
      .mockResolvedValueOnce({ folderId: '__manual__' })
      .mockResolvedValueOnce({ manualId: 'folder-xyz' });

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const code = await runCloudSetup({ configPath: 'project-config.yml', cwd: '/cwd' });
    expect(code).toBe(0);
    stdoutSpy.mockRestore();
  });

  it('pre-selects existing folder when config already has cloud_storage.folder_id (lines 151, 183-186)', async () => {
    const configWithFolder = `
project:
  name: test-project
  client: acme
cloud_storage:
  provider: google_drive
  folder_id: existing-folder-id
`;
    vi.mocked(readFile).mockResolvedValue(configWithFolder);
    vi.mocked(loadStoredTokens).mockResolvedValue(mockTokens);
    mockUserinfoGet.mockResolvedValue({ data: { email: 'user@example.com' } });
    mockFilesListGdrive.mockResolvedValue({
      data: {
        files: [
          { id: 'other-folder', name: 'Other' },
          { id: 'existing-folder-id', name: 'My Reports' }, // should be pre-selected
        ],
      },
    });

    mockPrompts
      .mockResolvedValueOnce({ reconnect: false })
      // folder selection — initial index will be 1 (Math.max + findIndex)
      .mockResolvedValueOnce({ folderId: 'existing-folder-id' });

      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const code = await runCloudSetup({ configPath: 'project-config.yml', cwd: '/cwd' });
    expect(code).toBe(0);
    stdoutSpy.mockRestore();
  });

  it('uses String(err) when createOAuth2Client throws a non-Error (line 101 false branch)', async () => {
    vi.mocked(readFile).mockResolvedValue(mockConfigContent);
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    vi.mocked(createOAuth2Client).mockImplementation(() => { throw 'missing env vars string'; });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const code = await runCloudSetup({ configPath: 'project-config.yml', cwd: '/cwd' });
    expect(code).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('missing env vars string'));
    stderrSpy.mockRestore();
  });

  it('uses String(err) when runOAuthFlow throws a non-Error (line 136 false branch)', async () => {
    vi.mocked(readFile).mockResolvedValue(mockConfigContent);
    vi.mocked(loadStoredTokens).mockResolvedValue(null);
    vi.mocked(runOAuthFlow).mockImplementation(() => Promise.reject('oauth string error'));

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const code = await runCloudSetup({ configPath: 'project-config.yml', cwd: '/cwd' });
    expect(code).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('oauth string error'));
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('uses String(err) when listDriveFolders throws a non-Error (line 160 false branch)', async () => {
    vi.mocked(readFile).mockResolvedValue(mockConfigContent);
    vi.mocked(loadStoredTokens).mockResolvedValue(mockTokens);
    mockUserinfoGet.mockResolvedValue({ data: { email: 'user@example.com' } });
    mockFilesListGdrive.mockImplementation(() => Promise.reject('folders string error'));

    mockPrompts.mockResolvedValueOnce({ reconnect: false });

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const code = await runCloudSetup({ configPath: 'project-config.yml', cwd: '/cwd' });
    expect(code).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('folders string error'));
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('handles listDriveFolders returning files with null id/name (line 69 ?? branches)', async () => {
    vi.mocked(readFile).mockResolvedValue(mockConfigContent);
    vi.mocked(loadStoredTokens).mockResolvedValue(mockTokens);
    mockUserinfoGet.mockResolvedValue({ data: { email: 'user@example.com' } });
    // Files with null id and null name — triggers f.id ?? '' and f.name ?? ''
    mockFilesListGdrive.mockResolvedValue({ data: { files: [{ id: null, name: null }] } });

    mockPrompts
      .mockResolvedValueOnce({ reconnect: false })
      .mockResolvedValueOnce({ folderId: '' });

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const code = await runCloudSetup({ configPath: 'project-config.yml', cwd: '/cwd' });
    expect(code).toBe(0);
    stdoutSpy.mockRestore();
  });
});
