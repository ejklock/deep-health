import type { CommandRunner } from '@core/types/common';
import type { ProjectConfig } from '@core/types/config';
import type { EcosystemPlugin } from '@modules/ecosystem/types';
import type { RunMode } from './types';
import { logger } from '../utils/logger';
import { EcosystemContainerCommandRunner } from './command-runner';
import { EphemeralEcosystemContainer } from './ephemeral-container';
import { buildProjectImage } from './build-project-image';

/**
 * Resolve a containerized CommandRunner for the given ecosystem plugin.
 *
 * Image resolution precedence:
 *   When image_source='pull' (default):
 *     1. `scanners.<id>.image` — explicit image config (highest priority)
 *     2. `scanners.<id>.runtime_version` — explicit version → `spec.resolveImage(version)`
 *     3. `plugin.inferVersion(cwd)` — project-file version inference → `spec.resolveImage(version)`
 *     4. `spec.resolveImage(undefined)` → `spec.defaultImage` (fallback)
 *
 *   When image_source='dockerfile':
 *     - Calls `buildProjectImage()` with `scanners.<id>.dockerfile_path`.
 *     - The result's `entrypointOverride` (always `""`) is forwarded to
 *       `EphemeralEcosystemContainer` to prevent ENTRYPOINT hijacking.
 *     - `image` config MUST NOT be set when image_source='dockerfile'
 *       (enforced by schema superRefine).
 *
 * @throws {Error} when `plugin.runtimeSpec` is undefined (plugin has no runtime spec)
 * @throws {Error} when image_source='dockerfile' and dockerfile_path is missing
 */
export async function resolveEcosystemRuntime(
  plugin: EcosystemPlugin,
  hostRunner: CommandRunner,
  config: ProjectConfig,
  cwd: string,
): Promise<CommandRunner> {
  if (plugin.runtimeSpec === undefined) {
    throw new Error(
      `Plugin '${plugin.id}' has no runtimeSpec; cannot resolve a runtime container.`,
    );
  }

  const spec = plugin.runtimeSpec;

  // Look up per-plugin scanner config — keyed by plugin.id in the scanners block
  const scannerConfig =
    config.scanners?.[plugin.id as keyof typeof config.scanners];

  // Cast to access optional fields present on ecosystem runner configs
  const scannerCfg = scannerConfig as
    | {
        image?: string;
        runtime_version?: string;
        image_source?: string;
        dockerfile_path?: string;
        native_deps?: readonly string[];
      }
    | undefined;

  // ─── Image resolution ─────────────────────────────────────────────────────

  let image: string;
  let entrypointOverride: string | undefined;

  const imageSource = scannerCfg?.image_source ?? 'pull';

  if (imageSource === 'dockerfile') {
    // ── Dockerfile branch ────────────────────────────────────────────────────
    const dockerfilePath = scannerCfg?.dockerfile_path;
    if (!dockerfilePath) {
      throw new Error(
        `[ecosystem-runtime/${plugin.id}] image_source="dockerfile" requires dockerfile_path to be configured under scanners.${plugin.id}.`,
      );
    }

    logger.info(
      `[ecosystem-runtime/${plugin.id}] image_source=dockerfile — building project image from ${dockerfilePath}`,
    );

    const buildResult = await buildProjectImage({
      projectDir: cwd,
      dockerfilePath,
      logPrefix: plugin.id,
      requiredBinaries: spec.containerBinaries,
    });

    image = buildResult.image;
    entrypointOverride = buildResult.entrypointOverride;
  } else {
    // ── Pull branch (default) ────────────────────────────────────────────────
    if (scannerCfg?.image) {
      // 1. Explicit image config — highest priority
      image = scannerCfg.image;
    } else {
      // 2–4. Version-based resolution
      let version: string | undefined = scannerCfg?.runtime_version;

      if (!version && plugin.inferVersion) {
        // inferVersion never throws per its contract
        version = await plugin.inferVersion(cwd);
      }

      // resolveImage returns spec.defaultImage when version is undefined
      image = spec.resolveImage(version);
    }
  }

  logger.info(`[ecosystem-runtime/${plugin.id}] Using Docker image: ${image}`);

  // ─── Native deps preamble ─────────────────────────────────────────────────

  const nativeDeps = scannerCfg?.native_deps ?? [];

  let runMode: RunMode = spec.runMode;
  if (nativeDeps.length > 0) {
    const pkgs = nativeDeps.join(' ');
    const aptInstall = `apt-get update -qq -o APT::Sandbox::User=root && apt-get install -y --no-install-recommends -o APT::Sandbox::User=root ${pkgs}`;
    logger.info(`[ecosystem-runtime/${plugin.id}] native_deps: ${pkgs}`);
    const existingPreamble = spec.runMode.preamble;
    runMode = {
      ...spec.runMode,
      preamble: (img: string): string => {
        const existing = existingPreamble?.(img);
        return existing ? `${aptInstall} && ${existing}` : aptInstall;
      },
    } as RunMode;
  }

  // ─── Container instantiation ──────────────────────────────────────────────

  const container = new EphemeralEcosystemContainer({
    runMode,
    projectDir: cwd,
    image,
    logPrefix: plugin.id,
    entrypointOverride,
  });

  return new EcosystemContainerCommandRunner({
    container,
    hostRunner,
    spec,
    dryRun: hostRunner.dryRun,
  });
}
