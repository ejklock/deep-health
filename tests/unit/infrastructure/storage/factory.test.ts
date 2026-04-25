/**
 * Tests for src/infrastructure/storage/factory.ts — createStorageProvider
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@infra/storage/google-drive', () => ({
  createGoogleDriveProvider: vi.fn().mockResolvedValue({
    upload: vi.fn().mockResolvedValue({ url: 'https://drive.example.com/file', id: 'abc', provider: 'google_drive' }),
  }),
}));

import { createStorageProvider } from '@infra/storage/factory';
import type { CloudStorageConfig } from '@core/types/config';

describe('createStorageProvider()', () => {
  it('returns a GoogleDriveProvider for google_drive provider', async () => {
    const config: CloudStorageConfig = { provider: 'google_drive', folder_id: 'folder123' };
    const provider = await createStorageProvider(config, '/cwd');
    expect(provider).toBeDefined();
    expect(typeof provider.upload).toBe('function');
  });

  it('throws for unknown provider (exhaustive check)', async () => {
    const config = { provider: 'unknown_provider', folder_id: 'x' } as unknown as CloudStorageConfig;
    await expect(createStorageProvider(config, '/cwd')).rejects.toThrow('Unknown cloud storage provider');
  });
});
