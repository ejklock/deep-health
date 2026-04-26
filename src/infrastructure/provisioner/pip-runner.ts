/**
 * Default Python Docker image used when no specific Python version is configured or inferred.
 */
export const PIP_DEFAULT_IMAGE = 'python:3-slim';

/**
 * Resolve the Docker image to use for a given Python version hint.
 *
 * @param version - Inferred/configured Python version string (e.g. "3.11", "3.11.2", "3").
 *   When undefined or empty, falls back to `PIP_DEFAULT_IMAGE`.
 * @returns Docker image name, e.g. `'python:3.11-slim'` or `'python:3-slim'`.
 */
export function resolvePipDockerImage(version?: string): string {
  if (!version || !version.trim()) return PIP_DEFAULT_IMAGE;

  const parts = version.trim().split('.');
  // Take up to 2 numeric segments (major.minor)
  const numericParts: string[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) break;
    numericParts.push(part);
    if (numericParts.length === 2) break;
  }

  if (numericParts.length === 0) return PIP_DEFAULT_IMAGE;

  return `python:${numericParts.join('.')}-slim`;
}
