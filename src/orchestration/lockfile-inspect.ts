/**
 * Lockfile inspector: parses `package-lock.json` (v1, v2, v3) and extracts the
 * (packageName -> Set<version>) map of everything present in the tree.
 *
 * Used by the OSV fix applier to verify that claimed `versionTo` values from
 * `osv-scanner fix --format=json` are actually present in the lockfile. This
 * protects downstream reporting from osv-scanner quirks (e.g. lockfileVersion 1
 * behavior where the JSON output lists patches that never get written).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Collect all (packageName, version) pairs from an npm package-lock.json string.
 *
 * Returns an empty map when:
 *  - content is not valid JSON
 *  - content is JSON but not an object
 *  - the object has no recognizable `dependencies` or `packages` section
 *
 * Tolerates unknown fields and mixed v1/v2 lockfiles.
 */
export function collectNpmLockfileVersions(content: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (name: string, version: string): void => {
    if (!name || !version) return;
    const set = out.get(name) ?? new Set<string>();
    set.add(version);
    out.set(name, set);
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;

  const root = parsed as Record<string, unknown>;

  // v1 and v2 carry a recursive name-keyed `dependencies` tree.
  const walkDeps = (deps: unknown): void => {
    if (!deps || typeof deps !== 'object' || Array.isArray(deps)) return;
    for (const [name, val] of Object.entries(deps as Record<string, unknown>)) {
      if (!val || typeof val !== 'object') continue;
      const entry = val as Record<string, unknown>;
      const v = entry['version'];
      if (typeof v === 'string') add(name, v);
      walkDeps(entry['dependencies']);
    }
  };
  walkDeps(root['dependencies']);

  // v2 and v3 use a path-keyed `packages` map, e.g. "node_modules/foo",
  // "node_modules/@scope/bar", or "node_modules/a/node_modules/b".
  const pkgs = root['packages'];
  if (pkgs && typeof pkgs === 'object' && !Array.isArray(pkgs)) {
    for (const [pathKey, val] of Object.entries(pkgs as Record<string, unknown>)) {
      // The empty-key entry is the project root itself — always skip.
      if (pathKey === '') continue;
      if (!val || typeof val !== 'object') continue;
      const entry = val as Record<string, unknown>;
      const ver = entry['version'];
      if (typeof ver !== 'string') continue;

      const explicitName = entry['name'];
      let name: string | undefined;
      if (typeof explicitName === 'string' && explicitName.length > 0) {
        name = explicitName;
      } else {
        const marker = 'node_modules/';
        const idx = pathKey.lastIndexOf(marker);
        if (idx < 0) continue;
        name = pathKey.slice(idx + marker.length);
      }
      if (name) add(name, ver);
    }
  }

  return out;
}

/**
 * Read `lockfileVersion` from `<cwd>/package-lock.json`.
 *
 * Returns:
 * - The numeric lockfileVersion (1, 2, or 3) if the file exists and is valid JSON with that field.
 * - `null` if the file is missing, unreadable, not valid JSON, or has no numeric lockfileVersion.
 *
 * Never throws.
 */
export async function readNpmLockfileVersion(cwd: string): Promise<number | null> {
  let content: string;
  try {
    content = await readFile(join(cwd, 'package-lock.json'), 'utf-8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const v = (parsed as Record<string, unknown>)['lockfileVersion'];
  return typeof v === 'number' ? v : null;
}
