/**
 * buildProjectImage — Project-owned Dockerfile → stable local Docker image
 *
 * Builds an image from a user-specified Dockerfile (relative to projectDir),
 * producing a deterministic local tag derived from the SHA-256 of the
 * Dockerfile contents. The tag is stable across runs as long as the file does
 * not change, enabling implicit cache hits.
 *
 * Design constraints:
 *  - Returns an `entrypoint` that callers MUST forward to EphemeralEcosystemContainer
 *    as `entrypointOverride`; the container primitive then emits `--entrypoint ""`
 *    to prevent the image ENTRYPOINT from hijacking the command.
 *  - Does NOT write config files or mutate state; pure side-effect: `docker build`.
 *  - Emits a warning when the build context is large (>50 MB after .dockerignore).
 *  - Throws with a descriptive message on build failure.
 *
 * @module
 */

import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { logger } from '../utils/logger';

const execFileAsync = promisify(execFile);

/** Threshold in bytes above which a build-context size warning is emitted. */
const LARGE_CONTEXT_THRESHOLD_BYTES = 50 * 1024 * 1024; // 50 MB

/** Namespace prefix for all project-built image tags. */
const IMAGE_TAG_NAMESPACE = 'deep-health-project';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface BuildProjectImageOptions {
  /** Absolute path to the project directory (docker build context root). */
  projectDir: string;
  /**
   * Path to the Dockerfile, relative to `projectDir`.
   * Example: 'Dockerfile', '.docker/node.Dockerfile'
   */
  dockerfilePath: string;
  /** Log prefix for build output lines, e.g. 'npm' / 'pip' / 'composer'. */
  logPrefix: string;
  /**
   * List of ecosystem binaries that must be present in the built image.
   * Comes from `EcosystemRuntimeSpec.containerBinaries`.
   * When provided, each binary is probed via `which <binary>` inside the container.
   * If a binary is missing, an error is thrown before returning the image tag.
   */
  requiredBinaries?: readonly string[];
}

export interface BuildProjectImageResult {
  /**
   * The stable local image tag that was built.
   * Format: `deep-health-project/<logPrefix>:<sha256-prefix>`
   * Example: `deep-health-project/npm:a3f1b2c4`
   */
  image: string;
  /**
   * The entrypoint override value to pass to EphemeralEcosystemContainer.
   * Always `""` — instructs Docker to clear the image's ENTRYPOINT so the
   * ecosystem CLI binary is invoked directly without being wrapped.
   */
  entrypointOverride: string;
}

// ─── Implementation ───────────────────────────────────────────────────────────

/**
 * Build (or reuse a cached) Docker image from a project-owned Dockerfile.
 *
 * The image tag is a SHA-256 fingerprint of the Dockerfile contents. When
 * the tag already exists locally (probed via `docker image inspect`), the
 * build is skipped and the cached tag is returned immediately.
 *
 * After a successful build, the result carries `entrypointOverride: ""`
 * which the caller MUST forward to `EphemeralEcosystemContainer` to prevent
 * the image's ENTRYPOINT from shadowing the ecosystem CLI binary.
 *
 * @throws {Error} when the Dockerfile is missing, the build fails, or Docker
 *   is not available.
 */
