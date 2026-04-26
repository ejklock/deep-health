import type { CommandRunner } from '@core/types/common';
import type { ProjectConfig } from '@core/types/config';
import type { EcosystemPlugin } from '@modules/ecosystem/types';
import type { EphemeralContainerRunner } from '@infra/provisioner/types';
import { NpmDockerRunner } from '@infra/provisioner/npm-runner';
import { PipDockerRunner } from '@infra/provisioner/pip-runner';
import { ComposerDockerRunner } from '@infra/provisioner/composer-runner';
import { logger } from '../utils/logger';
import { EcosystemContainerCommandRunner } from './command-runner';

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
 * @throws {Error} when `plugin.id` is not one of the known plugin IDs (transitional — removed in PR 2)
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

  // ─── Container instantiation (transitional dispatch) ─────────────────────

  // TODO(PR 2): collapse these into one EphemeralEcosystemContainer
  // parameterized by spec.runMode. The switch goes away when there's only
  // one container class.
  let container: EphemeralContainerRunner<string[]>;
  switch (plugin.id) {
    case 'npm':
      container = new NpmDockerRunner({ projectDir: cwd, image });
      break;
    case 'pip':
      container = new PipDockerRunner({ projectDir: cwd, image });
      break;
    case 'composer':
      container = new ComposerDockerRunner({ projectDir: cwd, image });
      break;
    default:
      throw new Error(
        `Unknown plugin id for runtime container instantiation: ${plugin.id}. PR 2 will remove this restriction.`,
      );
  }

  return new EcosystemContainerCommandRunner({
    container,
    hostRunner,
    spec,
    dryRun: hostRunner.dryRun,
  });
}
