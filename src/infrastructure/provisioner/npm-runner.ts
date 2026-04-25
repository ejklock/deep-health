import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../utils/logger';
import { needsHostGateway, resolvePlatform } from '../utils/docker-platform';
import { withRetry, isDockerTransientError } from '../utils/retry';
import type { EphemeralContainerRunner, ContainerRunResult } from './types';

const execFileAsync = promisify(execFile);

/**
 * Default Node.js Docker image used when no specific Node version is configured or inferred.
 * Uses the full LTS image for broad compatibility including native modules (node-gyp).
 */
export const NPM_DEFAULT_IMAGE = 'node:lts';

/**
 * Resolve the Docker image to use for a given Node version hint.
 *
 * @param nodeVersion - Inferred/configured Node version string (e.g. "20", "20.11", "22.0").
 *   When undefined or empty, falls back to `NPM_DEFAULT_IMAGE`.
 * @returns Docker image name, e.g. `'node:20'` or `'node:lts'`.
 */
export function resolveNpmDockerImage(nodeVersion?: string): string {
  if (!nodeVersion || !nodeVersion.trim()) return NPM_DEFAULT_IMAGE;

  // Use the major version only for the image tag — "20.11.1" → "20"
  const major = nodeVersion.trim().split('.')[0];
  if (!major || !/^\d+$/.test(major)) return NPM_DEFAULT_IMAGE;

  return `node:${major}`;
}

// ─── NpmDockerRunnerOptions ──────────────────────────────────────────────────

export interface NpmDockerRunnerOptions {
  /**
   * Absolute path of the project directory to mount into the container.
   * Mounted read-write at `/project` inside the container so npm can
   * update `package-lock.json` and `node_modules` in place.
   */
  projectDir: string;

  /**
   * Docker image to use for the Node/npm container.
   * Defaults to `NPM_DEFAULT_IMAGE` (`node:lts`).
   */
  image?: string;

  /**
   * Docker platform string to pass via `--platform` (e.g. `'linux/amd64'`).
   * When omitted, no `--platform` flag is injected (native architecture used).
   */
  platform?: string;
}

// ─── NpmDockerRunner ─────────────────────────────────────────────────────────

/**
 * One-shot ephemeral container runner for npm commands.
 *
 * Implements `EphemeralContainerRunner<string[]>`.
 *
 * Each `run()` call:
 *  1. Assembles a `docker run --rm` command with the project directory mounted
 *     read-write at `/project` and `--workdir /project`.
 *  2. Executes `npm` inside the container with the provided args array
 *     (no shell, no injection risk).
 *  3. Returns `ContainerRunResult` with `exitCode`, `stdout`, and `stderr`.
 *
 * On Linux, `--add-host=host.docker.internal:host-gateway` is automatically
 * added (host-gateway support from `needsHostGateway()`).
 */
export class NpmDockerRunner implements EphemeralContainerRunner<string[]> {
  private readonly image: string;
  private readonly projectDir: string;
  private readonly resolvedPlatform: string | undefined;

  constructor(options: NpmDockerRunnerOptions) {
    this.image = options.image ?? NPM_DEFAULT_IMAGE;
    this.projectDir = options.projectDir;
    this.resolvedPlatform = resolvePlatform(options.platform);
  }

