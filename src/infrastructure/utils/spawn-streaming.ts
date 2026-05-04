/**
 * spawnStreaming — run a subprocess and stream its output line-by-line via logger.tagged.
 *
 * Designed for long-running Docker operations (docker build, docker pull) where
 * the user needs real-time feedback rather than silence until completion.
 *
 * stdout lines → logger.tagged(logPrefix, label, line, stdoutLevel)
 * stderr lines → logger.tagged(logPrefix, label, line, stderrLevel)
 *
 * Returns { exitCode, stdout, stderr } matching the execFileAsync shape.
 * Never throws — caller checks exitCode.
 *
 * @module
 */

import { spawn } from 'node:child_process';
import type { LogLevel } from './logger';
import { logger } from './logger';

export interface SpawnStreamingOptions {
  /** Executable to run (e.g. 'docker'). */
  file: string;
  /** Argument list. */
  args: string[];
  /** Log prefix forwarded to logger.tagged as first argument. */
  logPrefix: string;
  /** Label forwarded to logger.tagged as second argument. */
  label: string;
  /**
   * Log level for stdout lines.
   * Default: 'debug'. Use 'info' for build/pull output lines.
   */
  stdoutLevel?: LogLevel;
  /**
   * Log level for stderr lines.
   * Default: 'debug'.
   */
  stderrLevel?: LogLevel;
  /**
   * Optional timeout in milliseconds. When elapsed, the child process is
   * killed with SIGKILL and the result has `timedOut: true` with a
   * descriptive stderr message.
   */
  timeoutMs?: number;
}

export interface SpawnStreamingResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when the child was killed due to timeoutMs being exceeded. */
  timedOut: boolean;
}

/**
 * Spawn a subprocess and stream its stdout/stderr line-by-line via logger.tagged,
 * while also collecting the full output for error reporting.
 *
 * Never rejects — resolves with the exit code even on failure.
 * Callers are responsible for inspecting `exitCode` and acting on failure.
 */
export async function spawnStreaming(
  options: SpawnStreamingOptions,
): Promise<SpawnStreamingResult> {
  const {
    file,
    args,
    logPrefix,
    label,
    stdoutLevel = 'debug',
    stderrLevel = 'debug',
    timeoutMs,
  } = options;

  return new Promise<SpawnStreamingResult>((resolve) => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let killedByTimeout = false;

    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs !== undefined) {
      timeoutHandle = setTimeout(() => {
        killedByTimeout = true;
        try {
          if (child.pid != null) process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }, timeoutMs);
    }

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdoutChunks.push(text);
      for (const line of text.split('\n')) {
        if (line.trim()) {
          logger.tagged(logPrefix, label, line, stdoutLevel);
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderrChunks.push(text);
      for (const line of text.split('\n')) {
        if (line.trim()) {
          logger.tagged(logPrefix, label, line, stderrLevel);
        }
      }
    });

    child.on('close', (code) => {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      if (killedByTimeout) {
        resolve({
          exitCode: 1,
          stdout: stdoutChunks.join(''),
          stderr: `Timed out after ${timeoutMs}ms`,
          timedOut: true,
        });
        return;
      }
      resolve({
        exitCode: typeof code === 'number' ? code : 1,
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join(''),
        timedOut: false,
      });
    });

    child.on('error', (err) => {
      // spawn itself failed (e.g. binary not found) — treat as exit code 1.
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      resolve({
        exitCode: 1,
        stdout: stdoutChunks.join(''),
        stderr: err.message,
        timedOut: false,
      });
    });
  });
}
