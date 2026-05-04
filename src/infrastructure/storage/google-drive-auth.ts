import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_GDRIVE_CONFIG_DIR } from '@infra/brand';

export const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
];

export interface StoredTokens {
  access_token: string;
  refresh_token: string;
  expiry_date: number;
  token_type: string;
}

export function getTokensPath(): string {
  const configHome = process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config');
  return join(configHome, DEFAULT_GDRIVE_CONFIG_DIR, 'tokens.json');
}

export async function loadStoredTokens(): Promise<StoredTokens | null> {
  const tokensPath = getTokensPath();
  try {
    const raw = await readFile(tokensPath, 'utf-8');
    return JSON.parse(raw) as StoredTokens;
  } catch {
    return null;
  }
}

export async function saveTokens(tokens: StoredTokens): Promise<void> {
  const tokensPath = getTokensPath();
  await mkdir(join(tokensPath, '..'), { recursive: true });
  await writeFile(tokensPath, JSON.stringify(tokens, null, 2), 'utf-8');
  await chmod(tokensPath, 0o600);
}

export function createOAuth2Client() {
  const clientId = process.env['DEEP_HEALTH_GOOGLE_CLIENT_ID'];
  const clientSecret = process.env['DEEP_HEALTH_GOOGLE_CLIENT_SECRET'];

  if (!clientId || !clientSecret) {
    throw new Error(
      'Google OAuth credentials are not configured.\n' +
        'Set the following environment variables before running cloud-setup:\n' +
        '  DEEP_HEALTH_GOOGLE_CLIENT_ID=<your-client-id>\n' +
        '  DEEP_HEALTH_GOOGLE_CLIENT_SECRET=<your-client-secret>\n' +
        'Create OAuth 2.0 credentials (Desktop app) at:\n' +
        '  https://console.cloud.google.com/apis/credentials',
    );
  }

  // We need to return a factory; actual OAuth2Client is instantiated in runOAuthFlow
  return { clientId, clientSecret };
}

/**
 * Open a URL in the default browser using a shell-free execFile invocation.
 *
 * SEC-004: The URL is passed as a standalone argv element (not interpolated into
 * a shell string), so shell metacharacters in the URL cannot cause injection.
 * execFile spawns the OS opener directly — no shell is involved.
 *
 * @param url      - The URL to open.
 * @param platform - OS platform (defaults to process.platform). Exposed for testing.
 */
export function openBrowser(url: string, platform: NodeJS.Platform = process.platform): void {
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
  // Pass url as a discrete argument — no shell interpolation
  execFile(cmd, [url], { shell: false }, () => {
    // Ignore errors: if the browser doesn't open, the fallback URL printed to stdout is sufficient.
  });
}

export async function runOAuthFlow(): Promise<StoredTokens> {
  const { clientId, clientSecret } = createOAuth2Client();

  let googleModule: typeof import('googleapis');
  try {
    googleModule = await import('googleapis');
  } catch {
    throw new Error(
      'Google Drive OAuth flow requires the "googleapis" package, which is not installed. ' +
        'Install it with: npm install googleapis',
    );
  }
  const { google } = googleModule;

  // Start local HTTP server on a random port
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start local OAuth callback server');
  }
  const port = address.port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  // PKCE
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const state = randomBytes(16).toString('hex');

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: OAUTH_SCOPES,
    state,
    code_challenge: codeChallenge,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    code_challenge_method: 'S256' as any,
    prompt: 'consent', // force refresh_token to be returned
  });

  process.stdout.write('\nOpening browser for Google OAuth authorization...\n');
  process.stdout.write(`\nIf the browser does not open, visit:\n  ${authUrl}\n\n`);

  openBrowser(authUrl);

  return new Promise<StoredTokens>((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error('OAuth timeout: authorization not completed in 5 minutes'));
    }, 5 * 60 * 1000);

    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const returnedState = url.searchParams.get('state');
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(
          `<html><body><h2>Authorization failed: ${error}</h2><p>You can close this tab.</p></body></html>`,
        );
        clearTimeout(timeout);
        server.close();
        reject(new Error(`OAuth authorization failed: ${error}`));
        return;
      }

      if (returnedState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(
          '<html><body><h2>Invalid state parameter</h2><p>You can close this tab.</p></body></html>',
        );
        clearTimeout(timeout);
        server.close();
        reject(new Error('OAuth state mismatch — possible CSRF attack'));
        return;
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(
          '<html><body><h2>No authorization code received</h2><p>You can close this tab.</p></body></html>',
        );
        clearTimeout(timeout);
        server.close();
        reject(new Error('No authorization code in OAuth callback'));
        return;
      }

      // Exchange code for tokens
      oauth2Client
        .getToken({ code, codeVerifier })
        .then(({ tokens }) => {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(
            '<html><body><h2>✔ Authorization successful!</h2><p>You can close this tab and return to the terminal.</p></body></html>',
          );
          clearTimeout(timeout);
          server.close();

          const storedTokens: StoredTokens = {
            access_token: tokens.access_token ?? '',
            refresh_token: tokens.refresh_token ?? '',
            expiry_date: tokens.expiry_date ?? 0,
            token_type: tokens.token_type ?? 'Bearer',
          };

          resolve(storedTokens);
        })
        .catch((err: unknown) => {
          res.writeHead(500, { 'Content-Type': 'text/html' });
          res.end(
            '<html><body><h2>Token exchange failed</h2><p>You can close this tab.</p></body></html>',
          );
          clearTimeout(timeout);
          server.close();
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
  });
}
