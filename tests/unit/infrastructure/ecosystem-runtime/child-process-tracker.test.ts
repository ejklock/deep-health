/**
 * Unit tests for child-process-tracker.
 *
 * The shutdown hook system is mocked so we can capture and invoke the registered
 * hook directly without triggering real signal handling or process.exit().
 *
 * `node:child_process` is NOT mocked at module level — we create fake ChildProcess-
 * shaped objects manually so we can control their state precisely.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

// ─── Capture the registered shutdown hook ────────────────────────────────────

let capturedHook: (() => Promise<void> | void) | null = null;

vi.mock('@infra/utils/shutdown-hooks', () => ({
  registerShutdownHook: (hook: () => Promise<void> | void) => {
    capturedHook = hook;
    return () => { capturedHook = null; };
  },
}));

vi.mock('@infra/utils/logger.js', () => ({
  logger: {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(),
    error: vi.fn(), phase: vi.fn(), skip: vi.fn(),
    header: vi.fn(), tagged: vi.fn(),
  },
}));

import {
  trackChildProcess,
  trackKillable,
  execFileTracked,
  _activeChildCount,
  _resetTracker,
} from '@infra/ecosystem-runtime/child-process-tracker';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Create a fake ChildProcess-shaped EventEmitter for testing. */
function makeFakeChild(opts: { killed?: boolean; exitCode?: number | null } = {}): ChildProcess {
  const emitter = new EventEmitter() as unknown as ChildProcess;
  (emitter as unknown as Record<string, unknown>).killed = opts.killed ?? false;
  (emitter as unknown as Record<string, unknown>).exitCode = opts.exitCode ?? null;
  (emitter as unknown as Record<string, unknown>).kill = vi.fn((_sig?: string) => {
    (emitter as unknown as Record<string, unknown>).killed = true;
    return true;
  });
  return emitter;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('trackChildProcess', () => {
  beforeEach(() => {
    capturedHook = null;
    _resetTracker();
  });

  afterEach(() => {
    _resetTracker();
  });

  it('adds a child process to the active count', () => {
    const child = makeFakeChild();
    trackChildProcess(child);
    expect(_activeChildCount()).toBe(1);
  });

  it('auto-removes the child when it emits "close"', () => {
    const child = makeFakeChild();
    trackChildProcess(child);
    expect(_activeChildCount()).toBe(1);

    child.emit('close', 0, null);
    expect(_activeChildCount()).toBe(0);
  });

  it('auto-removes the child when it emits "exit"', () => {
    const child = makeFakeChild();
    trackChildProcess(child);
    expect(_activeChildCount()).toBe(1);

    child.emit('exit', 0, null);
    expect(_activeChildCount()).toBe(0);
  });

  it('registers the shutdown hook on the first call (not on subsequent calls)', () => {
    // capturedHook is null before any tracking
    expect(capturedHook).toBeNull();

    const child1 = makeFakeChild();
    trackChildProcess(child1);
    const hookAfterFirst = capturedHook;
    expect(hookAfterFirst).not.toBeNull();

    // A second track should not replace the hook reference
    const child2 = makeFakeChild();
    trackChildProcess(child2);
    expect(capturedHook).toBe(hookAfterFirst);
  });

  it('tracks multiple children independently', () => {
    const child1 = makeFakeChild();
    const child2 = makeFakeChild();
    trackChildProcess(child1);
    trackChildProcess(child2);
    expect(_activeChildCount()).toBe(2);

    child1.emit('close', 0, null);
    expect(_activeChildCount()).toBe(1);

    child2.emit('exit', 0, null);
    expect(_activeChildCount()).toBe(0);
  });
});

describe('trackKillable', () => {
  beforeEach(() => {
    capturedHook = null;
    _resetTracker();
  });

  afterEach(() => {
    _resetTracker();
  });

  it('adds a killable to the active count', () => {
    const killable = { kill: vi.fn(), pid: 9999 };
    trackKillable(killable);
    expect(_activeChildCount()).toBe(1);
  });

  it('handles multiple killables', () => {
    trackKillable({ kill: vi.fn() });
    trackKillable({ kill: vi.fn() });
    expect(_activeChildCount()).toBe(2);
  });
});

describe('shutdown hook — kills all tracked processes', () => {
  beforeEach(() => {
    capturedHook = null;
    _resetTracker();
    vi.useFakeTimers();
  });

  afterEach(() => {
    _resetTracker();
    vi.useRealTimers();
  });

  it('sends SIGTERM to tracked child processes on shutdown', async () => {
    const child = makeFakeChild();
    trackChildProcess(child);

    expect(capturedHook).not.toBeNull();

    const hookPromise = capturedHook!();
    // Advance past the 2 s grace period
    await vi.advanceTimersByTimeAsync(2_100);
    await hookPromise;

    expect((child as unknown as Record<string, unknown>).kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('sends SIGKILL to survivor processes after grace period', async () => {
    // Create a child whose kill() does NOT set killed=true, simulating a
    // process that ignores SIGTERM and stays alive through the grace period.
    const child = makeFakeChild({ killed: false, exitCode: null });
    const killCalls: string[] = [];
    (child as unknown as Record<string, unknown>).kill = vi.fn((sig?: string) => {
      killCalls.push(sig ?? 'SIGTERM');
      // Intentionally do NOT set killed=true so the SIGKILL branch triggers
      return true;
    });
    trackChildProcess(child);

    const hookPromise = capturedHook!();
    await vi.advanceTimersByTimeAsync(2_100);
    await hookPromise;

    expect(killCalls).toContain('SIGTERM');
    expect(killCalls).toContain('SIGKILL');
  });

  it('does not send SIGKILL to a process that already exited', async () => {
    // exitCode=0 and killed=true simulates a process that stopped cleanly on SIGTERM
    const child = makeFakeChild({ killed: true, exitCode: 0 });
    trackChildProcess(child);

    const hookPromise = capturedHook!();
    await vi.advanceTimersByTimeAsync(2_100);
    await hookPromise;

    const killMock = (child as unknown as Record<string, unknown>).kill as ReturnType<typeof vi.fn>;
    const calls = killMock.mock.calls as [string][];
    // Only SIGTERM should have been sent; no SIGKILL since killed===true
    expect(calls.map((c) => c[0])).not.toContain('SIGKILL');
  });

  it('sends SIGTERM and SIGKILL to tracked killables on shutdown', async () => {
    const killFn = vi.fn();
    trackKillable({ kill: killFn });

    const hookPromise = capturedHook!();
    await vi.advanceTimersByTimeAsync(2_100);
    await hookPromise;

    const calls = killFn.mock.calls as [string][];
    expect(calls.map((c) => c[0])).toContain('SIGTERM');
    expect(calls.map((c) => c[0])).toContain('SIGKILL');
  });

  it('does not throw when a process kill() call throws (already exited)', async () => {
    const child = makeFakeChild();
    // Override kill to throw so we can verify errors are swallowed
    (child as unknown as Record<string, unknown>).kill = vi.fn(() => {
      throw new Error('process already exited');
    });
    trackChildProcess(child);

    const hookPromise = capturedHook!();
    await vi.advanceTimersByTimeAsync(2_100);
    // Should resolve without throwing
    await expect(hookPromise).resolves.toBeUndefined();
  });

  it('is a no-op when no processes are tracked', async () => {
    // capturedHook will not be registered if no processes were tracked,
    // so we manually trigger a track to get the hook, then reset the set.
    const child = makeFakeChild();
    trackChildProcess(child);
    child.emit('close', 0, null); // auto-remove

    expect(_activeChildCount()).toBe(0);
    // Hook exists but should return early
    const hookPromise = capturedHook!();
    await vi.advanceTimersByTimeAsync(2_100);
    await hookPromise;
    // No error thrown — pass
  });
});

describe('execFileTracked', () => {
  beforeEach(() => {
    capturedHook = null;
    _resetTracker();
  });

  afterEach(() => {
    _resetTracker();
  });

  it('resolves with stdout and stderr on success', async () => {
    // Use a simple command that exits 0
    const result = await execFileTracked(process.execPath, ['--version']);
    expect(result).toHaveProperty('stdout');
    expect(result).toHaveProperty('stderr');
    expect(typeof result.stdout).toBe('string');
  });

  it('rejects with code, stdout, stderr on failure', async () => {
    let caught: unknown;
    try {
      await execFileTracked(process.execPath, ['-e', 'process.exit(42)']);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const e = caught as { code?: unknown; stdout?: string; stderr?: string };
    expect(e).toHaveProperty('code');
    expect(e).toHaveProperty('stdout');
    expect(e).toHaveProperty('stderr');
  });

  it('accepts maxBuffer option without error', async () => {
    const result = await execFileTracked(process.execPath, ['--version'], { maxBuffer: 512 });
    expect(result.stdout).toBeTruthy();
  });
});
