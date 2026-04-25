/**
 * Unit tests for src/infrastructure/storage/google-drive-auth.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// All mocks in vi.hoisted so they're available in vi.mock factories
const mocks = vi.hoisted(() => {
  // Server mock state
  let requestHandlerFn: ((req: { url?: string }, res: { writeHead: (c: number, h?: Record<string,string>) => void; end: (b: string) => void }) => void) | null = null;
  const serverListenFn = vi.fn((_port: number, _host: string, cb: () => void) => { cb(); });
  const serverAddressFn = vi.fn(() => ({ port: 54321 }));
  const serverCloseFn = vi.fn((cb?: () => void) => { cb?.(); });
  const serverOnFn = vi.fn((event: string, handler: typeof requestHandlerFn) => {
    if (event === 'request') requestHandlerFn = handler;
  });
  const createServerFn = vi.fn(() => ({
    listen: serverListenFn,
    on: serverOnFn,
    address: serverAddressFn,
    close: serverCloseFn,
  }));

  /**
   * Wait (via real event-loop turns) until the server.on('request') handler
   * has been registered by runOAuthFlow (which awaits dynamic import first),
   * then invoke the handler with the given URL.
   */
  async function simulateRequest(url: string): Promise<{ writeHead: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }> {
    const writeHead = vi.fn();
    const end = vi.fn();
    // Poll until requestHandlerFn is set
    const deadline = Date.now() + 3000;
    while (requestHandlerFn === null && Date.now() < deadline) {
      await new Promise<void>((res) => setImmediate(res));
    }
    if (requestHandlerFn) requestHandlerFn({ url }, { writeHead, end });
    return { writeHead, end };
  }

  function resetServer() {
    requestHandlerFn = null;
    serverListenFn.mockClear();
    serverAddressFn.mockClear();
    serverCloseFn.mockClear();
    serverOnFn.mockClear();
    createServerFn.mockClear();
  }

  return {
    // fs/promises
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    chmod: vi.fn(),
    // child_process
    execFile: vi.fn(),
    // http
    createServerFn,
    simulateRequest,
    resetServer,
    serverOnFn,
    serverAddressFn,
    // googleapis
    generateAuthUrl: vi.fn().mockReturnValue('https://accounts.google.com/auth?test=1'),
    getToken: vi.fn(),
    OAuth2Ctor: vi.fn(),
  };
});

// ── Module mocks ──────────────────────────────────────────────────────────────
vi.mock('node:fs/promises', () => ({ readFile: mocks.readFile, writeFile: mocks.writeFile, mkdir: mocks.mkdir, chmod: mocks.chmod }));
vi.mock('node:child_process', () => ({ execFile: mocks.execFile }));
vi.mock('node:http', () => ({ createServer: mocks.createServerFn }));
vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: mocks.OAuth2Ctor,
    },
  },
}));

// ── Imports ────────────────────────────────────────────────────────────────────
import {
  getTokensPath,
  loadStoredTokens,
  saveTokens,
  createOAuth2Client,
  openBrowser,
  runOAuthFlow,
} from '@infra/storage/google-drive-auth';

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('getTokensPath', () => {
  it('uses XDG_CONFIG_HOME when set', () => {
    process.env['XDG_CONFIG_HOME'] = '/custom/config';
    const path = getTokensPath();
    expect(path).toContain('/custom/config');
    expect(path).toContain('tokens.json');
    delete process.env['XDG_CONFIG_HOME'];
  });

  it('falls back to ~/.config when XDG_CONFIG_HOME is not set', () => {
    delete process.env['XDG_CONFIG_HOME'];
    const path = getTokensPath();
    expect(path).toContain('.config');
    expect(path).toContain('tokens.json');
  });
});

describe('loadStoredTokens', () => {
  beforeEach(() => mocks.readFile.mockReset());

  it('returns parsed tokens when file exists (line 29)', async () => {
    const tokens = { access_token: 'at', refresh_token: 'rt', expiry_date: 9999, token_type: 'Bearer' };
    mocks.readFile.mockResolvedValueOnce(JSON.stringify(tokens));
    const result = await loadStoredTokens();
    expect(result).toEqual(tokens);
  });

  it('returns null when file does not exist (catch branch)', async () => {
    mocks.readFile.mockRejectedValueOnce(new Error('ENOENT'));
    const result = await loadStoredTokens();
    expect(result).toBeNull();
  });
});

