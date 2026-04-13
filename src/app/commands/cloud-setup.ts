import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import type { ProjectConfig } from '@core/types/config.js';

interface CloudSetupOptions {
  configPath: string;
  cwd: string;
}

async function resolveCredentials(
  config: ProjectConfig,
  cwd: string,
): Promise<{ credentials: object; credentialsPath: string }> {
  const cs = config.cloud_storage;

  if (cs?.credentials_env) {
    const raw = process.env[cs.credentials_env];
    if (!raw) throw new Error(`Env var "${cs.credentials_env}" is not set`);
    return { credentials: JSON.parse(raw) as object, credentialsPath: cs.credentials_env };
  }

  if (cs?.credentials) {
    const credPath = resolve(cwd, cs.credentials);
    const raw = await readFile(credPath, 'utf-8');
    return { credentials: JSON.parse(raw) as object, credentialsPath: cs.credentials };
  }

  // Prompt for credentials path
  const { default: prompts } = await import('prompts');
  const { credPath } = await prompts({
    type: 'text',
    name: 'credPath',
    message: 'Path to Google service account JSON file (relative to project):',
    initial: '.osv-scanner/gdrive-service-account.json',
  });
  if (!credPath) throw new Error('No credentials path provided');

  const absPath = resolve(cwd, credPath as string);
  const raw = await readFile(absPath, 'utf-8');
  return { credentials: JSON.parse(raw) as object, credentialsPath: credPath as string };
}

async function listDriveFolders(credentials: object): Promise<Array<{ id: string; name: string }>> {
  const { google } = await import('googleapis');

  const auth = new google.auth.GoogleAuth({
    credentials: credentials as never,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });

  const drive = google.drive({ version: 'v3', auth });

  const response = await drive.files.list({
    q: "mimeType='application/vnd.google-apps.folder' and trashed=false",
    fields: 'files(id,name)',
    pageSize: 50,
    orderBy: 'name',
  });

  return (response.data.files ?? []).map((f) => ({ id: f.id ?? '', name: f.name ?? '' }));
}

async function updateConfigFile(
  configPath: string,
  folderId: string,
  credentialsPath?: string,
): Promise<void> {
  const raw = await readFile(configPath, 'utf-8');
  const doc = yamlParse(raw) as Record<string, unknown>;

  const existing = (doc['cloud_storage'] ?? {}) as Record<string, unknown>;
  doc['cloud_storage'] = {
    ...existing,
    provider: 'google_drive',
    folder_id: folderId,
    ...(credentialsPath ? { credentials: credentialsPath } : {}),
  };

  await writeFile(configPath, yamlStringify(doc), 'utf-8');
}

export async function runCloudSetup(opts: CloudSetupOptions): Promise<void> {
  const { default: prompts } = await import('prompts');

  const configPath = resolve(opts.cwd, opts.configPath);

  let rawConfig: string;
  try {
    rawConfig = await readFile(configPath, 'utf-8');
  } catch {
    process.stderr.write(`Config file not found: ${configPath}\nRun "deep-health init" first.\n`);
    process.exit(1);
  }

  const config = yamlParse(rawConfig) as ProjectConfig;

  process.stdout.write('Connecting to Google Drive...\n');

  let credentials: object;
  let credentialsPath: string | undefined;

  try {
    const resolved = await resolveCredentials(config, opts.cwd);
    credentials = resolved.credentials;
    // Only save path back if it was newly entered (not from env var)
    if (!config.cloud_storage?.credentials_env) {
      credentialsPath = resolved.credentialsPath;
    }
  } catch (err) {
    process.stderr.write(`Credentials error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  const saEmail = (credentials as Record<string, unknown>)['client_email'] as string | undefined;
  if (saEmail) {
    process.stdout.write(`Authenticated as: ${saEmail}\n`);
  }

  process.stdout.write('Fetching folders...\n');

  let folders: Array<{ id: string; name: string }>;
  try {
    folders = await listDriveFolders(credentials);
  } catch (err) {
    process.stderr.write(`Failed to list folders: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  if (folders.length === 0) {
    process.stdout.write(
      'No folders found. Share a Google Drive folder with the service account email and try again.\n',
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
  });

  if (!selectedId) {
    process.stdout.write('Setup cancelled.\n');
    return;
  }

  let folderId: string = selectedId as string;

  if (folderId === '__manual__') {
    const { manualId } = await prompts({
      type: 'text',
      name: 'manualId',
      message: 'Enter Google Drive folder ID:',
    });
    if (!manualId) {
      process.stdout.write('Setup cancelled.\n');
      return;
    }
    folderId = manualId as string;
  }

  await updateConfigFile(configPath, folderId, credentialsPath);
  process.stdout.write(`\nCloud storage configured. Folder ID saved to: ${configPath}\n`);
}
