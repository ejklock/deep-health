/**
 * Ecosystem-level lockfile utilities.
 *
 * Contains helpers for inspecting lockfile metadata that ecosystem plugins
 * need at runtime (e.g. lockfileVersion for fixer-strategy resolution).
 * Functions that are specific to post-update diff analysis remain in
 * `src/orchestration/lockfile-inspect.ts`.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Read `lockfileVersion` from `<cwd>/package-lock.json`.
 *
 * Returns:
 * - The numeric lockfileVersion (1, 2, or 3) if the file exists and is valid JSON with that field.
 * - `null` if the file is missing, unreadable, not valid JSON, or has no numeric lockfileVersion.
 *
 * Never throws.
 */
export async function readNpmLockfileVersion(
  cwd: string,
): Promise<number | null> {
  let content: string;
  try {
    content = await readFile(join(cwd, "package-lock.json"), "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return null;
  const v = (parsed as Record<string, unknown>)["lockfileVersion"];
  return typeof v === "number" ? v : null;
}
