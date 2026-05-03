import { logger } from '../utils/logger';
import { needsHostGateway, resolvePlatform } from '../utils/docker-platform';
import { OSV_DEFAULT_IMAGE, buildOsvDockerRunArgs } from '../utils/osv-commands';
import { withRetry, isDockerTransientError } from '../utils/retry';
import { execFileTracked } from '../ecosystem-runtime/child-process-tracker';
import type { EphemeralContainerRunner, ContainerRunResult } from './types';

// ─── OsvDockerRunnerOptions ─────────────────────────────────────────────────────

/**
 * Options for `OsvDockerRunner`.
 */
export interface OsvDockerRunnerOptions {
  /**
   * Absolute path of the project directory to mount into the container.
   * Mounted at `/project` (read-only) inside the container.
   */
  projectDir: string;

  /**
   * Docker image to use for the OSV scanner container.
   * Defaults to `OSV_DEFAULT_IMAGE` (`ghcr.io/google/osv-scanner:latest`).
   */
  image?: string;

  /**
   * Docker platform string to pass via `--platform` (e.g. `'linux/amd64'`).
   *
   * When omitted, no `--platform` flag is injected. The official OSV image
   * publishes native `linux/amd64` and `linux/arm64` manifests, so auto-
   * detection defaults to no override (unlike sonar-scanner-cli which needs
   * forced amd64 on arm64 hosts).
   *
   * Set to an empty string `''` to explicitly suppress any override.
   */
  platform?: string;

  /**
   * Whether to mount the project directory as read-only inside the container.
   *
   * Defaults to `true` (read-only), which is the safe default for scan/verify operations.
   * Set to `false` when the container needs write access (e.g. `osv-scanner fix --strategy=in-place`).
   */
  readonly?: boolean;
}

// ─── OsvDockerRunner ────────────────────────────────────────────────────────────

/**
 * One-shot ephemeral container runner for `osv-scanner`.
 *
 * Implements `EphemeralContainerRunner<string[]>`.
 *
 * Each `run()` call:
 *  1. Assembles a `docker run --rm` command with the project directory mounted
 *     at `/project` (read-only) and `--workdir /project` set as the container
 *     working directory.
 *  2. Passes the provided plugin lockfile args **raw** (no path translation)
 *     to the osv-scanner binary (array args — no shell quoting hazards).
 *     Because the working directory is `/project`, relative paths from
 *     plugin.buildScanArgs() resolve correctly inside the container.
 *  3. Always appends `--format json` so callers receive structured output.
 *  4. Returns `ContainerRunResult` with `exitCode`, `stdout`, and `stderr`.
 *
 * On Linux, `--add-host=host.docker.internal:host-gateway` is automatically
 * added (host-gateway support from `needsHostGateway()`).
 *
 * The OSV image publishes native arm64 images, so no `--platform` override is
 * applied by default.  Callers may pass an explicit `platform` option if needed.
 */
export class OsvDockerRunner implements EphemeralContainerRunner<string[]> {
  private readonly image: string;
  private readonly projectDir: string;
  private readonly resolvedPlatform: string | undefined;
  private readonly mountReadonly: boolean;

  constructor(options: OsvDockerRunnerOptions) {
    this.image = options.image ?? OSV_DEFAULT_IMAGE;
    this.projectDir = options.projectDir;
    // OSV image has native arm64 support; defaultPlatform is not provided here.
    // Explicit override still respected via the shared resolvePlatform helper.
    this.resolvedPlatform = resolvePlatform(options.platform);
    this.mountReadonly = options.readonly ?? true;
  }

  /**
   * Run osv-scanner inside an ephemeral container.
   *
   * @param lockfileArgs - Raw `--lockfile <path>` pairs from plugin.buildScanArgs()
   *   (flat string array, host-relative paths).  No `/project/` translation is
   *   required — the container working directory is set to `/project` so relative
   *   paths resolve correctly inside the container.
   * @returns `ContainerRunResult` with exitCode, stdout (JSON), and stderr.
   */
  async run(lockfileArgs: string[]): Promise<ContainerRunResult> {
    const dockerArgs = this._buildDockerArgs(lockfileArgs);

    logger.debug(`OsvDockerRunner: docker ${dockerArgs.join(' ')}`);

    let containerResult: ContainerRunResult;
    try {
      containerResult = await withRetry(
        async (): Promise<ContainerRunResult> => {
          try {
            const { stdout, stderr } = await execFileTracked('docker', dockerArgs, {
              // OSV JSON output can be large for projects with many dependencies.
              // Default maxBuffer is 1 MB — raise to 256 MB to avoid truncation.
              maxBuffer: 256 * 1024 * 1024,
            });
            logger.debug('OsvDockerRunner: osv-scanner container exited 0');
            return { exitCode: 0, stdout, stderr };
          } catch (err: unknown) {
            const spawnErr = err as {
              code?: number;
              stdout?: string;
              stderr?: string;
              message?: string;
            };
            const exitCode = typeof spawnErr.code === 'number' ? spawnErr.code : 1;
            const stdout = spawnErr.stdout ?? '';
            const stderr = spawnErr.stderr ?? spawnErr.message ?? String(err);
            throw Object.assign(
              new Error(stderr || `docker exited ${exitCode}`),
              { stdout, stderr, exitCode },
            );
          }
        },
        { retryOn: isDockerTransientError },
      );
    } catch (err: unknown) {
      const e = err as { exitCode?: number; stdout?: string; stderr?: string; message?: string };
      logger.debug(
        `OsvDockerRunner: osv-scanner container exited ${typeof e.exitCode === 'number' ? e.exitCode : 1}`,
      );
      containerResult = {
        exitCode: typeof e.exitCode === 'number' ? e.exitCode : 1,
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? e.message ?? String(err),
      };
    }
    return containerResult;
  }

  // ─── Internal helpers ───────────────────────────────────────────────────────

  /**
   * Assemble the full `docker run` argument array.
   * Exposed for testability — does not invoke Docker.
   */
  _buildDockerArgs(lockfileArgs: string[]): string[] {
    const args = buildOsvDockerRunArgs(
      this.projectDir,
      this.image,
      lockfileArgs,
      this.resolvedPlatform,
      this.mountReadonly,
    );

    // On Linux, host.docker.internal must be mapped explicitly.
    // Insert after the volume flag and before the image name.
    if (needsHostGateway()) {
      // Find the image position (last non-tool arg before tool args begin).
      // We insert --add-host just before the image.
      const imageIdx = args.indexOf(this.image);
      if (imageIdx >= 0) {
        args.splice(imageIdx, 0, '--add-host', 'host.docker.internal:host-gateway');
      }
    }

    return args;
  }
}
