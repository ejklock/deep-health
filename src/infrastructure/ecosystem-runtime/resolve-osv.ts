import type { CommandRunner } from '@core/types/common';
import type { ProjectConfig } from '@core/types/config';
import { logger } from '../utils/logger';
import { osvRuntimeSpec } from './osv-runtime-spec';
import { EphemeralEcosystemContainer } from './ephemeral-container';
import { EcosystemContainerCommandRunner } from './command-runner';

/**
 * Builds a CommandRunner for osv-scanner.
 *
 * - If the OSV runner is configured as `mode: 'local'`, the host runner is returned directly.
 * - Otherwise an ephemeral Docker container is used, parameterized by `osvRuntimeSpec`.
 *   A custom image from `config.scanners.osv.image` (if set) overrides the spec's default.
 */
export function resolveOsvRuntime(
  config: ProjectConfig,
  cwd: string,
  hostRunner: CommandRunner,
): CommandRunner {
  const osvConfig = config.scanners?.osv;
  const mode = osvConfig?.runner ?? 'docker';

  if (mode === 'local') {
    logger.debug('[OSV runner] mode=local: using local runner for OSV commands');
    return hostRunner;
  }

  const specWithImage: typeof osvRuntimeSpec = osvConfig?.image
    ? { ...osvRuntimeSpec, defaultImage: osvConfig.image, resolveImage: () => osvConfig.image! }
    : osvRuntimeSpec;

  const image = specWithImage.resolveImage(undefined);

  logger.tagged(
    'osv',
    'OSV runner',
    `Dedicated OSV container runner (mode: ${mode}, mount: read-only${osvConfig?.image ? `, image: ${osvConfig.image}` : ''})`,
  );

  const container = new EphemeralEcosystemContainer({
    runMode: specWithImage.runMode,
    projectDir: cwd,
    image,
    logPrefix: 'osv',
    readonly: specWithImage.mountReadonly ?? false,
  });

  return new EcosystemContainerCommandRunner({
    container,
    hostRunner,
    spec: specWithImage,
    dryRun: hostRunner.dryRun,
  });
}