describe('saveTokens', () => {
  beforeEach(() => {
    mocks.mkdir.mockReset().mockResolvedValue(undefined);
    mocks.writeFile.mockReset().mockResolvedValue(undefined);
    mocks.chmod.mockReset().mockResolvedValue(undefined);
  });

  it('creates directory, writes file, and chmods it', async () => {
    const tokens = { access_token: 'at', refresh_token: 'rt', expiry_date: 0, token_type: 'Bearer' };
    await saveTokens(tokens);
    expect(mocks.mkdir).toHaveBeenCalledWith(expect.any(String), { recursive: true });
    expect(mocks.writeFile).toHaveBeenCalled();
    expect(mocks.chmod).toHaveBeenCalledWith(expect.any(String), 0o600);
  });
});

describe('createOAuth2Client', () => {
  it('throws when env vars are missing', () => {
    delete process.env['DEEP_HEALTH_GOOGLE_CLIENT_ID'];
    delete process.env['DEEP_HEALTH_GOOGLE_CLIENT_SECRET'];
    expect(() => createOAuth2Client()).toThrow('Google OAuth credentials are not configured');
  });

  it('returns clientId and clientSecret when env vars are set', () => {
    process.env['DEEP_HEALTH_GOOGLE_CLIENT_ID'] = 'test-client-id';
    process.env['DEEP_HEALTH_GOOGLE_CLIENT_SECRET'] = 'test-client-secret';
    const result = createOAuth2Client();
    expect(result.clientId).toBe('test-client-id');
    expect(result.clientSecret).toBe('test-client-secret');
    delete process.env['DEEP_HEALTH_GOOGLE_CLIENT_ID'];
    delete process.env['DEEP_HEALTH_GOOGLE_CLIENT_SECRET'];
  });
});

describe('openBrowser', () => {
  beforeEach(() => mocks.execFile.mockReset());

  it('uses "open" on darwin', () => {
    openBrowser('https://example.com', 'darwin');
    expect(mocks.execFile).toHaveBeenCalledWith('open', ['https://example.com'], { shell: false }, expect.any(Function));
  });

  it('uses "start" on win32', () => {
    openBrowser('https://example.com', 'win32');
    expect(mocks.execFile).toHaveBeenCalledWith('start', ['https://example.com'], { shell: false }, expect.any(Function));
  });

  it('uses "xdg-open" on linux', () => {
    openBrowser('https://example.com', 'linux');
    expect(mocks.execFile).toHaveBeenCalledWith('xdg-open', ['https://example.com'], { shell: false }, expect.any(Function));
  });
});

