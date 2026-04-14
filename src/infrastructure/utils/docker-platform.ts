import { platform, arch } from 'node:os';

// ─── Linux host-gateway detection ──────────────────────────────────────────────

/**
 * Returns `true` when the current host requires an explicit
 * `--add-host=host.docker.internal:host-gateway` Docker flag.
 *
 * On Linux, `host.docker.internal` is not automatically resolved by Docker
 * (unlike macOS/Windows where Docker Desktop handles it natively).
 */
export function needsHostGateway(): boolean {
  return platform() === 'linux';
}

// ─── Platform detection ─────────────────────────────────────────────────────────

/**
 * Resolve the Docker `--platform` value to use for a container.
 *
 * Explicit override rules (highest priority first):
 *  1. If `platformOverride` is the empty string `''` → omit `--platform` entirely.
 *  2. If `platformOverride` is a non-empty string → use that value as-is.
 *  3. Auto-detect: if the host arch is `arm64` and `defaultPlatform` is provided,
 *     return `defaultPlatform`; otherwise return `undefined` (omit).
 *
 * The `defaultPlatform` parameter lets callers supply the image-specific fallback
 * for arm64 hosts without baking the value into this shared utility.
 * For example, `sonarsource/sonar-scanner-cli` only publishes `linux/amd64`, so
 * callers pass `'linux/amd64'` as the default.  OSV's image publishes native arm64,
 * so callers may omit `defaultPlatform` (or pass `undefined`).
 *
 * @param platformOverride - Explicit value from caller options (may be `undefined`).
 * @param defaultPlatform  - Platform to use on arm64 hosts when no override given.
 *   Defaults to `undefined` (no auto-detection fallback).
 * @returns The `--platform` value to pass to Docker, or `undefined` to omit the flag.
 */
export function resolvePlatform(
  platformOverride?: string,
  defaultPlatform?: string,
): string | undefined {
  // Explicit empty string → caller wants no --platform flag
  if (platformOverride === '') {
    return undefined;
  }
  // Explicit non-empty override
  if (platformOverride !== undefined) {
    return platformOverride;
  }
  // Auto-detect: use defaultPlatform on arm64 hosts when provided
  if (arch() === 'arm64' && defaultPlatform !== undefined) {
    return defaultPlatform;
  }
  return undefined;
}
