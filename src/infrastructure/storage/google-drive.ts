import { CLI_NAME } from '@infra/brand';
import type { StorageProvider, UploadResult } from './provider';
import type { CloudStorageConfig } from '@core/types/config';
import { loadStoredTokens, saveTokens } from './google-drive-auth';
import type { StoredTokens } from './google-drive-auth';

export class GoogleDriveProvider implements StorageProvider {
  constructor(
    private readonly folderId: string,
    private readonly tokens: StoredTokens,
  ) {}

  async upload(filename: string, content: string | Buffer): Promise<UploadResult> {
    let googleModule: typeof import('googleapis');
    try {
      googleModule = await import('googleapis');
    } catch {
      throw new Error(
        'Google Drive upload requires the "googleapis" package, which is not installed. ' +
          'Install it with: npm install googleapis',
      );
    }
    const { google } = googleModule;

    const oauth2Client = new google.auth.OAuth2(
      process.env['DEEP_HEALTH_GOOGLE_CLIENT_ID'],
      process.env['DEEP_HEALTH_GOOGLE_CLIENT_SECRET'],
    );

    oauth2Client.setCredentials({
      access_token: this.tokens.access_token,
      refresh_token: this.tokens.refresh_token,
      expiry_date: this.tokens.expiry_date,
      token_type: this.tokens.token_type,
    });

    // Silently save refreshed tokens when access_token is renewed
    oauth2Client.on('tokens', (newTokens) => {
      const updated: StoredTokens = {
        access_token: newTokens.access_token ?? this.tokens.access_token,
        refresh_token: newTokens.refresh_token ?? this.tokens.refresh_token,
        expiry_date: newTokens.expiry_date ?? this.tokens.expiry_date,
        token_type: newTokens.token_type ?? this.tokens.token_type,
      };
      saveTokens(updated).catch(() => {
        // best-effort — don't break upload on token-save failure
      });
    });

    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    const mimeType = filename.endsWith('.docx')
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : 'text/markdown';

    const response = await drive.files.create({
      requestBody: {
        name: filename,
        mimeType,
        parents: [this.folderId],
      },
      media: {
        mimeType,
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
  _cwd: string,
): Promise<GoogleDriveProvider> {
  const tokens = await loadStoredTokens();

  if (!tokens) {
    throw new Error(
      `Google Drive tokens not found. Run '${CLI_NAME} cloud-setup' first to connect Google Drive.`,
    );
  }

  return new GoogleDriveProvider(config.folder_id, tokens);
}
