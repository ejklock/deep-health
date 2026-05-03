import { execa } from 'execa';
import { logger } from '../utils/logger';
import { needsHostGateway, resolvePlatform } from '../utils/docker-platform';
import { trackKillable } from '../ecosystem-runtime/child-process-tracker';
import type {
  DockerSonarScannerRunnerOptions,
  EphemeralContainerRunner,
  ContainerRunResult,
} from './types';

// ─── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Attach a line-by-line listener to a readable stream, calling `cb` for each
 * non-empty line as data arrives in real time.
 */
function forwardLines(stream: NodeJS.ReadableStream | null, cb: (line: string) => void): void {
  if (!stream) return;
  let buffer = '';
  stream.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) cb(line);
    }
  });
  stream.on('end', () => {
    if (buffer.trim()) cb(buffer);
  });
}

// ─── Image default ──────────────────────────────────────────────────────────────

const DEFAULT_IMAGE = 'sonarsource/sonar-scanner-cli:latest';

/**
 * Platform fallback for `sonarsource/sonar-scanner-cli`.
 * The image only publishes `linux/amd64`; on arm64 hosts Docker must emulate it.
 */
const SONAR_SCANNER_DEFAULT_PLATFORM = 'linux/amd64';

// ─── DockerSonarScannerRunner ──────────────────────────────────────────────────

/**
 * One-shot runner that executes `sonar-scanner` inside an ephemeral
 * `sonarsource/sonar-scanner-cli` container.
 *
 * Implements `EphemeralContainerRunner<string[]>`.
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
export class DockerSonarScannerRunner implements EphemeralContainerRunner<string[]> {
  private readonly image: string;
  private readonly projectDir: string;
  private readonly sonarHostUrl: string;
  private readonly resolvedPlatform: string | undefined;
  private readonly env: Record<string, string> | undefined;

  constructor(options: DockerSonarScannerRunnerOptions) {
    this.image = options.image ?? DEFAULT_IMAGE;
    this.projectDir = options.projectDir;
    this.sonarHostUrl = options.sonarHostUrl;
    this.resolvedPlatform = resolvePlatform(options.platform, SONAR_SCANNER_DEFAULT_PLATFORM);
    this.env = options.env;
  }

  /**
   * Execute sonar-scanner inside an ephemeral container.
   *
   * @param extraArgs - Additional `-Dsonar.*` args (e.g. projectKey, token).
   *   Do NOT include `-Dsonar.host.url` — it is injected automatically.
   * @param onLine - Optional callback invoked for each output line in real time.
   *   Use this to route container output through a logger (e.g. Listr2 task.output).
   * @returns `ContainerRunResult` with exitCode and combined output.
   */
  async run(extraArgs: string[], onLine?: (line: string) => void): Promise<ContainerRunResult> {
    // Translate localhost/127.0.0.1 → host.docker.internal so the container
    // can reach the ephemeral SonarQube service on the Docker host.
    const containerHostUrl = this._translateHostUrl(this.sonarHostUrl);

    const dockerArgs = this._buildDockerArgs(containerHostUrl, extraArgs);

    logger.debug(`DockerSonarScannerRunner: docker ${dockerArgs.join(' ')}`);

    try {
      const subprocess = execa('docker', dockerArgs, { reject: false });
      trackKillable(subprocess);
      if (onLine) {
        const cb = onLine;
        forwardLines(subprocess.stdout, cb);
        forwardLines(subprocess.stderr, cb);
      }
      const result = await subprocess;
      const exitCode = result.exitCode ?? 0;
      logger.debug(`DockerSonarScannerRunner: sonar-scanner container exited ${exitCode}`);
      return { exitCode, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    } catch (err: unknown) {
      const spawnErr = err as { exitCode?: number; stdout?: string; stderr?: string; message?: string };
      const exitCode = typeof spawnErr.exitCode === 'number' ? spawnErr.exitCode : 1;
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

    // Inject --env flags BEFORE the image name (Docker syntax: these are docker run
    // flags, not scanner args). When env is empty or undefined, no flags are added.
    if (this.env) {
      for (const [key, value] of Object.entries(this.env)) {
        args.push('--env', `${key}=${value}`);
      }
    }

    args.push(this.image);

    // sonar-scanner args injected as individual elements — no shell quoting needed.
    args.push(`-Dsonar.host.url=${containerHostUrl}`);
    args.push(...extraArgs);

    return args;
  }
}

