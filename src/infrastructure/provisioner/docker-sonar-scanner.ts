import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { platform, arch } from 'node:os';
import { logger } from '../utils/logger';
import type { DockerSonarScannerRunnerOptions, DockerSonarScanRunResult } from './types';

const execFileAsync = promisify(execFile);

// ─── Image default ──────────────────────────────────────────────────────────────

const DEFAULT_IMAGE = 'sonarsource/sonar-scanner-cli:latest';

// ─── Linux host-gateway detection ──────────────────────────────────────────────

/**
 * On Linux, `host.docker.internal` is not automatically resolved by Docker.
 * We add `--add-host=host.docker.internal:host-gateway` to enable it.
 * On macOS/Windows, Docker Desktop handles this natively.
 */
function needsHostGateway(): boolean {
  return platform() === 'linux';
}

// ─── Platform detection ─────────────────────────────────────────────────────────

/**
 * Resolve the Docker `--platform` value to use for the scanner container.
 *
 * `sonarsource/sonar-scanner-cli` only publishes `linux/amd64` images.
 * On Apple Silicon (arm64) Docker will emit a platform mismatch warning and may
 * fail to pull unless we explicitly request `linux/amd64` via Rosetta emulation.
 *
 * Explicit override rules (highest priority first):
 *  1. If `platformOverride` is the empty string '' → omit --platform entirely.
 *  2. If `platformOverride` is a non-empty string → use that value as-is.
 *  3. Auto-detect: arm64 host → 'linux/amd64'; anything else → undefined (omit).
 *
 * @param platformOverride - Value from DockerSonarScannerRunnerOptions.platform.
 * @returns The platform string to pass to `--platform`, or `undefined` to omit it.
 */
export function resolvePlatform(platformOverride?: string): string | undefined {
  // Explicit empty string → caller wants no --platform flag
  if (platformOverride === '') {
    return undefined;
  }
  // Explicit non-empty override
  if (platformOverride !== undefined) {
    return platformOverride;
  }
  // Auto-detect: sonar-scanner-cli has no arm64 image; force amd64 on arm64 hosts
  if (arch() === 'arm64') {
    return 'linux/amd64';
  }
  return undefined;
}

// ─── DockerSonarScannerRunner ──────────────────────────────────────────────────

/**
 * One-shot runner that executes `sonar-scanner` inside an ephemeral
 * `sonarsource/sonar-scanner-cli` container.
 *
 * This is NOT a `ServiceProvisioner` — it has no persistent lifecycle.
 * Each `run()` call starts a container, runs sonar-scanner, and removes it.
 *
 * Usage:
 *   const runner = new DockerSonarScannerRunner({ projectDir: '/app', sonarHostUrl: '...' });
 *   const result = await runner.run(scanArgs);
 *
 * Design decisions:
 * - Uses array args throughout — no shell quoting hazards.
 * - Mounts `projectDir` at `/usr/src` (the image's default working directory).
 * - Replaces `localhost` / `127.0.0.1` in `sonarHostUrl` with
 *   `host.docker.internal` so the container can reach the ephemeral SonarQube
 *   service running on the Docker host.
 * - Adds `--add-host=host.docker.internal:host-gateway` on Linux for the same
 *   reason (Docker Desktop handles this automatically on macOS/Windows).
 * - Injects `--platform linux/amd64` on arm64 hosts (Apple Silicon) because
 *   `sonarsource/sonar-scanner-cli` only publishes amd64 images.
 * - Container is always removed after execution (`--rm`).
 */
export class DockerSonarScannerRunner {
  private readonly image: string;
  private readonly projectDir: string;
  private readonly sonarHostUrl: string;
  private readonly resolvedPlatform: string | undefined;

  constructor(options: DockerSonarScannerRunnerOptions) {
    this.image = options.image ?? DEFAULT_IMAGE;
    this.projectDir = options.projectDir;
    this.sonarHostUrl = options.sonarHostUrl;
    this.resolvedPlatform = resolvePlatform(options.platform);
  }

  /**
   * Execute sonar-scanner inside an ephemeral container.
   *
   * @param extraArgs - Additional `-Dsonar.*` args (e.g. projectKey, token).
   *   Do NOT include `-Dsonar.host.url` — it is injected automatically.
   * @returns `DockerSonarScanRunResult` with exitCode and combined output.
   */
  async run(extraArgs: string[]): Promise<DockerSonarScanRunResult> {
    // Translate localhost/127.0.0.1 → host.docker.internal so the container
    // can reach the ephemeral SonarQube service on the Docker host.
    const containerHostUrl = this._translateHostUrl(this.sonarHostUrl);

    const dockerArgs = this._buildDockerArgs(containerHostUrl, extraArgs);

    logger.debug(`DockerSonarScannerRunner: docker ${dockerArgs.join(' ')}`);

    try {
      const { stdout, stderr } = await execFileAsync('docker', dockerArgs);
      logger.debug('DockerSonarScannerRunner: sonar-scanner container exited 0');
      return { exitCode: 0, stdout, stderr };
    } catch (err: unknown) {
      // execFileAsync rejects with an error that has stdout/stderr/code fields
      // when the child process exits non-zero.
      const spawnErr = err as { code?: number; stdout?: string; stderr?: string; message?: string };
      const exitCode = typeof spawnErr.code === 'number' ? spawnErr.code : 1;
      const stdout = spawnErr.stdout ?? '';
      const stderr = spawnErr.stderr ?? spawnErr.message ?? String(err);
      logger.debug(`DockerSonarScannerRunner: sonar-scanner container exited ${exitCode}`);
      return { exitCode, stdout, stderr };
    }
  }

  // ─── Internal helpers ───────────────────────────────────────────────────────

  /**
   * Replace `localhost` / `127.0.0.1` in the SonarQube host URL with
   * `host.docker.internal` so the scanner container can reach the host service.
   */
  _translateHostUrl(url: string): string {
    return url
      .replace(/localhost/g, 'host.docker.internal')
      .replace(/127\.0\.0\.1/g, 'host.docker.internal');
  }

  /**
   * Assemble the full `docker run` argument array.
   * Exposed as a method (not truly private) to make it testable without
   * actually invoking Docker.
   */
  _buildDockerArgs(containerHostUrl: string, extraArgs: string[]): string[] {
    const args: string[] = [
      'run',
      '--rm',
    ];

    // Inject --platform before --volume so it appears near the top of `docker run` args.
    if (this.resolvedPlatform !== undefined) {
      args.push('--platform', this.resolvedPlatform);
    }

    args.push('--volume', `${this.projectDir}:/usr/src`);

    // On Linux, Docker Desktop is not available so host.docker.internal must be
    // explicitly mapped via the host-gateway special target.
    if (needsHostGateway()) {
      args.push('--add-host', 'host.docker.internal:host-gateway');
    }

    args.push(this.image);

    // sonar-scanner args injected as individual elements — no shell quoting needed.
    args.push(`-Dsonar.host.url=${containerHostUrl}`);
    args.push(...extraArgs);

    return args;
  }
}
