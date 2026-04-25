import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../utils/logger';
import { needsHostGateway, resolvePlatform } from '../utils/docker-platform';
import { withRetry, isDockerTransientError } from '../utils/retry';
import type { EphemeralContainerRunner, ContainerRunResult } from './types';

const execFileAsync = promisify(execFile);

/**
 * Default Python Docker image used when no specific Python version is configured or inferred.
 */
export const PIP_DEFAULT_IMAGE = 'python:3-slim';

/**
 * Resolve the Docker image to use for a given Python version hint.
 *
 * @param version - Inferred/configured Python version string (e.g. "3.11", "3.11.2", "3").
 *   When undefined or empty, falls back to `PIP_DEFAULT_IMAGE`.
 * @returns Docker image name, e.g. `'python:3.11-slim'` or `'python:3-slim'`.
 */
export function resolvePipDockerImage(version?: string): string {
  if (!version || !version.trim()) return PIP_DEFAULT_IMAGE;

  const parts = version.trim().split('.');
  // Take up to 2 numeric segments (major.minor)
  const numericParts: string[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) break;
    numericParts.push(part);
    if (numericParts.length === 2) break;
  }

  if (numericParts.length === 0) return PIP_DEFAULT_IMAGE;

  return `python:${numericParts.join('.')}-slim`;
}

// ─── PipDockerRunnerOptions ──────────────────────────────────────────────────

export interface PipDockerRunnerOptions {
  /**
   * Absolute path of the project directory to mount into the container.
   * Mounted read-write at `/project` inside the container.
   */
  projectDir: string;

  /**
   * Docker image to use for the Python/pip container.
   * Defaults to `PIP_DEFAULT_IMAGE` (`python:3-slim`).
   */
  image?: string;

  /**
   * Docker platform string to pass via `--platform` (e.g. `'linux/amd64'`).
   * When omitted, no `--platform` flag is injected (native architecture used).
   */
  platform?: string;
}

// ─── PipDockerRunner ─────────────────────────────────────────────────────────

/**
 * One-shot ephemeral container runner for pip commands.
 *
 * Implements `EphemeralContainerRunner<string[]>`.
 *
 * Each `run()` call:
 *  1. Assembles a `docker run --rm` command with the project directory mounted
 *     read-write at `/project` and `--workdir /project`.
 *  2. Executes arbitrary pip/python commands inside the container via `sh -lc`.
 *  3. Returns `ContainerRunResult` with `exitCode`, `stdout`, and `stderr`.
 *
 * On Linux, `--add-host=host.docker.internal:host-gateway` is automatically
 * added (host-gateway support from `needsHostGateway()`).
 */
export class PipDockerRunner implements EphemeralContainerRunner<string[]> {
  private readonly image: string;
  private readonly projectDir: string;
  private readonly resolvedPlatform: string | undefined;

  constructor(options: PipDockerRunnerOptions) {
    this.image = options.image ?? PIP_DEFAULT_IMAGE;
    this.projectDir = options.projectDir;
    this.resolvedPlatform = resolvePlatform(options.platform);
  }

  /**
   * Run a pip command inside an ephemeral container with real-time streaming
   * of stdout/stderr to logger.info, while still capturing both streams for
   * returning in `ContainerRunResult`.
   *
   * @param cmdTokens - command tokens (e.g. `['pip', 'install', '-U', 'pkg']`).
   * @returns `ContainerRunResult` with exitCode, stdout, and stderr.
   */
  async runStreaming(cmdTokens: string[]): Promise<ContainerRunResult> {
    const dockerArgs = this._buildDockerArgs(cmdTokens);

    logger.debug(`PipDockerRunner (streaming): docker ${dockerArgs.join(' ')}`);

    return new Promise<ContainerRunResult>((resolve) => {
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];

      const child = spawn('docker', dockerArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdoutChunks.push(text);
        for (const line of text.split('\n')) {
          if (line.trim()) logger.info(`[pip] ${line}`);
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stderrChunks.push(text);
        for (const line of text.split('\n')) {
          if (line.trim()) logger.info(`[pip] ${line}`);
        }
      });

      child.on('close', (code) => {
        const exitCode = typeof code === 'number' ? code : 1;
        logger.debug(`PipDockerRunner (streaming): pip container exited ${exitCode}`);
        resolve({
          exitCode,
          stdout: stdoutChunks.join(''),
          stderr: stderrChunks.join(''),
        });
      });

      child.on('error', (err) => {
        logger.debug(`PipDockerRunner (streaming): spawn error: ${err.message}`);
        resolve({
          exitCode: 1,
          stdout: stdoutChunks.join(''),
          stderr: err.message,
        });
      });
    });
  }

  /**
   * Run a pip command inside an ephemeral container.
   *
   * @param cmdTokens - command tokens passed as a shell command string via `sh -lc`.
   * @returns `ContainerRunResult` with exitCode, stdout, and stderr.
   */
  async run(cmdTokens: string[]): Promise<ContainerRunResult> {
    const dockerArgs = this._buildDockerArgs(cmdTokens);

    logger.debug(`PipDockerRunner: docker ${dockerArgs.join(' ')}`);

    let containerResult: ContainerRunResult;
    try {
      containerResult = await withRetry(
        async (): Promise<ContainerRunResult> => {
          try {
            const { stdout, stderr } = await execFileAsync('docker', dockerArgs);
            logger.debug('PipDockerRunner: pip container exited 0');
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
        `PipDockerRunner: pip container exited ${typeof e.exitCode === 'number' ? e.exitCode : 1}`,
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
    logger.debug(`PipDockerRunner (shell): docker ${dockerArgs.join(' ')}`);

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
      logger.debug(`PipDockerRunner (shell): container exited ${typeof e.exitCode === 'number' ? e.exitCode : 1}`);
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
   *
   * Commands are passed via `sh -lc` to allow shell-level features.
   */
  _buildDockerArgs(cmdTokens: string[]): string[] {
    const args: string[] = ['run', '--rm'];

    if (this.resolvedPlatform !== undefined) {
      args.push('--platform', this.resolvedPlatform);
    }

    // Read-write mount so pip can update requirements.txt and site-packages
    args.push('--volume', `${this.projectDir}:/project`);
    args.push('--workdir', '/project');

    if (needsHostGateway()) {
      args.push('--add-host', 'host.docker.internal:host-gateway');
    }

    args.push(this.image, 'sh', '-lc', cmdTokens.join(' '));

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
