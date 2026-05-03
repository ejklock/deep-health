/**
 * Tests for src/infrastructure/utils/spawn-streaming.ts
 * Covers timeout behavior, timedOut flag, and normal operation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger to prevent noise
vi.mock('@infra/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    tagged: vi.fn(),
  },
}));

import { spawnStreaming } from '@infra/utils/spawn-streaming';

describe('spawnStreaming — normal operation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns exitCode 0 and stdout for a successful command', async () => {
    const result = await spawnStreaming({
      file: 'echo',
      args: ['hello world'],
      logPrefix: 'test',
      label: 'test-label',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello world');
    expect(result.timedOut).toBe(false);
  });

  it('returns exitCode 1 and stderr for a failing command', async () => {
    const result = await spawnStreaming({
      file: 'sh',
      args: ['-c', 'exit 1'],
      logPrefix: 'test',
      label: 'test-label',
    });
    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(false);
  });

  it('returns exitCode 1 and error message when binary does not exist', async () => {
    const result = await spawnStreaming({
      file: 'nonexistent-binary-xyz-12345',
      args: [],
      logPrefix: 'test',
      label: 'test-label',
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBeTruthy();
    expect(result.timedOut).toBe(false);
  });

  it('collects stdout across multiple chunks', async () => {
    const result = await spawnStreaming({
      file: 'sh',
      args: ['-c', 'echo line1; echo line2; echo line3'],
      logPrefix: 'test',
      label: 'test-label',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('line1');
    expect(result.stdout).toContain('line2');
    expect(result.stdout).toContain('line3');
    expect(result.timedOut).toBe(false);
  });

  it('timedOut is false when command completes within timeout', async () => {
    const result = await spawnStreaming({
      file: 'echo',
      args: ['quick'],
      logPrefix: 'test',
      label: 'test-label',
      timeoutMs: 10_000,
    });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
  });
});

describe('spawnStreaming — timeout behavior', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('kills the child and sets timedOut=true when timeoutMs is exceeded', async () => {
    // Use a sleep command that takes longer than the timeout
    const result = await spawnStreaming({
      file: 'sh',
      args: ['-c', 'sleep 10'],
      logPrefix: 'test',
      label: 'test-timeout',
      timeoutMs: 100, // 100ms — much shorter than 10s sleep
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(1);
  }, 3000);

  it('stderr contains descriptive timeout message when timed out', async () => {
    const result = await spawnStreaming({
      file: 'sh',
      args: ['-c', 'sleep 10'],
      logPrefix: 'test',
      label: 'test-timeout',
      timeoutMs: 100,
    });
    expect(result.timedOut).toBe(true);
    expect(result.stderr).toContain('Timed out after 100ms');
  }, 3000);

  it('stderr includes the exact ms value in the timeout message', async () => {
    const result = await spawnStreaming({
      file: 'sh',
      args: ['-c', 'sleep 10'],
      logPrefix: 'test',
      label: 'test-timeout',
      timeoutMs: 250,
    });
    expect(result.stderr).toContain('Timed out after 250ms');
  }, 3000);

  it('never rejects — resolves even on timeout', async () => {
    // Should not throw
    await expect(
      spawnStreaming({
        file: 'sh',
        args: ['-c', 'sleep 10'],
        logPrefix: 'test',
        label: 'test-timeout',
        timeoutMs: 100,
      }),
    ).resolves.toBeDefined();
  }, 3000);
});
