/**
 * Ephemeral Ecosystem Container — single parameterized runner
 *
 * Replaces the three legacy *DockerRunner classes (NpmDockerRunner,
 * PipDockerRunner, ComposerDockerRunner) with a single class parameterized
 * by RunMode.
 *
 * ─── SEC-004: Trust boundary ─────────────────────────────────────────────────
 * `tokens` received by `run()` and `runStreaming()` are a pre-tokenized argv
 * array. For `RunMode.kind === 'direct-exec'`, tokens are passed as independent
 * argv elements — no shell parsing, no injection risk.
 *
 * For `RunMode.kind === 'shell-wrap'`, tokens are joined with spaces and passed
 * to `sh -lc`. Variable data (package names, versions, branch names) MUST be
 * free of shell metacharacters at the call site. The runtime does NOT sanitize.
 * This mirrors the trust-boundary contract in the legacy *DockerRunner files.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { RunMode } from './types';
import type { ContainerRunResult } from './types';
import type { EphemeralContainerRunner } from '@infra/provisioner/types';
import { needsHostGateway, resolvePlatform } from '../utils/docker-platform';
import { withRetry, isDockerTransientError } from '../utils/retry';
import { logger } from '../utils/logger';
import { spawnStreaming } from '../utils/spawn-streaming';

const execFileAsync = promisify(execFile);

// ─── EphemeralEcosystemContainerOptions ──────────────────────────────────────

export interface EphemeralEcosystemContainerOptions {
  /** How argv composes into the docker run command line. */
  runMode: RunMode;
  /** Absolute path of the project directory — mounted read-write at /project. */
  projectDir: string;
  /** Resolved Docker image to run. */
  image: string;
  /** Optional --platform value. */
  platform?: string;
  /** Log prefix tag, e.g. 'npm' / 'pip' / 'composer'. Used in stream-line tags. */
  logPrefix: string;
  /**
   * When set, `--entrypoint <value>` is injected into every `docker run` call.
   * Pass `""` (empty string) to clear the image's ENTRYPOINT so the ecosystem
   * binary is invoked directly without being shadowed.
   *
   * This MUST be set when the image was built from a project-owned Dockerfile
   * (image_source='dockerfile') to prevent the image ENTRYPOINT from hijacking
   * the ecosystem CLI command.  Produced by `buildProjectImage()`.
   */
  entrypointOverride?: string;
}

// ─── EphemeralEcosystemContainer ─────────────────────────────────────────────

/**
 * One-shot ephemeral container runner for any ecosystem CLI.
 *
 * Implements `EphemeralContainerRunner<string[]>`.
 *
 * Each `run()` call:
 *  1. Assembles a `docker run --rm` command with the project directory mounted
 *     read-write at `/project` and `--workdir /project`.
 *  2. Executes the CLI inside the container, dispatching on `runMode.kind`:
 *     - `'direct-exec'`: argv reaches the container's process without a shell.
 *     - `'shell-wrap'`: argv is joined and run via `sh -lc` (with optional preamble).
 *  3. Returns `ContainerRunResult` with `exitCode`, `stdout`, and `stderr`.
 *
 * On Linux, `--add-host=host.docker.internal:host-gateway` is automatically
 * added (host-gateway support from `needsHostGateway()`).
 */
export class EphemeralEcosystemContainer implements EphemeralContainerRunner<string[]> {
  private readonly image: string;
  private readonly projectDir: string;
  private readonly resolvedPlatform: string | undefined;
  private readonly runMode: RunMode;
  private readonly logPrefix: string;
  private readonly entrypointOverride: string | undefined;

  constructor(options: EphemeralEcosystemContainerOptions) {
    this.image = options.image;
    this.projectDir = options.projectDir;
    this.resolvedPlatform = resolvePlatform(options.platform);
    this.runMode = options.runMode;
    this.logPrefix = options.logPrefix;
    this.entrypointOverride = options.entrypointOverride;
  }

