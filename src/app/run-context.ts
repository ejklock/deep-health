import { loadConfig } from '@infra/config/loader';
import { LocalExecutor } from '@infra/executor/local-executor';
import { setLogLevel, setJsonMode } from '@infra/utils/logger';
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
  json?: boolean;
}

/**
 * Bootstraps config + runner from common CLI options.
 * Applies log level, loads config, and creates a LocalExecutor.
 * Errors are intentionally allowed to bubble to the caller.
 */
export async function createRunContext(
  opts: RunContextOptions,
): Promise<RunContext> {
  if (opts.verbose) setLogLevel('debug');
  if (opts.quiet) setLogLevel('error');
  if (opts.json) setJsonMode(true);

  const config = await loadConfig(opts.config, opts.cwd, defaultRegistry);
  const runner = new LocalExecutor({ dryRun: opts.dryRun });

  return { config, runner };
}
