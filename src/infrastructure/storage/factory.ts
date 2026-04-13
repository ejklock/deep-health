import type { CloudStorageConfig } from '@core/types/config.js';
import type { StorageProvider } from './provider.js';
import { createGoogleDriveProvider } from './google-drive.js';

export async function createStorageProvider(
  config: CloudStorageConfig,
  cwd: string,
): Promise<StorageProvider> {
  switch (config.provider) {
    case 'google_drive':
      return createGoogleDriveProvider(config, cwd);
    default: {
      const _exhaustive: never = config.provider;
      throw new Error(`Unknown cloud storage provider: ${_exhaustive}`);
    }
  }
}
