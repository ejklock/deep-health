import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import type { ServiceProvisioner, DockerSonarQubeProvisionerOptions } from './types';
import { logger } from '../utils/logger';
import { registerShutdownHook } from '../utils/shutdown-hooks';

const execFileAsync = promisify(execFile);

// ─── Port utilities ─────────────────────────────────────────────────────────────

/**
 * Find an available ephemeral TCP port on localhost.
 * Binds on port 0, reads the assigned port, then immediately closes the server.
 */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close(() => reject(new Error('Could not determine free port')));
        return;
      }
      const port = addr.port;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    server.on('error', reject);
  });
}

// ─── Readiness polling ──────────────────────────────────────────────────────────

/**
 * Poll GET /api/system/status until SonarQube reports status 'UP'.
 * Returns when ready; throws when timeoutMs is exceeded.
 */
async function waitForSonarQube(
  baseUrl: string,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const statusUrl = `${baseUrl}/api/system/status`;

  logger.debug(`SonarQube provisioner: polling ${statusUrl} (timeout ${timeoutMs}ms)`);

  while (Date.now() < deadline) {
    try {
      const response = await fetch(statusUrl, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) {
        const data = (await response.json()) as { status?: string };
        if (data.status === 'UP') {
          logger.debug('SonarQube provisioner: service is UP');
          return;
        }
        logger.debug(`SonarQube provisioner: status is "${data.status ?? 'unknown'}", still waiting...`);
      }
    } catch {
      // Network not yet ready — continue polling
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(
    `SonarQube provisioner: service did not become ready within ${timeoutMs}ms`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── DockerSonarQubeProvisioner ─────────────────────────────────────────────────

/**
 * Provisions an ephemeral SonarQube Community Edition container via `docker run`.
 *
 * Lifecycle:
 *   1. `provision()` — run container, capture assigned port, return base URL
 *   2. `waitReady()` — poll /api/system/status until UP (or timeout)
 *   3. `teardown()` — docker stop + docker rm (always safe to call multiple times)
 *
 * The caller MUST call teardown() in a finally block.
 *
 * Design decisions:
 * - Uses `docker run` directly (NOT docker-compose) to be independent of project setup.
 * - Uses a random ephemeral port to avoid conflicts with existing services.
 * - Container is removed on teardown (`--rm` is NOT used at run time because we need
 *   `docker stop` to trigger graceful shutdown before `rm`; instead we remove explicitly).
 * - SonarQube stores no state — container is fully ephemeral.
 *
 * Known limitation:
 * - No auth token is pre-configured in the managed container.
 *   The managed mode passes `sonar.login=admin` (default admin credentials) when
 *   running sonar-scanner. This is safe for ephemeral containers that are immediately
 *   torn down. Production-grade token injection is a future concern.
 */
export class DockerSonarQubeProvisioner implements ServiceProvisioner {
  private readonly image: string;
  private readonly containerNamePrefix: string;
  private readonly readinessTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly requestedHostPort?: number;

  private containerName: string | null = null;
  private resolvedPort: number | null = null;
  private torn = false;
  // Unregister callback returned by registerShutdownHook(). Set when provision()
  // installs the hook, cleared when teardown() runs normally.
  private unregisterShutdownHook: (() => void) | null = null;

  constructor(options: DockerSonarQubeProvisionerOptions = {}) {
    this.image = options.image ?? 'sonarqube:community';
    this.containerNamePrefix = options.containerNamePrefix ?? 'osv-sq-ephemeral';
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? 120_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 3_000;
    this.requestedHostPort = options.hostPort;
  }

  // ─── ServiceProvisioner.provision ────────────────────────────────────────────

  async provision(): Promise<{ baseUrl: string }> {
    if (this.containerName !== null) {
      // Already provisioned — return existing URL
      return { baseUrl: this._baseUrl() };
    }

    const hostPort = this.requestedHostPort ?? await findFreePort();
    const suffix = Math.random().toString(36).slice(2, 8);
    const containerName = `${this.containerNamePrefix}-${suffix}`;

    logger.info(`SonarQube provisioner: starting container "${containerName}" on port ${hostPort}...`);
    logger.debug(`SonarQube provisioner: image = ${this.image}`);

    // Run the container detached; publish internal 9000 to the chosen host port.
    // -e SONAR_ES_BOOTSTRAP_CHECKS_DISABLE=true avoids ElasticSearch bootstrap
    // checks that fail in CI / resource-constrained envs.
    await execFileAsync('docker', [
      'run',
      '--detach',
      '--name', containerName,
      '-p', `${hostPort}:9000`,
      '-e', 'SONAR_ES_BOOTSTRAP_CHECKS_DISABLE=true',
      this.image,
    ]);

    this.containerName = containerName;
    this.resolvedPort = hostPort;

    // Register a shutdown hook so the container is still torn down when the
    // process dies abruptly (Ctrl+C, SIGTERM from parent, uncaught exception).
    // Without this, JavaScript `finally` never runs on signal termination and
    // the container leaks on the user's Docker daemon.
    this.unregisterShutdownHook = registerShutdownHook(async () => {
      await this.teardown();
    });

    logger.info(`SonarQube provisioner: container started (${containerName} → localhost:${hostPort})`);

    return { baseUrl: this._baseUrl() };
  }

  // ─── ServiceProvisioner.waitReady ─────────────────────────────────────────────

  async waitReady(timeoutMs?: number): Promise<void> {
    if (this.containerName === null || this.resolvedPort === null) {
      throw new Error('SonarQube provisioner: provision() must be called before waitReady()');
    }

    await waitForSonarQube(
      this._baseUrl(),
      timeoutMs ?? this.readinessTimeoutMs,
      this.pollIntervalMs,
    );
  }

  // ─── ServiceProvisioner.teardown ──────────────────────────────────────────────

  async teardown(): Promise<void> {
    if (this.torn || this.containerName === null) {
      return;
    }

    this.torn = true;
    const name = this.containerName;

    // Unregister from the shutdown-hook registry — normal teardown is happening,
    // so the hook doesn't need to fire at exit. Safe to call even if the hook
    // is what invoked us (the registry snapshots the list on signal, so deleting
    // mid-iteration is a no-op).
    if (this.unregisterShutdownHook) {
      this.unregisterShutdownHook();
      this.unregisterShutdownHook = null;
    }

    logger.info(`SonarQube provisioner: tearing down container "${name}"...`);

    // Stop (graceful, 10s timeout) then remove
    try {
      await execFileAsync('docker', ['stop', '--time', '10', name]);
    } catch (err) {
      logger.warn(
        `SonarQube provisioner: docker stop "${name}" failed — ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      await execFileAsync('docker', ['rm', '--force', name]);
    } catch (err) {
      logger.warn(
        `SonarQube provisioner: docker rm "${name}" failed — ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    logger.info(`SonarQube provisioner: container "${name}" removed`);
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────────

  private _baseUrl(): string {
    return `http://localhost:${this.resolvedPort}`;
  }

  /**
   * Expose resolved container name for testing / inspection.
   * Returns null before provision() is called.
   */
  get containerName_(): string | null {
    return this.containerName;
  }

  /**
   * Expose resolved host port for testing / inspection.
   * Returns null before provision() is called.
   */
  get resolvedPort_(): number | null {
    return this.resolvedPort;
  }
}