  /**
   * Run an ecosystem CLI command inside an ephemeral container with real-time
   * streaming of stdout/stderr to logger.info, while still capturing both
   * streams for returning in `ContainerRunResult`.
   *
   * Use this for long-running steps (install, update) where progress
   * visibility is important.
   *
   * @param tokens - CLI subcommand + arguments.
   * @returns `ContainerRunResult` with exitCode, stdout, and stderr.
   */
  async runStreaming(tokens: string[]): Promise<ContainerRunResult> {
    const dockerArgs = this._buildDockerArgs(tokens);

    logger.debug(`EphemeralEcosystemContainer[${this.logPrefix}] (streaming): docker ${dockerArgs.join(' ')}`);

    return new Promise<ContainerRunResult>((resolve) => {
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];

      const child = spawn('docker', dockerArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdoutChunks.push(text);
        for (const line of text.split('\n')) {
          if (line.trim()) logger.tagged(this.logPrefix, this.logPrefix, line);
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stderrChunks.push(text);
        for (const line of text.split('\n')) {
          if (line.trim()) logger.tagged(this.logPrefix, this.logPrefix, line);
        }
      });

      child.on('close', (code) => {
        const exitCode = typeof code === 'number' ? code : 1;
        logger.debug(`EphemeralEcosystemContainer[${this.logPrefix}] (streaming): container exited ${exitCode}`);
        resolve({
          exitCode,
          stdout: stdoutChunks.join(''),
          stderr: stderrChunks.join(''),
        });
      });

      child.on('error', (err) => {
        logger.debug(`EphemeralEcosystemContainer[${this.logPrefix}] (streaming): spawn error: ${err.message}`);
        resolve({
          exitCode: 1,
          stdout: stdoutChunks.join(''),
          stderr: err.message,
        });
      });
    });
  }

  /**
   * Run an ecosystem CLI command inside an ephemeral container.
   *
   * @param tokens - CLI subcommand + arguments.
   * @returns `ContainerRunResult` with exitCode, stdout, and stderr.
   */
  async run(tokens: string[]): Promise<ContainerRunResult> {
    await this._ensureImagePresent();

    const dockerArgs = this._buildDockerArgs(tokens);

    logger.debug(`EphemeralEcosystemContainer[${this.logPrefix}]: docker ${dockerArgs.join(' ')}`);

    let containerResult: ContainerRunResult;
    try {
      containerResult = await withRetry(
        async (): Promise<ContainerRunResult> => {
          try {
            const { stdout, stderr } = await execFileAsync('docker', dockerArgs);
            logger.debug(`EphemeralEcosystemContainer[${this.logPrefix}]: container exited 0`);
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
        `EphemeralEcosystemContainer[${this.logPrefix}]: container exited ${typeof e.exitCode === 'number' ? e.exitCode : 1}`,
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
   *
   * When `runMode.kind === 'shell-wrap'` and a preamble is defined, the
   * preamble is prepended before the command.
   */
  async runShell(command: string, opts?: { cwd?: string }): Promise<ContainerRunResult> {
    await this._ensureImagePresent();

    const dockerArgs = this._buildShellDockerArgs(command, opts?.cwd);
    logger.debug(`EphemeralEcosystemContainer[${this.logPrefix}] (shell): docker ${dockerArgs.join(' ')}`);

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
      logger.debug(`EphemeralEcosystemContainer[${this.logPrefix}] (shell): container exited ${typeof e.exitCode === 'number' ? e.exitCode : 1}`);
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
   * Pull the container image if it is not already present in the local Docker
   * cache. Streams pull progress via logger.tagged at 'info' level.
   *
   * No-op when the image is already cached — probed via `docker image inspect`.
   * Does NOT throw on pull failure; the subsequent `docker run` will surface its
   * own error with a clear message.
   */
  private async _ensureImagePresent(): Promise<void> {
    try {
      await execFileAsync('docker', ['image', 'inspect', this.image]);
      // Image is already cached — nothing to do.
      return;
    } catch {
      // Image not found locally — proceed to pull.
    }

    logger.tagged(
      this.logPrefix,
      'docker pull',
      `Pulling image: ${this.image}`,
    );

    await spawnStreaming({
      file: 'docker',
      args: ['pull', this.image],
      logPrefix: this.logPrefix,
      label: 'docker pull',
      stdoutLevel: 'info',
      stderrLevel: 'info',
    });
    // Pull failure is intentionally swallowed — the downstream docker run will
    // fail with a descriptive error if the image is still unavailable.
  }

  /**
   * Assemble the shared base `docker run` flags (before image and command).
   * Exposed for testability — does not invoke Docker.
   */
  private _buildBaseArgs(cwd?: string): string[] {
    const args: string[] = ['run', '--rm'];

    // Defense in depth (ADR-0002):
    //   --cap-drop=ALL drops every Linux capability — package managers don't
    //   need any. A hostile validation command from a compromised
    //   project-config.yml loses the ability to use raw sockets, ptrace, mount
    //   filesystems, change ownership, etc.
    //   --security-opt=no-new-privileges blocks setuid binaries inside the
    //   container from escalating, even if the image ships one.
    args.push('--cap-drop=ALL');
    args.push('--security-opt', 'no-new-privileges');

    if (this.resolvedPlatform !== undefined) {
      args.push('--platform', this.resolvedPlatform);
    }

    // When an entrypoint override is set (e.g. "" for project-built images),
    // inject --entrypoint before the image name so the image's ENTRYPOINT cannot
    // hijack the ecosystem CLI binary. ADR-0001 requires this universally for
    // project-dockerfile images to prevent entrypoint shadowing.
    if (this.entrypointOverride !== undefined) {
      args.push('--entrypoint', this.entrypointOverride);
    }

    args.push('--volume', `${cwd ?? this.projectDir}:/project`);
    args.push('--workdir', '/project');

    if (needsHostGateway()) {
      args.push('--add-host', 'host.docker.internal:host-gateway');
    }

    return args;
  }

  /**
   * Assemble the full `docker run` argument array for a tokenized command.
   * Exposed for testability — does not invoke Docker.
   *
   * Dispatches on `runMode.kind`:
   * - `'direct-exec'`: appends `[runMode.binary, ...tokens]` — no shell layer.
   * - `'shell-wrap'`: joins tokens, optionally prepends preamble, runs via `sh -lc`.
   */
  _buildDockerArgs(tokens: string[]): string[] {
    const args = this._buildBaseArgs();
    args.push(this.image);

    const { runMode } = this;
    if (runMode.kind === 'direct-exec') {
      const preamble = runMode.preamble?.(this.image);
      if (preamble) {
        // SEC-004: tokens stay as independent argv elements via "$@" — no shell re-tokenization.
        args.push('sh', '-lc', `${preamble} && exec "$@"`, '--', runMode.binary, ...tokens);
      } else {
        args.push(runMode.binary, ...tokens);
      }
    } else {
      // shell-wrap
      const joined = tokens.join(' ');
      const preamble = runMode.preamble?.(this.image);
      const shellCmd = preamble ? `${preamble} && ${joined}` : joined;
      args.push('sh', '-lc', shellCmd);
    }

    return args;
  }

  /**
   * Assemble the full `docker run` argument array for an arbitrary shell command.
   * Exposed for testability — does not invoke Docker.
   *
   * `command` is passed as a single argv element to `sh -c` — not interpolated.
   * Note: uses `-c` (not `-lc`) to preserve the legacy `runShell` behavior.
   *
   * When `runMode.kind === 'shell-wrap'` and a preamble is defined, the preamble
   * is prepended before the command.
   */
  _buildShellDockerArgs(command: string, cwd?: string): string[] {
    const args = this._buildBaseArgs(cwd);
    args.push(this.image);

    const preamble = this.runMode.preamble?.(this.image);
    const shellCmd = preamble ? `${preamble} && ${command}` : command;
    // shellCmd is a SINGLE argv element passed to sh -c — not interpolated
    args.push('sh', '-c', shellCmd);

    return args;
  }
}
