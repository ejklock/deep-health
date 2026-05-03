/**
 * Child-process tracker for ephemeral Docker containers.
 *
 * Maintains a registry of active child processes spawned by docker-run calls so
 * that they can be killed when the process receives SIGINT/SIGTERM. Without this,
 * Node.js exits immediately on signal and the docker client processes are
 * orphaned — Docker containers keep running even though the CLI has exited.
 *
 * The `--rm` flag only cleans up a container when the docker client exits
 * normally. By sending SIGTERM to the tracked processes and then SIGKILL to any
 * survivors, we give Docker a chance to stop and remove the containers.
 *
 * Usage:
 *   - `trackChildProcess(child)` — register a ChildProcess from spawn/execFile.
 *   - `trackKillable(obj)` — register any object with a `.kill()` method (e.g. execa).
 *   - `execFileTracked(cmd, args, opts?)` — drop-in replacement for execFileAsync
 *     that also tracks the underlying ChildProcess.
 */

import { execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { registerShutdownHook } from '../utils/shutdown-hooks';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Killable {
  kill(signal?: string | number): void;
  pid?: number;
}

export interface ExecFileTrackedOptions {
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
}

// ─── State ────────────────────────────────────────────────────────────────────

const activeProcesses = new Set<ChildProcess>();
const activeKillables = new Set<Killable>();
let hookRegistered = false;

// ─── Shutdown hook (registered once) ─────────────────────────────────────────

function ensureShutdownHookRegistered(): void {
  if (hookRegistered) return;
  hookRegistered = true;

  registerShutdownHook(async () => {
    const processes = Array.from(activeProcesses);
    const killables = Array.from(activeKillables);

    if (processes.length === 0 && killables.length === 0) return;

    // Send SIGTERM to all tracked processes first — give Docker a chance to
    // stop and remove the container gracefully (--rm relies on a clean exit).
    for (const child of processes) {
      try {
        child.kill('SIGTERM');
      } catch {
        // Process may have already exited — ignore.
      }
    }
    for (const killable of killables) {
      try {
        killable.kill('SIGTERM');
      } catch {
        // Already dead — ignore.
      }
    }

    // Wait up to 2 seconds for processes to exit, then SIGKILL survivors.
    // Total grace + SIGKILL window must stay within HOOK_TIMEOUT_MS (7 s).
    await new Promise<void>((resolve) => setTimeout(resolve, 2_000));

    for (const child of processes) {
      if (!child.killed && child.exitCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          // Best effort — ignore errors.
        }
      }
    }
    for (const killable of killables) {
      try {
        killable.kill('SIGKILL');
      } catch {
        // Best effort — ignore errors.
      }
    }
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Track a `ChildProcess` returned by `spawn()` or `execFile()`.
 *
 * The process is automatically removed from the tracker when it emits
 * 'close' or 'exit' so the set does not accumulate finished processes.
 *
 * On the first call, a single shutdown hook is registered that kills all
 * tracked processes on SIGINT/SIGTERM.
 */
export function trackChildProcess(child: ChildProcess): void {
  // Guard against test environments where execFile mocks return undefined.
  if (!child) return;

  ensureShutdownHookRegistered();
  activeProcesses.add(child);

  const remove = () => { activeProcesses.delete(child); };
  child.once('close', remove);
  child.once('exit', remove);
}

/**
 * Track any object with a `.kill()` method (e.g. an execa subprocess).
 *
 * Unlike `trackChildProcess`, there is no automatic removal from this set
 * because execa subprocess objects do not reliably emit Node `ChildProcess`
 * events by name. Callers can remove the object manually if needed, but since
 * `kill()` on an already-exited process is a no-op, leaving it in the set is
 * harmless.
 *
 * On the first call, a single shutdown hook is registered.
 */
export function trackKillable(obj: Killable): void {
  ensureShutdownHookRegistered();
  activeKillables.add(obj);
}

/**
 * Tracked drop-in replacement for `promisify(execFile)(cmd, args, opts)`.
 *
 * Uses the non-promisified `execFile()` so we get access to the underlying
 * `ChildProcess` and can call `trackChildProcess()` on it.
 *
 * Returns `Promise<{ stdout: string; stderr: string }>` on success.
 * On failure, rejects with `Object.assign(new Error(stderr), { code, stdout, stderr })`
 * — the same error shape produced by `promisify(execFile)`.
 */
export function execFileTracked(
  cmd: string,
  args: string[],
  opts?: ExecFileTrackedOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const callback = (err: Error | null, stdoutArg: string, stderrArg: string) => {
      if (err) {
        // Prefer callback args; fall back to properties on the error object
        // (matches the shape that promisify(execFile) error objects carry).
        const errProps = err as { code?: unknown; stdout?: string; stderr?: string };
        const exitCode = errProps.code;
        const code = typeof exitCode === 'number' ? exitCode : 1;
        const stdout = stdoutArg ?? errProps.stdout ?? '';
        // String(err) is the last resort — handles the case where err is a
        // non-Error object (e.g. a string primitive) with no .message property.
        const stderr = stderrArg ?? errProps.stderr ?? (err as unknown as { message?: string }).message ?? String(err);
        reject(Object.assign(new Error(stderr || String(err)), { code, stdout, stderr }));
      } else {
        resolve({ stdout: stdoutArg, stderr: stderrArg });
      }
    };

    // Only pass the options object when there are meaningful options — this
    // keeps the 3-argument call form when no options are needed, which is
    // what existing test mocks (vi.mock('node:child_process')) expect.
    const hasOpts = opts !== undefined && (opts.maxBuffer !== undefined || opts.env !== undefined);
    const child = hasOpts
      ? execFile(cmd, args, { maxBuffer: opts!.maxBuffer, env: opts!.env }, callback)
      : execFile(cmd, args, callback);

    trackChildProcess(child);
  });
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

/** Exposed for tests: number of currently tracked ChildProcess objects. */
export function _activeChildCount(): number {
  return activeProcesses.size + activeKillables.size;
}

/** Exposed for tests: reset tracker state between test cases. */
export function _resetTracker(): void {
  activeProcesses.clear();
  activeKillables.clear();
  hookRegistered = false;
}
