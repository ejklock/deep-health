/**
 * Unit tests for the shutdown-hooks registry.
 *
 * We avoid installing signal listeners against the real process by invoking
 * process.emit() directly in the test cases. The `_resetShutdownHooks()`
 * helper clears registered callbacks between tests without uninstalling the
 * Node process.on handlers (those are one-time installs and safe to keep).
 *
 * `process.exit` is stubbed so we can assert it was called with the right
 * code without actually killing the test runner.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  registerShutdownHook,
  _activeHookCount,
  _resetShutdownHooks,
} from '@infra/utils/shutdown-hooks';

vi.mock('@infra/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), phase: vi.fn(), skip: vi.fn(), header: vi.fn() },
}));

import { logger } from '@infra/utils/logger.js';

describe('registerShutdownHook', () => {
  beforeEach(() => {
    _resetShutdownHooks();
  });

  afterEach(() => {
    _resetShutdownHooks();
  });

  it('adds a hook to the registry', () => {
    const hook = vi.fn();
    registerShutdownHook(hook);

    expect(_activeHookCount()).toBe(1);
  });

  it('returns an unregister function that removes the hook', () => {
    const hook = vi.fn();
    const unregister = registerShutdownHook(hook);

    expect(_activeHookCount()).toBe(1);

    unregister();
    expect(_activeHookCount()).toBe(0);
  });

  it('registers multiple independent hooks', () => {
    registerShutdownHook(vi.fn());
    registerShutdownHook(vi.fn());
    registerShutdownHook(vi.fn());

    expect(_activeHookCount()).toBe(3);
  });
});

describe('signal-triggered hook execution', () => {
  // We install a fake process.exit so emitting a signal doesn't kill the runner.
  let originalExit: typeof process.exit;

  beforeEach(() => {
    _resetShutdownHooks();
    originalExit = process.exit;
    process.exit = vi.fn() as never;
  });

  afterEach(() => {
    process.exit = originalExit;
    _resetShutdownHooks();
  });

  it('SIGINT triggers registered hook with exit code 130', async () => {
    const hook = vi.fn().mockResolvedValue(undefined);
    registerShutdownHook(hook);

    process.emit('SIGINT');
    // Allow the async runAllHooks() to settle
    await new Promise((resolve) => setImmediate(resolve));

    expect(hook).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledWith(130);
  });

  it('SIGTERM triggers registered hook with exit code 143', async () => {
    const hook = vi.fn().mockResolvedValue(undefined);
    registerShutdownHook(hook);

    process.emit('SIGTERM');
    await new Promise((resolve) => setImmediate(resolve));

    expect(hook).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledWith(143);
  });

  it('runs all registered hooks in order on SIGINT', async () => {
    const order: string[] = [];
    registerShutdownHook(() => { order.push('first'); });
    registerShutdownHook(() => { order.push('second'); });
    registerShutdownHook(() => { order.push('third'); });

    process.emit('SIGINT');
    await new Promise((resolve) => setImmediate(resolve));

    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('a failing hook does not prevent subsequent hooks from running', async () => {
    const second = vi.fn();
    registerShutdownHook(() => { throw new Error('first hook boom'); });
    registerShutdownHook(second);

    process.emit('SIGINT');
    await new Promise((resolve) => setImmediate(resolve));

    expect(second).toHaveBeenCalledTimes(1);
  });

  it('logs String(err) when a hook throws a non-Error value (line 99 false branch)', async () => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    registerShutdownHook(() => { throw 'plain string failure'; });

    process.emit('SIGINT');
    await new Promise((resolve) => setImmediate(resolve));

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining('plain string failure'),
    );
  });

  it('a second signal while shutdown is already running is a no-op', async () => {
    const hook = vi.fn();
    registerShutdownHook(hook);

    process.emit('SIGINT');
    process.emit('SIGINT');
    process.emit('SIGTERM');
    await new Promise((resolve) => setImmediate(resolve));

    // Hook runs exactly once; subsequent signals were suppressed by the
    // `shuttingDown` guard.
    expect(hook).toHaveBeenCalledTimes(1);
  });
});

describe('uncaughtException and unhandledRejection handlers (lines 69-71, 74-76)', () => {
  let originalExit: typeof process.exit;

  beforeEach(() => {
    _resetShutdownHooks();
    originalExit = process.exit;
    process.exit = vi.fn() as never;
  });

  afterEach(() => {
    process.exit = originalExit;
    _resetShutdownHooks();
  });

  it('uncaughtException triggers registered hook with exit code 1 (lines 69-71)', async () => {
    const hook = vi.fn().mockResolvedValue(undefined);
    registerShutdownHook(hook);

    const err = new Error('test uncaught exception');
    err.stack = 'Error: test\n  at test.ts:1:1';
    process.emit('uncaughtException', err);
    await new Promise((resolve) => setImmediate(resolve));

    expect(hook).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('unhandledRejection triggers registered hook with exit code 1 (lines 74-76)', async () => {
    const hook = vi.fn().mockResolvedValue(undefined);
    registerShutdownHook(hook);

    process.emit('unhandledRejection', new Error('test unhandled rejection'), Promise.resolve());
    await new Promise((resolve) => setImmediate(resolve));

    expect(hook).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('unhandledRejection with non-Error reason (line 74 string branch)', async () => {
    const hook = vi.fn().mockResolvedValue(undefined);
    registerShutdownHook(hook);

    process.emit('unhandledRejection', 'plain string reason', Promise.resolve());
    await new Promise((resolve) => setImmediate(resolve));

    expect(hook).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});

describe('hook timeout (lines 94-95)', () => {
  let originalExit: typeof process.exit;

  beforeEach(() => {
    _resetShutdownHooks();
    originalExit = process.exit;
    process.exit = vi.fn() as never;
    vi.useFakeTimers();
  });

  afterEach(() => {
    process.exit = originalExit;
    _resetShutdownHooks();
    vi.useRealTimers();
  });

  it('abandons a hook that exceeds HOOK_TIMEOUT_MS and logs a warning (lines 94-95)', async () => {
    // A hook controlled by a fake timer — resolves after 20s (well past HOOK_TIMEOUT_MS=7s)
    // so the race's setTimeout fires first at 7s and abandons it
    let hookResolve!: () => void;
    const hangingHook = () => new Promise<void>((res) => { hookResolve = res; });
    registerShutdownHook(hangingHook);

    process.emit('SIGINT');
    // Advance past HOOK_TIMEOUT_MS (7000ms) — the race's setTimeout fires and resolves
    await vi.advanceTimersByTimeAsync(7500);
    // The Promise.race resolves; drain the remaining microtask queue
    await Promise.resolve();
    await Promise.resolve();

    // Satisfy the hanging hook promise so no open handles remain
    hookResolve?.();

    expect(process.exit).toHaveBeenCalledWith(130);
  }, 15_000);
});
