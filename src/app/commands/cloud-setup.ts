import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import type { ProjectConfig } from '@core/types/config';
import {
  createOAuth2Client,
  loadStoredTokens,
  runOAuthFlow,
  saveTokens,
} from '@infra/storage/google-drive-auth';

interface CloudSetupOptions {
  configPath: string;
  cwd: string;
}

async function getAuthenticatedEmail(tokens: {
  access_token: string;
  refresh_token: string;
  expiry_date: number;
  token_type: string;
}): Promise<string | null> {
  try {
    const { clientId, clientSecret } = createOAuth2Client();
    const { google } = await import('googleapis');

    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
    oauth2Client.setCredentials({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: tokens.expiry_date,
      token_type: tokens.token_type,
    });

    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const info = await oauth2.userinfo.get();
    return info.data.email ?? null;
  } catch {
    return null;
  }
}

async function listDriveFolders(tokens: {
  access_token: string;
  refresh_token: string;
  expiry_date: number;
  token_type: string;
}): Promise<Array<{ id: string; name: string }>> {
  const { clientId, clientSecret } = createOAuth2Client();
  const { google } = await import('googleapis');

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date,
    token_type: tokens.token_type,
  });

  const drive = google.drive({ version: 'v3', auth: oauth2Client });

  const response = await drive.files.list({
    q: "mimeType='application/vnd.google-apps.folder' and trashed=false",
    fields: 'files(id,name)',
    pageSize: 50,
    orderBy: 'name',
  });

  return (response.data.files ?? []).map((f) => ({ id: f.id ?? '', name: f.name ?? '' }));
}

async function updateConfigFile(configPath: string, folderId: string): Promise<void> {
  const raw = await readFile(configPath, 'utf-8');
  const doc = yamlParse(raw) as Record<string, unknown>;

  doc['cloud_storage'] = {
    provider: 'google_drive',
    folder_id: folderId,
  };

  await writeFile(configPath, yamlStringify(doc), 'utf-8');
}

export async function runCloudSetup(opts: CloudSetupOptions): Promise<number> {
  const { default: prompts } = await import('prompts');

  const configPath = resolve(opts.cwd, opts.configPath);

  let rawConfig: string;
  try {
    rawConfig = await readFile(configPath, 'utf-8');
  } catch {
    process.stderr.write(`Config file not found: ${configPath}\nRun "deep-health init" first.\n`);
    return 1;
  }

  // Validate that OAuth env vars are present before proceeding
  try {
    createOAuth2Client();
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const config = yamlParse(rawConfig) as ProjectConfig;

  // Check for existing tokens
  const existingTokens = await loadStoredTokens();
  let tokens = existingTokens;

  if (existingTokens) {
    const email = await getAuthenticatedEmail(existingTokens);
    const display = email ? `Already connected as ${email}` : 'Already connected to Google Drive';

    const { reconnect } = await prompts({
      type: 'confirm',
      name: 'reconnect',
      message: `${display}. Reconnect?`,
      initial: false,
    });

    if (reconnect) {
      tokens = null;
    }
  }

  if (!tokens) {
    process.stdout.write('Starting Google OAuth 2.0 authorization flow...\n');

    try {
      tokens = await runOAuthFlow();
      await saveTokens(tokens);
      process.stdout.write('\n');
    } catch (err) {
      process.stderr.write(
        `OAuth flow failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 1;
    }
  }

  const email = await getAuthenticatedEmail(tokens);
  if (email) {
    process.stdout.write(`✔ Authenticated as: ${email}\n`);
  } else {
    process.stdout.write('✔ Google Drive connected.\n');
  }

  // Ensure config has cloud_storage section (folder_id may be pre-set)
  const existingFolderId = (config.cloud_storage as { folder_id?: string } | undefined)
    ?.folder_id;

  process.stdout.write('Fetching Google Drive folders...\n');

  let folders: Array<{ id: string; name: string }>;
  try {
    folders = await listDriveFolders(tokens);
  } catch (err) {
    process.stderr.write(
      `Failed to list folders: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  if (folders.length === 0) {
    process.stdout.write(
      'No folders found in your Google Drive.\n' +
        'Create a folder in Google Drive first or enter the folder ID manually.\n',
    );
  }

  const choices = [
    ...folders.map((f) => ({ title: `${f.name}  (${f.id})`, value: f.id })),
    { title: '[Enter folder ID manually]', value: '__manual__' },
  ];

  const { folderId: selectedId } = await prompts({
    type: 'select',
    name: 'folderId',
    message: 'Select the destination folder:',
    choices,
    initial: existingFolderId
      ? Math.max(
          0,
          folders.findIndex((f) => f.id === existingFolderId),
        )
      : 0,
  });

  if (!selectedId) {
    process.stdout.write('Setup cancelled.\n');
    return 0;
  }

  let folderId: string = selectedId as string;

  if (folderId === '__manual__') {
    const { manualId } = await prompts({
      type: 'text',
      name: 'manualId',
      message: 'Enter Google Drive folder ID:',
      initial: existingFolderId ?? '',
    });
    if (!manualId) {
      process.stdout.write('Setup cancelled.\n');
      return 0;
    }
    folderId = manualId as string;
  }

  await updateConfigFile(configPath, folderId);
  process.stdout.write(`\n✔ Cloud storage configured. Folder ID saved to: ${configPath}\n`);
  return 0;
}
