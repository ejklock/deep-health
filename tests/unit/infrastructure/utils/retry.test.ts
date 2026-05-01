/**
 * Coverage for src/infrastructure/utils/retry.ts
 * Covers:
 *   - withRetry() — success on first attempt
 *   - withRetry() — success on 2nd attempt after 1 failure
 *   - withRetry() — failure after maxAttempts exhausted
 *   - withRetry() — retryOn returning false stops immediately
 *   - isDockerTransientError() — each trigger string and a non-match
 *   - withRetry() — exponential delay via fake timers
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@infra/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), phase: vi.fn(), skip: vi.fn(), header: vi.fn(), tagged: vi.fn() },
}));

import { withRetry, isDockerTransientError } from '@infra/utils/retry';

// ─── withRetry ──────────────────────────────────────────────────────────────

describe('withRetry()', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the value immediately when fn succeeds on first attempt', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const resultPromise = withRetry(fn, { maxAttempts: 3, baseDelayMs: 100 });
    // Advance timers to satisfy any pending promise micro-tasks
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('succeeds on 2nd attempt when fn throws once then resolves', async () => {
    const err = new Error('transient');
    const fn = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce('recovered');

    const resultPromise = withRetry(fn, { maxAttempts: 3, baseDelayMs: 100 });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws the last error after maxAttempts exhausted', async () => {
    const err = new Error('always fails');
    const fn = vi.fn().mockRejectedValue(err);

    const resultPromise = withRetry(fn, { maxAttempts: 3, baseDelayMs: 100 });
    const expectPromise = expect(resultPromise).rejects.toThrow('always fails');
    await vi.runAllTimersAsync();
    await expectPromise;
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws immediately on attempt 1 when retryOn returns false', async () => {
    const err = new Error('non-retryable');
    const fn = vi.fn().mockRejectedValue(err);
    const retryOn = vi.fn().mockReturnValue(false);

    const resultPromise = withRetry(fn, { maxAttempts: 3, baseDelayMs: 100, retryOn });
    const expectPromise = expect(resultPromise).rejects.toThrow('non-retryable');
    await vi.runAllTimersAsync();
    await expectPromise;
    expect(fn).toHaveBeenCalledTimes(1);
    expect(retryOn).toHaveBeenCalledTimes(1);
  });

  it('wraps non-Error throws in an Error instance', async () => {
    const fn = vi.fn().mockRejectedValue('string-error');

    const resultPromise = withRetry(fn, { maxAttempts: 1, baseDelayMs: 100 });
    const expectPromise = expect(resultPromise).rejects.toThrow('string-error');
    await vi.runAllTimersAsync();
    await expectPromise;
  });

  it('calls setTimeout with exponential delay — baseDelayMs * 2^(attempt-1)', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const err = new Error('transient');
    const fn = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce('done');

    const resultPromise = withRetry(fn, { maxAttempts: 3, baseDelayMs: 500 });
    await vi.runAllTimersAsync();
    await resultPromise;

    // Attempt 1 fails → delay = 500 * 2^0 = 500ms
    // Attempt 2 fails → delay = 500 * 2^1 = 1000ms
    const delays = setTimeoutSpy.mock.calls
      .map((call) => call[1])
      .filter((d): d is number => typeof d === 'number');

    expect(delays).toContain(500);
    expect(delays).toContain(1000);

    setTimeoutSpy.mockRestore();
  });
});

// ─── isDockerTransientError ─────────────────────────────────────────────────

describe('isDockerTransientError()', () => {
  it('returns true for "docker pull" in message', () => {
    expect(isDockerTransientError(new Error('Error during docker pull of image'))).toBe(true);
  });

  it('returns true for "network timeout" in message', () => {
    expect(isDockerTransientError(new Error('network timeout occurred'))).toBe(true);
  });

  it('returns true for "connection refused" in message', () => {
    expect(isDockerTransientError(new Error('connection refused on socket'))).toBe(true);
  });

  it('returns true for "exit code 125" in message', () => {
    expect(isDockerTransientError(new Error('docker: exit code 125'))).toBe(true);
  });

  it('returns false for unrelated error messages', () => {
    expect(isDockerTransientError(new Error('permission denied: /var/run/docker.sock'))).toBe(
      false,
    );
  });

  it('is case-insensitive', () => {
    expect(isDockerTransientError(new Error('DOCKER PULL failed'))).toBe(true);
    expect(isDockerTransientError(new Error('Network Timeout'))).toBe(true);
  });
});
