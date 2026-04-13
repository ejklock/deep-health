import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { StorageProvider, UploadResult } from './provider.js';
import type { CloudStorageConfig } from '@core/types/config.js';

export class GoogleDriveProvider implements StorageProvider {
  constructor(
    private readonly folderId: string,
    private readonly credentials: object,
  ) {}

  async upload(filename: string, content: string): Promise<UploadResult> {
    const { google } = await import('googleapis');

    const auth = new google.auth.GoogleAuth({
      credentials: this.credentials as never,
      scopes: ['https://www.googleapis.com/auth/drive.file'],
    });

    const drive = google.drive({ version: 'v3', auth });

    const response = await drive.files.create({
      requestBody: {
        name: filename,
        mimeType: 'text/markdown',
        parents: [this.folderId],
      },
      media: {
        mimeType: 'text/markdown',
        body: content,
      },
      fields: 'id,webViewLink',
    });

    const fileId = response.data.id ?? '';
    const url = response.data.webViewLink ?? `https://drive.google.com/file/d/${fileId}/view`;

    return { url, id: fileId, provider: 'google_drive' };
  }
}

export async function createGoogleDriveProvider(
  config: CloudStorageConfig,
  cwd: string,
): Promise<GoogleDriveProvider> {
  let credentialsJson: object;

  if (config.credentials_env) {
    const raw = process.env[config.credentials_env];
    if (!raw) {
      throw new Error(
        `Environment variable "${config.credentials_env}" is not set or empty`,
      );
    }
    credentialsJson = JSON.parse(raw) as object;
  } else if (config.credentials) {
    const credPath = resolve(cwd, config.credentials);
    const raw = await readFile(credPath, 'utf-8');
    credentialsJson = JSON.parse(raw) as object;
  } else {
    throw new Error(
      'Google Drive requires either "credentials" (path to JSON file) or "credentials_env" (env var name)',
    );
  }

  return new GoogleDriveProvider(config.folder_id, credentialsJson);
}
