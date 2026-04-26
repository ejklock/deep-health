/**
 * Default Node.js Docker image used when no specific Node version is configured or inferred.
 * Uses the full LTS image for broad compatibility including native modules (node-gyp).
 */
export const NPM_DEFAULT_IMAGE = 'node:lts';

/**
 * Resolve the Docker image to use for a given Node version hint.
 *
 * @param nodeVersion - Inferred/configured Node version string (e.g. "20", "20.11", "22.0").
 *   When undefined or empty, falls back to `NPM_DEFAULT_IMAGE`.
 * @returns Docker image name, e.g. `'node:20'` or `'node:lts'`.
 */
export function resolveNpmDockerImage(nodeVersion?: string): string {
  if (!nodeVersion || !nodeVersion.trim()) return NPM_DEFAULT_IMAGE;

  // Use the major version only for the image tag — "20.11.1" → "20"
  const major = nodeVersion.trim().split('.')[0];
  if (!major || !/^\d+$/.test(major)) return NPM_DEFAULT_IMAGE;

  return `node:${major}`;
}