  /**
   * Run an npm command inside an ephemeral container with real-time streaming
   * of stdout/stderr to logger.info, while still capturing both streams for
   * returning in `ContainerRunResult`.
   *
   * Use this for long-running steps (npm ci, npm install) where progress
   * visibility is important.
   *
   * @param args - npm subcommand + arguments.
   * @returns `ContainerRunResult` with exitCode, stdout, and stderr.
   */
  async runStreaming(args: string[]): Promise<ContainerRunResult> {
    const dockerArgs = this._buildDockerArgs(args);

    logger.debug(`NpmDockerRunner (streaming): docker ${dockerArgs.join(' ')}`);

    return new Promise<ContainerRunResult>((resolve) => {
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];

      const child = spawn('docker', dockerArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdoutChunks.push(text);
        for (const line of text.split('\n')) {
          if (line.trim()) logger.info(`[npm] ${line}`);
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stderrChunks.push(text);
        for (const line of text.split('\n')) {
          if (line.trim()) logger.info(`[npm] ${line}`);
        }
      });

      child.on('close', (code) => {
        const exitCode = typeof code === 'number' ? code : 1;
        logger.debug(`NpmDockerRunner (streaming): npm container exited ${exitCode}`);
        resolve({
          exitCode,
          stdout: stdoutChunks.join(''),
          stderr: stderrChunks.join(''),
        });
      });

      child.on('error', (err) => {
        logger.debug(`NpmDockerRunner (streaming): spawn error: ${err.message}`);
        resolve({
          exitCode: 1,
          stdout: stdoutChunks.join(''),
          stderr: err.message,
        });
      });
    });
  }

  /**
   * Run an npm command inside an ephemeral container.
   *
   * @param args - npm subcommand + arguments (e.g. `['install']`, `['update', 'pkg']`).
   *   `'npm'` is automatically prepended as the container entrypoint.
   * @returns `ContainerRunResult` with exitCode, stdout, and stderr.
   */
  async run(args: string[]): Promise<ContainerRunResult> {
    const dockerArgs = this._buildDockerArgs(args);

    logger.debug(`NpmDockerRunner: docker ${dockerArgs.join(' ')}`);

    let containerResult: ContainerRunResult;
    try {
      containerResult = await withRetry(
        async (): Promise<ContainerRunResult> => {
          try {
            const { stdout, stderr } = await execFileAsync('docker', dockerArgs);
            logger.debug('NpmDockerRunner: npm container exited 0');
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
        `NpmDockerRunner: npm container exited ${typeof e.exitCode === 'number' ? e.exitCode : 1}`,
      );
      containerResult = {
        exitCode: typeof e.exitCode === 'number' ? e.exitCode : 1,
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? e.message ?? String(err),
      };
    }
    return containerResult;
  }

  /**
   * Execute an arbitrary shell command inside the container via `sh -c`.
   * `command` is a single argv element passed to `sh -c` — not interpolated.
   */
  async runShell(command: string, opts?: { cwd?: string }): Promise<ContainerRunResult> {
    const dockerArgs = this._buildShellDockerArgs(command, opts?.cwd);
    logger.debug(`NpmDockerRunner (shell): docker ${dockerArgs.join(' ')}`);

    let containerResult: ContainerRunResult;
    try {
      containerResult = await withRetry(
        async (): Promise<ContainerRunResult> => {
          try {
            const { stdout, stderr } = await execFileAsync('docker', dockerArgs);
            return { exitCode: 0, stdout, stderr };
          } catch (err: unknown) {
            const spawnErr = err as { code?: number; stdout?: string; stderr?: string; message?: string };
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
      logger.debug(`NpmDockerRunner (shell): container exited ${typeof e.exitCode === 'number' ? e.exitCode : 1}`);
      containerResult = {
        exitCode: typeof e.exitCode === 'number' ? e.exitCode : 1,
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? e.message ?? String(err),
      };
    }
    return containerResult;
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  /**
   * Assemble the full `docker run` argument array.
   * Exposed for testability — does not invoke Docker.
   */
  _buildDockerArgs(npmArgs: string[]): string[] {
    const args: string[] = ['run', '--rm'];

    if (this.resolvedPlatform !== undefined) {
      args.push('--platform', this.resolvedPlatform);
    }

    // Read-write mount so npm can update package-lock.json and node_modules
    args.push('--volume', `${this.projectDir}:/project`);
    args.push('--workdir', '/project');

    if (needsHostGateway()) {
      args.push('--add-host', 'host.docker.internal:host-gateway');
    }

    args.push(this.image);

    // Entrypoint is npm — pass the subcommand args
    args.push('npm', ...npmArgs);

    return args;
  }

  /**
   * Assemble the full `docker run` argument array for an arbitrary shell command.
   * Exposed for testability — does not invoke Docker.
   *
   * `command` is passed as a single argv element to `sh -c` — not interpolated.
   */
  _buildShellDockerArgs(command: string, cwd?: string): string[] {
    const args: string[] = ['run', '--rm'];

    if (this.resolvedPlatform !== undefined) {
      args.push('--platform', this.resolvedPlatform);
    }

    args.push('--volume', `${cwd ?? this.projectDir}:/project`);
    args.push('--workdir', '/project');

    if (needsHostGateway()) {
      args.push('--add-host', 'host.docker.internal:host-gateway');
    }

    args.push(this.image);
    // command is a SINGLE argv element passed to sh -c — not interpolated
    args.push('sh', '-c', command);

    return args;
  }
}
