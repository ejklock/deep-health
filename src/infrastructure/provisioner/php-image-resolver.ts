import { COMPOSER_DEFAULT_IMAGE } from './php-profiles';

/**
 * Resolve the Docker image to use for a given PHP version hint.
 *
 * Precedence:
 * 1. Explicit `image` config (handled by caller — not this function).
 * 2. `runtime_version` config or inferred version → `php:<major>.<minor>-cli`.
 * 3. Fallback → `COMPOSER_DEFAULT_IMAGE` ('composer:2').
 *
 * @param phpVersion - PHP version string (e.g. "8.2", "8.2.1", "8").
 *   When undefined or empty, falls back to `COMPOSER_DEFAULT_IMAGE`.
 * @returns Docker image name, e.g. `'php:8.2-cli'` or `'composer:2'`.
 *
 * @example
 * resolveComposerDockerImage('8.2')       // → 'php:8.2-cli'
 * resolveComposerDockerImage('8.2.1')     // → 'php:8.2-cli'
 * resolveComposerDockerImage('8')         // → 'php:8-cli'
 * resolveComposerDockerImage(undefined)   // → 'composer:2'
 * resolveComposerDockerImage('')          // → 'composer:2'
 *
 * @todo Phase 2: accept `imageStrategy` and `frameworkProfile` parameters.
 *   When imageStrategy='build', build a custom image with the extension list
 *   from PHP_FRAMEWORK_PROFILES[frameworkProfile] installed on top of the
 *   resolved base image, instead of returning the base image tag directly.
 */
export function resolveComposerDockerImage(phpVersion?: string): string {
  if (!phpVersion || !phpVersion.trim()) return COMPOSER_DEFAULT_IMAGE;

  const parts = phpVersion.trim().split('.');
  // Take up to 2 numeric segments (major.minor)
  const numericParts: string[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) break;
    numericParts.push(part);
    if (numericParts.length === 2) break;
  }

  if (numericParts.length === 0) return COMPOSER_DEFAULT_IMAGE;

  return `php:${numericParts.join('.')}-cli`;
}
