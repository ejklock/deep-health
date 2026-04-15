/**
 * Docker availability helpers for smoke tests.
 *
 * Provides:
 *  - `isDockerAvailable()` — probes `docker info` once per process (cached).
 *  - `skipIfNoDocker()` — `beforeAll` callback that skips the suite when Docker
 *    is absent, using a special error that Vitest recognizes as a skip.
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
 * Error class that Vitest recognizes as a skip marker.
 * When this error is thrown from beforeAll, Vitest skips all tests in the suite.
 */
class DockerNotAvailableError extends Error {
  constructor() {
    super('Docker not available');
    this.name = 'DockerNotAvailableError';
  }
}

/**
 * Check if an error indicates Docker is not available.
 */
export function isDockerNotAvailableError(error: unknown): error is Error {
  return error instanceof DockerNotAvailableError || 
    (error instanceof Error && error.message === 'Docker not available' && error.name === 'DockerNotAvailableError');
}

/**
 * `beforeAll` callback that skips the enclosing test suite when Docker is absent.
 *
 * @example
 *   beforeAll(skipIfNoDocker);
 */
export async function skipIfNoDocker(): Promise<void> {
  const available = await isDockerAvailable();
  if (!available) {
    throw new DockerNotAvailableError();
  }
}
