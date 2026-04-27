import type { CommandRunner } from '@core/types/common';
import type { ProjectConfig } from '@core/types/config';
import type { EcosystemPlugin } from '@modules/ecosystem/types';
import type { RunMode } from './types';
import { logger } from '../utils/logger';
import { EcosystemContainerCommandRunner } from './command-runner';
import { EphemeralEcosystemContainer } from './ephemeral-container';

/**
 * Resolve a containerized CommandRunner for the given ecosystem plugin.
 *
 * Image resolution precedence:
 *   1. `scanners.<id>.image` — explicit image config (highest priority)
 *   2. `scanners.<id>.runtime_version` — explicit version → `spec.resolveImage(version)`
 *   3. `plugin.inferVersion(cwd)` — project-file version inference → `spec.resolveImage(version)`
 *   4. `spec.resolveImage(undefined)` → `spec.defaultImage` (fallback)
 *
 * @throws {Error} when `plugin.runtimeSpec` is undefined (plugin has no runtime spec)
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
  const scannerConfig = config.scanners?.[plugin.id as keyof typeof config.scanners];

  // ─── Image resolution ─────────────────────────────────────────────────────

  let image: string;

  // Cast to access optional image/runtime_version fields if present
  const scannerCfg = scannerConfig as { image?: string; runtime_version?: string } | undefined;

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

  logger.info(`[ecosystem-runtime/${plugin.id}] Using Docker image: ${image}`);

  // ─── Native deps preamble ─────────────────────────────────────────────────

  const nativeDeps =
    (scannerCfg as { native_deps?: readonly string[] } | undefined)?.native_deps ?? [];

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
  });

  return new EcosystemContainerCommandRunner({
    container,
    hostRunner,
    spec,
    dryRun: hostRunner.dryRun,
  });
}
