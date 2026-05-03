import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { EcosystemPlugin } from '@modules/ecosystem/types';

/**
 * Detects which ecosystems are present in the given directory by checking
 * for the existence of any lockfile/manifest declared by each plugin.
 *
 * Returns a Set of ecosystem IDs whose files were found. An ecosystem is
 * considered detected if ANY of its lockfiles exist (not all).
 *
 * Errors other than file-not-found are swallowed — if fs.access fails for
 * an unexpected reason, that ecosystem is treated as not detected (no crash).
 */
export async function detectEcosystems(
  cwd: string,
  plugins: EcosystemPlugin[],
): Promise<Set<string>> {
  const detected = new Set<string>();

  for (const plugin of plugins) {
    for (const lockfile of plugin.lockfiles ?? []) {
      try {
        await access(resolve(cwd, lockfile));
        detected.add(plugin.id);
        break; // one match is enough
      } catch {
        // file not found or inaccessible — skip
      }
    }
  }

  return detected;
}
