/**
 * Docker availability helpers for smoke tests.
 *
 * Provides:
 *  - `isDockerAvailable()` — probes `docker info` once per process (cached).
 *  - `skipIfNoDocker()` — `beforeAll` callback that skips the suite when Docker
 *    is absent, using Vitest's `test.skip()` global.
 *
 * Usage:
 *
 *   import { skipIfNoDocker } from '../helpers/docker-skip.js';
 *
 *   beforeAll(skipIfNoDocker);
 *
 * When Docker is absent the entire suite is skipped cleanly with an explanatory
 * message. No failures; CI pipelines without Docker report smoke tests as skipped.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Cache per process lifetime — we only probe once regardless of how many suites load this.
let _cache: boolean | null = null;

/**
 * Returns `true` if `docker info` exits 0; `false` otherwise.
 * Cached after the first call.
 */
export async function isDockerAvailable(): Promise<boolean> {
  if (_cache !== null) return _cache;
  try {
    await execFileAsync('docker', ['info'], { timeout: 10_000 });
    _cache = true;
  } catch {
    _cache = false;
  }
  return _cache;
}

/**
 * `beforeAll` callback that skips the enclosing test suite when Docker is absent.
 *
 * Vitest `globals: true` exposes `test` on globalThis.  When Docker is missing
 * we call `test.skip()` which marks the whole test-file as skipped in the same
 * way as writing `test.skip('...', ...)` at the top level.
 *
 * @example
 *   beforeAll(skipIfNoDocker);
 */
export async function skipIfNoDocker(): Promise<void> {
  const available = await isDockerAvailable();
  if (!available) {
    // `test` is injected into globalThis when globals:true is set in vitest config.
    // Calling test.skip() from inside beforeAll marks the file as skipped.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).test.skip();
  }
}