export async function buildProjectImage(
  options: BuildProjectImageOptions,
): Promise<BuildProjectImageResult> {
  const { projectDir, dockerfilePath, logPrefix } = options;

  const absoluteDockerfile = path.isAbsolute(dockerfilePath)
    ? dockerfilePath
    : path.join(projectDir, dockerfilePath);

  // ── 1. Read Dockerfile and compute stable tag ───────────────────────────

  let dockerfileContents: string;
  try {
    dockerfileContents = await fs.readFile(absoluteDockerfile, 'utf8');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[ecosystem-runtime/${logPrefix}] Dockerfile not found at "${absoluteDockerfile}": ${message}`,
    );
  }

  const sha256 = createHash('sha256').update(dockerfileContents).digest('hex');
  const shortSha = sha256.slice(0, 12);
  const image = `${IMAGE_TAG_NAMESPACE}/${logPrefix}:${shortSha}`;

  logger.debug(`[ecosystem-runtime/${logPrefix}] Dockerfile SHA-256: ${sha256}`);

  // ── 2. Probe for cached image ─────────────────────────────────────────────

  const alreadyBuilt = await probeImageExists(image);
  if (alreadyBuilt) {
    logger.info(`[ecosystem-runtime/${logPrefix}] Reusing cached project image: ${image}`);
    // Binary probe must run even on cache hits — the cached image may lack required
    // ecosystem tools (e.g. image was built without the right base or was manually tagged).
    if (options.requiredBinaries && options.requiredBinaries.length > 0) {
      await probeBinariesInImage(image, options.requiredBinaries, logPrefix);
    }
    return { image, entrypointOverride: '' };
  }

  // ── 3. Warn on large build context ───────────────────────────────────────

  await warnIfLargeContext(projectDir, logPrefix);

  // ── 4. Build the image ────────────────────────────────────────────────────

  logger.info(
    `[ecosystem-runtime/${logPrefix}] Building project image from ${dockerfilePath} → ${image}`,
  );

  const buildArgs = [
    'build',
    '--file', absoluteDockerfile,
    '--tag', image,
    projectDir,
  ];

  try {
    const { stderr } = await execFileAsync('docker', buildArgs);
    if (stderr.trim()) {
      for (const line of stderr.split('\n')) {
        if (line.trim()) logger.debug(`[${logPrefix}/build] ${line}`);
      }
    }
  } catch (err: unknown) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    const detail = e.stderr ?? e.stdout ?? e.message ?? String(err);
    throw new Error(
      `[ecosystem-runtime/${logPrefix}] docker build failed for "${dockerfilePath}":\n${detail}`,
    );
  }

  // ── 5. Verify required ecosystem binaries are present in the built image ──

  if (options.requiredBinaries && options.requiredBinaries.length > 0) {
    await probeBinariesInImage(image, options.requiredBinaries, logPrefix);
  }

  logger.info(`[ecosystem-runtime/${logPrefix}] Project image built: ${image}`);

  return { image, entrypointOverride: '' };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns true when `docker image inspect <image>` exits 0 (image is present
 * in the local Docker daemon cache).
 */
async function probeImageExists(image: string): Promise<boolean> {
  try {
    await execFileAsync('docker', ['image', 'inspect', image]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Estimation failure is non-fatal.
 */
async function warnIfLargeContext(projectDir: string, logPrefix: string): Promise<void> {
  try {
    // Use `du` to sum the raw bytes of the project dir as a cheap proxy.
    // On macOS `du -sk` returns kilobytes; on Linux `du -sb` returns bytes.
    // We use `du -sk` for cross-platform compat and multiply by 1024.
    const { stdout } = await execFileAsync('du', ['-sk', projectDir]);
    const kb = parseInt(stdout.trim().split(/\s+/)[0] ?? '0', 10);
    const bytes = kb * 1024;
    if (bytes > LARGE_CONTEXT_THRESHOLD_BYTES) {
      logger.warn(
        `[ecosystem-runtime/${logPrefix}] Build context is large (~${Math.round(bytes / (1024 * 1024))} MB). ` +
        `Consider adding a .dockerignore to exclude node_modules, vendor, .git, etc.`,
      );
    }
  } catch {
    // Estimation failure is non-fatal.
  }
}

/**
 * Probes that each required binary is reachable inside the built image by
 * running `which <binary>` via `docker run --rm <image> sh -c "which <binary>"`.
 *
 * Throws a descriptive error listing all missing binaries — the image is
 * considered invalid and the caller should not proceed.
 *
 * This uses `execFileSync` (synchronous) intentionally — we want to block
 * until all probes complete before returning the image tag to the caller.
 * In practice the probes are fast (no container startup overhead beyond the
 * `which` lookup) and are called once per image build, not per command.
 */
async function probeBinariesInImage(
  image: string,
  binaries: readonly string[],
  logPrefix: string,
): Promise<void> {
  const missing: string[] = [];

  for (const binary of binaries) {
    logger.debug(
      `[ecosystem-runtime/${logPrefix}] Probing binary "${binary}" in image ${image}`,
    );
    try {
      await execFileAsync('docker', [
        'run', '--rm', '--entrypoint', '',
        image,
        'sh', '-c', `which ${binary}`,
      ]);
      logger.debug(
        `[ecosystem-runtime/${logPrefix}] Binary "${binary}" found in image ${image}`,
      );
    } catch {
      logger.debug(
        `[ecosystem-runtime/${logPrefix}] Binary "${binary}" NOT found in image ${image}`,
      );
      missing.push(binary);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `[ecosystem-runtime/${logPrefix}] Project image "${image}" is missing required ` +
      `ecosystem ${missing.length === 1 ? 'binary' : 'binaries'}: ${missing.join(', ')}. ` +
      `Ensure your Dockerfile installs the required tools (e.g. npm, pip, composer).`,
    );
  }
}
