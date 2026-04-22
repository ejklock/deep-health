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
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

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
