/**
 * Unit tests for shared Docker platform helpers.
 *
 * Tests cover both `needsHostGateway()` and `resolvePlatform()` in isolation.
 * `node:os` is mocked to control platform/arch without relying on the host.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

// Mock node:os before importing the module under test.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    platform: vi.fn(() => 'darwin'),
    arch: vi.fn(() => 'x64'),
  };
});

import { needsHostGateway, resolvePlatform } from '@infra/utils/docker-platform';
import { platform as osPlatform, arch as osArch } from 'node:os';

const mockPlatform = vi.mocked(osPlatform);
const mockArch = vi.mocked(osArch);

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── needsHostGateway() ────────────────────────────────────────────────────────

describe('needsHostGateway()', () => {
  it('returns true on linux', () => {
    mockPlatform.mockReturnValue('linux');
    expect(needsHostGateway()).toBe(true);
  });

  it('returns false on darwin (macOS)', () => {
    mockPlatform.mockReturnValue('darwin');
    expect(needsHostGateway()).toBe(false);
  });

  it('returns false on win32 (Windows)', () => {
    mockPlatform.mockReturnValue('win32');
    expect(needsHostGateway()).toBe(false);
  });
});

// ─── resolvePlatform() ─────────────────────────────────────────────────────────

describe('resolvePlatform()', () => {
  // ── empty string override ───────────────────────────────────────────────────

  it('returns undefined when platformOverride is empty string (suppresses auto-detection)', () => {
    mockArch.mockReturnValue('arm64');
    expect(resolvePlatform('', 'linux/amd64')).toBeUndefined();
  });

  it('returns undefined when platformOverride is empty string on x64', () => {
    mockArch.mockReturnValue('x64');
    expect(resolvePlatform('', 'linux/amd64')).toBeUndefined();
  });

  // ── explicit non-empty override ─────────────────────────────────────────────

  it('returns the explicit override on arm64 regardless of defaultPlatform', () => {
    mockArch.mockReturnValue('arm64');
    expect(resolvePlatform('linux/arm64', 'linux/amd64')).toBe('linux/arm64');
  });

  it('returns the explicit override on x64', () => {
    mockArch.mockReturnValue('x64');
    expect(resolvePlatform('linux/amd64')).toBe('linux/amd64');
  });

  // ── auto-detection with defaultPlatform ─────────────────────────────────────

  it('returns defaultPlatform on arm64 when no override provided', () => {
    mockArch.mockReturnValue('arm64');
    expect(resolvePlatform(undefined, 'linux/amd64')).toBe('linux/amd64');
  });

  it('returns undefined on arm64 when no override and no defaultPlatform (OSV-style)', () => {
    mockArch.mockReturnValue('arm64');
    expect(resolvePlatform(undefined, undefined)).toBeUndefined();
  });

  it('returns undefined on x64 even when defaultPlatform is given', () => {
    mockArch.mockReturnValue('x64');
    expect(resolvePlatform(undefined, 'linux/amd64')).toBeUndefined();
  });

  it('returns undefined on ia32 with defaultPlatform', () => {
    mockArch.mockReturnValue('ia32');
    expect(resolvePlatform(undefined, 'linux/amd64')).toBeUndefined();
  });

  // ── no args ─────────────────────────────────────────────────────────────────

  it('returns undefined with no args on x64', () => {
    mockArch.mockReturnValue('x64');
    expect(resolvePlatform()).toBeUndefined();
  });

  it('returns undefined with no args on arm64 (no defaultPlatform)', () => {
    mockArch.mockReturnValue('arm64');
    expect(resolvePlatform()).toBeUndefined();
  });
});
