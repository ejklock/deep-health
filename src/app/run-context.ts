import { loadConfig } from '@infra/config/loader';
import { detectEnvironment } from '@infra/environment/detector';
import { setLogLevel } from '@infra/utils/logger';
import { defaultRegistry } from '@modules/ecosystem/index';
import type { ProjectConfig } from '@core/types/config';
import type { CommandRunner } from '@core/types/common';

export interface RunContext {
  config: ProjectConfig;
  runner: CommandRunner;
}

export interface RunContextOptions {
  config: string;
  cwd: string;
  dryRun: boolean;
  verbose: boolean;
  quiet: boolean;
}

/**
 * Bootstraps config + runner from common CLI options.
 * Applies log level, loads config, and detects the execution environment.
 * Errors are intentionally allowed to bubble to the caller.
 */
export async function createRunContext(
  opts: RunContextOptions,
): Promise<RunContext> {
  if (opts.verbose) setLogLevel('debug');
  if (opts.quiet) setLogLevel('error');

  const config = await loadConfig(opts.config, opts.cwd, defaultRegistry);
  const runner = await detectEnvironment(
    config.runtime.execution,
    config.runtime.docker_service,
    opts.cwd,
    opts.dryRun,
    config.runtime.docker_workdir,
  );

  return { config, runner };
}
