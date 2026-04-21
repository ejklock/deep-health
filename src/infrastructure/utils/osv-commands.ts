/** Minimal structural type needed by buildScanCommand — avoids coupling to ecosystem/types. */
interface ScanArgsProvider {
  buildScanArgs(): string[];
}

export const OSV = {
  checkAvailable: 'osv-scanner --version',
} as const;

/**
 * Default Docker image for running osv-scanner in an ephemeral container.
 *
 * The `ghcr.io/google/osv-scanner` image publishes native `linux/amd64` and
 * `linux/arm64` manifests, so no `--platform` override is needed on Apple Silicon.
 */
export const OSV_DEFAULT_IMAGE = 'ghcr.io/google/osv-scanner:latest';

/**
 * Builds the osv-scanner scan command from an array of active plugins.
 * Each plugin contributes its own lockfile args via buildScanArgs().
 */
export function buildScanCommand(activePlugins: ScanArgsProvider[]): string {
  const args = activePlugins.flatMap((p) => p.buildScanArgs());
  return `osv-scanner ${args.join(' ')} --format json`;
}

/**
 * Build the osv-scanner argument array for use inside a Docker container.
 *
 * The function emits tool-only args (everything after the image name in
 * `docker run <image> <tool-args...>`).  The caller is responsible for
 * prepending the `docker run` preamble via `buildOsvDockerRunArgs()`.
 *
 * Conventions:
 * - `--format json` is always appended so the engine can parse the output.
 * - Lockfile args are provided pre-built by each ecosystem plugin and use
 *   paths relative to the project root.  Because `buildOsvDockerRunArgs()`
 *   sets `--workdir /project`, the container resolves them from `/project/`.
 *
 * @param lockfileArgs - Raw `--lockfile <path>` pairs from plugin.buildScanArgs() (flat array).
 * @returns Tool-level args array, e.g. `['--lockfile', 'package-lock.json', '--format', 'json']`.
 */
export function buildOsvToolArgs(lockfileArgs: string[]): string[] {
  return [...lockfileArgs, '--format', 'json'];
}

/**
 * Build the full `docker run` argument array for an ephemeral OSV scanner container.
 *
 * Includes:
 * - `run --rm`
 * - optional `--platform <platform>` (when not undefined)
 * - `--volume <projectDir>:/project:ro` (read-only) or `--volume <projectDir>:/project:rw`
 *   (read-write, required for `osv-scanner fix --strategy=in-place`)
 * - `--workdir /project` (sets the container working directory so relative
 *   lockfile paths from plugins resolve correctly without path translation)
 * - `<image>`
 * - tool-level args from `buildOsvToolArgs(lockfileArgs)`
 *
 * Because `--workdir /project` is set, callers pass raw plugin lockfile args
 * (host-relative paths) directly — no `/project/` prefix translation required.
 *
 * @param projectDir   - Absolute host path of the project to scan.
 * @param image        - Docker image to use (e.g. `OSV_DEFAULT_IMAGE`).
 * @param lockfileArgs - Raw `--lockfile <path>` pairs from plugin.buildScanArgs().
 * @param platform     - Resolved `--platform` value, or `undefined` to omit.
 * @param readonly     - Whether to mount the project directory read-only (default: `true`).
 *                       Pass `false` when the container needs to write files (e.g. `osv-scanner fix`).
 * @returns Full `docker` args array (i.e. everything after the `docker` binary).
 */
export function buildOsvDockerRunArgs(
  projectDir: string,
  image: string,
  lockfileArgs: string[],
  platform?: string,
  readonly = true,
): string[] {
  const args: string[] = ['run', '--rm'];

  if (platform !== undefined) {
    args.push('--platform', platform);
  }

  const mountMode = readonly ? 'ro' : 'rw';
  args.push('--volume', `${projectDir}:/project:${mountMode}`);
  args.push('--workdir', '/project');
  args.push(image);
  args.push(...buildOsvToolArgs(lockfileArgs));

  return args;
}