describe('runOAuthFlow', () => {
  beforeEach(() => {
    process.env['DEEP_HEALTH_GOOGLE_CLIENT_ID'] = 'test-client-id';
    process.env['DEEP_HEALTH_GOOGLE_CLIENT_SECRET'] = 'test-client-secret';
    mocks.execFile.mockReset();
    mocks.getToken.mockReset();
    mocks.generateAuthUrl.mockReset().mockReturnValue('https://accounts.google.com/auth?test=1');
    mocks.OAuth2Ctor.mockImplementation(() => ({
      generateAuthUrl: mocks.generateAuthUrl,
      getToken: mocks.getToken,
    }));
    mocks.resetServer();
  });

  afterEach(() => {
    delete process.env['DEEP_HEALTH_GOOGLE_CLIENT_ID'];
    delete process.env['DEEP_HEALTH_GOOGLE_CLIENT_SECRET'];
  });

  /** Poll until generateAuthUrl has been called, then return its captured state param. */
  async function waitForState(): Promise<string> {
    const deadline = Date.now() + 3000;
    while (mocks.generateAuthUrl.mock.calls.length === 0 && Date.now() < deadline) {
      await new Promise<void>((res) => setImmediate(res));
    }
    const calls = mocks.generateAuthUrl.mock.calls;
    const lastCall = calls[calls.length - 1]?.[0] as { state?: string } | undefined;
    return lastCall?.state ?? 'fallback-state';
  }

  it('throws when server.address() returns null (lines 89-91)', async () => {
    mocks.serverAddressFn.mockReturnValueOnce(null);
    await expect(runOAuthFlow()).rejects.toThrow('Failed to start local OAuth callback server');
  });

  it('throws when server.address() returns a string (lines 89-91)', async () => {
    mocks.serverAddressFn.mockReturnValueOnce('/tmp/socket');
    await expect(runOAuthFlow()).rejects.toThrow('Failed to start local OAuth callback server');
  });

  it('resolves with tokens when OAuth callback has valid code and state (lines 170-187)', async () => {
    const mockTokens = { access_token: 'access-123', refresh_token: 'refresh-456', expiry_date: 1234567890, token_type: 'Bearer' };
    mocks.getToken.mockResolvedValue({ tokens: mockTokens });

    const flowPromise = runOAuthFlow();

    const capturedState = await waitForState();
    await mocks.simulateRequest(`/callback?state=${capturedState}&code=auth-code-xyz`);

    const result = await flowPromise;
    expect(result.access_token).toBe('access-123');
    expect(result.refresh_token).toBe('refresh-456');
  });

  it('rejects when OAuth callback has an error param (lines 136-144)', async () => {
    const flowPromise = runOAuthFlow();
    const assertion = expect(flowPromise).rejects.toThrow('OAuth authorization failed: access_denied');

    await mocks.simulateRequest('/callback?error=access_denied');

    await assertion;
  });

  it('rejects when state param does not match (lines 147-155)', async () => {
    const flowPromise = runOAuthFlow();
    const assertion = expect(flowPromise).rejects.toThrow('OAuth state mismatch');

    await mocks.simulateRequest('/callback?state=wrong-state&code=some-code');

    await assertion;
  });

  it('rejects when no code is in the callback (lines 158-166)', async () => {
    const flowPromise = runOAuthFlow();
    const assertion = expect(flowPromise).rejects.toThrow('No authorization code in OAuth callback');

    const capturedState = await waitForState();
    await mocks.simulateRequest(`/callback?state=${capturedState}`);

    await assertion;
  });

  it('returns 404 for non-callback paths (lines 126-129)', async () => {
    const flowPromise = runOAuthFlow();

    const { writeHead, end } = await mocks.simulateRequest('/other-path');
    expect(writeHead).toHaveBeenCalledWith(404);
    expect(end).toHaveBeenCalledWith('Not found');

    // Clean up the pending promise by sending a terminating request
    await mocks.simulateRequest('/callback?error=cleanup');
    await flowPromise.catch(() => { /* expected */ });
  });

  it('rejects with error when getToken throws Error (lines 189-197)', async () => {
    // Use a deferred rejection (via .then) so Node does not flag it as unhandled
    // before the production .then().catch() chain is fully attached.
    mocks.getToken.mockImplementationOnce(() =>
      Promise.resolve().then(() => { throw new Error('Token exchange failed'); }),
    );

    const flowPromise = runOAuthFlow();
    // Attach rejection handler immediately so flowPromise is never "unhandled"
    const assertion = expect(flowPromise).rejects.toThrow('Token exchange failed');

    const capturedState = await waitForState();
    await mocks.simulateRequest(`/callback?state=${capturedState}&code=bad-code`);
    await new Promise<void>((res) => setImmediate(res));

    await assertion;
  });

  it('rejects wrapping non-Error from getToken (line 196 String branch)', async () => {
    mocks.getToken.mockImplementationOnce(() =>
      // eslint-disable-next-line prefer-promise-reject-errors
      Promise.resolve().then(() => { throw 'plain string error'; }),
    );

    const flowPromise = runOAuthFlow();
    const assertion = expect(flowPromise).rejects.toThrow('plain string error');

    const capturedState = await waitForState();
    await mocks.simulateRequest(`/callback?state=${capturedState}&code=bad-code`);
    await new Promise<void>((res) => setImmediate(res));

    await assertion;
  });

  it('rejects with timeout error when OAuth is not completed in time (lines 118-121)', async () => {
    // Spy on setTimeout BEFORE calling runOAuthFlow so we can capture the 5-min
    // timeout callback and trigger it manually without waiting.
    let timeoutCallback: (() => void) | null = null;
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(
      (fn: TimerHandler, _delay?: number, ..._args: unknown[]) => {
        timeoutCallback = fn as () => void;
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
    );

    try {
      const flowPromise = runOAuthFlow();

      // Wait for runOAuthFlow to reach and execute new Promise(...) body,
      // which registers the setTimeout callback we captured above.
      const deadline = Date.now() + 3000;
      while (timeoutCallback === null && Date.now() < deadline) {
        await new Promise<void>((res) => setImmediate(res));
      }

      // Restore setTimeout so clearTimeout and other internals work normally
      setTimeoutSpy.mockRestore();

      // Manually fire the timeout callback
      if (timeoutCallback) timeoutCallback();

      await expect(flowPromise).rejects.toThrow('OAuth timeout');
    } finally {
      setTimeoutSpy.mockRestore();
    }
  }, 15_000);
});
