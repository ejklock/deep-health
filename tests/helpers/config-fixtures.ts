/**
 * Shared config fixture helpers for unit and integration tests.
 *
 * Provides:
 *  - `minimalConfigYaml` — a valid minimal project-config.yml YAML string
 *  - `withTempConfig(yaml, fn)` — writes a uniquely named temp file, runs `fn`, then cleans up
 *  - `minimalConfigWith(overrides)` — builds a minimal YAML string with field overrides appended
 */

import { writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

/**
 * A minimal valid project-config.yml YAML string with a single npm ecosystem.
 */
export const minimalConfigYaml = [
  'project:',
  '  name: test',
  '  client: test',
  'ecosystems:',
  '  - id: npm',
  'protected_packages: {}',
  'safe_update_policy:',
  '  allow_patch_and_minor_within_constraints: true',
  '  require_authorization_for_constraint_change: false',
  'conflict_resolution: fail',
].join('\n') + '\n';

/**
 * Builds a minimal valid config YAML string and appends extra YAML lines.
 *
 * @param extra - Additional YAML lines to append (e.g. 'unknown_top_key: oops')
 */
export function minimalConfigWith(extra: string): string {
  return `${minimalConfigYaml}${extra}\n`;
}

/**
 * Writes a uniquely named temp config file to the OS temp directory,
 * runs the provided callback with the absolute path and filename,
 * then unconditionally deletes the file (even on error).
 *
 * Parallel-safe: uses `randomUUID()` to prevent filename collisions.
 *
 * @param yaml  - YAML content to write
 * @param fn    - Callback receiving `(absolutePath: string, filename: string)`
 */
export async function withTempConfig<T>(
  yaml: string,
  fn: (absolutePath: string, filename: string) => Promise<T>,
): Promise<T> {
  const filename = `_temp_cfg_${randomUUID().replace(/-/g, '_')}.yml`;
  const absolutePath = resolve(tmpdir(), filename);
  await writeFile(absolutePath, yaml, 'utf-8');
  try {
    return await fn(absolutePath, filename);
  } finally {
    await unlink(absolutePath).catch(() => {});
  }
}
