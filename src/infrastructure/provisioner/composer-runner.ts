import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../utils/logger';
import { needsHostGateway, resolvePlatform } from '../utils/docker-platform';
import type { EphemeralContainerRunner, ContainerRunResult } from './types';
import { COMPOSER_DEFAULT_IMAGE } from './php-profiles';

const execFileAsync = promisify(execFile);

// ─── ComposerDockerRunnerOptions ─────────────────────────────────────────────

export interface ComposerDockerRunnerOptions {
  /**
   * Absolute path of the project directory to mount into the container.
   * Mounted read-write at `/project` inside the container so composer can
   * update `composer.lock` and `vendor/` in place.
   */
  projectDir: string;

  /**
   * Docker image to use for the PHP/composer container.
   * Defaults to `COMPOSER_DEFAULT_IMAGE` ('composer:2').
   *
   * Phase 1: use official php:<version>-cli images (PHP + composer pre-installed)
   * or the 'composer:2' fallback image.
   */
  image?: string;

  /**
   * Docker platform string to pass via `--platform` (e.g. `'linux/amd64'`).
   * When omitted, no `--platform` flag is injected (native architecture used).
   */
  platform?: string;
}

// ─── ComposerDockerRunner ─────────────────────────────────────────────────────

/**
 * One-shot ephemeral container runner for composer commands.
 *
 * Implements `EphemeralContainerRunner<string[]>`.
 *
 * Each `run()` call:
 *  1. Assembles a `docker run --rm` command with the project directory mounted
 *     read-write at `/project` and `--workdir /project`.
 *  2. Executes arbitrary composer/php commands inside the container via `sh -lc`.
 *  3. Returns `ContainerRunResult` with `exitCode`, `stdout`, and `stderr`.
 *
 * On Linux, `--add-host=host.docker.internal:host-gateway` is automatically
 * added (host-gateway support from `needsHostGateway()`).
 *
 * Phase 1 uses stock php:<version>-cli images. The `composer` binary must be
 * present in the image — `php:*-cli` images do NOT bundle composer by default.
 * The recommended approach for Phase 1 is to use the official `composer:2`
 * image (which bundles PHP + composer) or a custom image that installs both.
 *
 * For versioned PHP runs (php:8.2-cli), the container command installs composer
 * on-the-fly via the official installer as part of the entrypoint wrapper.
 *
 * Implementation note: commands are passed via `sh -lc` to allow shell features.
 */
export class ComposerDockerRunner implements EphemeralContainerRunner<string[]> {
  private readonly image: string;
  private readonly projectDir: string;
  private readonly resolvedPlatform: string | undefined;

  constructor(options: ComposerDockerRunnerOptions) {
    this.image = options.image ?? COMPOSER_DEFAULT_IMAGE;
    this.projectDir = options.projectDir;
    this.resolvedPlatform = resolvePlatform(options.platform);
  }

  /**
   * Run a composer command inside an ephemeral container with real-time streaming
   * of stdout/stderr to logger.info, while still capturing both streams for
   * returning in `ContainerRunResult`.
   *
   * Use this for long-running steps (composer install, composer update) where
   * progress visibility is important.
   *
   * @param cmdTokens - command tokens (e.g. `['composer', 'install', '--no-scripts']`).
   * @returns `ContainerRunResult` with exitCode, stdout, and stderr.
   */
  async runStreaming(cmdTokens: string[]): Promise<ContainerRunResult> {
    const dockerArgs = this._buildDockerArgs(cmdTokens);

    logger.debug(`ComposerDockerRunner (streaming): docker ${dockerArgs.join(' ')}`);

    return new Promise<ContainerRunResult>((resolve) => {
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];

      const child = spawn('docker', dockerArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdoutChunks.push(text);
        for (const line of text.split('\n')) {
          if (line.trim()) logger.info(`[composer] ${line}`);
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stderrChunks.push(text);
        for (const line of text.split('\n')) {
          if (line.trim()) logger.info(`[composer] ${line}`);
        }
      });

      child.on('close', (code) => {
        const exitCode = typeof code === 'number' ? code : 1;
        logger.debug(`ComposerDockerRunner (streaming): composer container exited ${exitCode}`);
        resolve({
          exitCode,
          stdout: stdoutChunks.join(''),
          stderr: stderrChunks.join(''),
        });
      });

      child.on('error', (err) => {
        logger.debug(`ComposerDockerRunner (streaming): spawn error: ${err.message}`);
        resolve({
          exitCode: 1,
          stdout: stdoutChunks.join(''),
          stderr: err.message,
        });
      });
    });
  }

  /**
   * Run a composer command inside an ephemeral container.
   *
   * @param cmdTokens - command tokens passed as a shell command string via `sh -lc`.
   * @returns `ContainerRunResult` with exitCode, stdout, and stderr.
   */
  async run(cmdTokens: string[]): Promise<ContainerRunResult> {
    const dockerArgs = this._buildDockerArgs(cmdTokens);

    logger.debug(`ComposerDockerRunner: docker ${dockerArgs.join(' ')}`);

    try {
      const { stdout, stderr } = await execFileAsync('docker', dockerArgs);
      logger.debug('ComposerDockerRunner: composer container exited 0');
      return { exitCode: 0, stdout, stderr };
    } catch (err: unknown) {
      const spawnErr = err as { code?: number; stdout?: string; stderr?: string; message?: string };
      const exitCode = typeof spawnErr.code === 'number' ? spawnErr.code : 1;
      const stdout = spawnErr.stdout ?? '';
      const stderr = spawnErr.stderr ?? spawnErr.message ?? String(err);
      logger.debug(`ComposerDockerRunner: composer container exited ${exitCode}`);
      return { exitCode, stdout, stderr };
    }
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  /**
   * Assemble the full `docker run` argument array.
   * Exposed for testability — does not invoke Docker.
   *
   * Commands are passed via `sh -lc` to allow shell-level features.
   */
  _buildDockerArgs(cmdTokens: string[]): string[] {
    const args: string[] = ['run', '--rm'];

    if (this.resolvedPlatform !== undefined) {
      args.push('--platform', this.resolvedPlatform);
    }

    // Read-write mount so composer can update composer.lock and vendor/
    args.push('--volume', `${this.projectDir}:/project`);
    args.push('--workdir', '/project');

    if (needsHostGateway()) {
      args.push('--add-host', 'host.docker.internal:host-gateway');
    }

    args.push(this.image, 'sh', '-lc', cmdTokens.join(' '));

    return args;
  }
}
