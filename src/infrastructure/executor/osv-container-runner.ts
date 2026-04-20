import type { CommandRunner, CommandRunnerOptions, CommandResult, ExecutionEnv } from '@core/types/common';
import type { EphemeralContainerRunner } from '@infra/provisioner/types';
import { logger } from '../utils/logger';

/**
 * OsvContainerCommandRunner — adapts OsvDockerRunner (EphemeralContainerRunner<string[]>)
 * to the CommandRunner interface.
 *
 * Only `osv-scanner` commands are routed to the OSV container; other commands
 * fall back to the provided fallback CommandRunner (typically LocalExecutor or
 * NpmContainerCommandRunner).
 *
 * For osv-scanner commands:
 *  - `run("osv-scanner fix --strategy=in-place -L package-lock.json", ...)` →
 *      container.run(["fix", "--strategy=in-place", "-L", "package-lock.json"])
 *  - Non-osv-scanner commands are delegated to `fallback`.
 *
 * Environment is always 'docker' to reflect that OSV runs in Docker.
 */
export class OsvContainerCommandRunner implements CommandRunner {
  readonly dryRun: boolean;
  readonly environment: ExecutionEnv = 'docker';

  private readonly container: EphemeralContainerRunner<string[]>;
  private readonly fallback: CommandRunner;

  constructor(options: {
    container: EphemeralContainerRunner<string[]>;
    fallback: CommandRunner;
    dryRun?: boolean;
  }) {
    this.container = options.container;
    this.fallback = options.fallback;
    this.dryRun = options.dryRun ?? false;
  }

  async run(command: string, options?: CommandRunnerOptions): Promise<CommandResult> {
    const trimmed = command.trim();

    if (this.dryRun) {
      return { stdout: '', stderr: '', exitCode: 0, command, dryRun: true };
    }

    // Route osv-scanner commands to container; everything else to fallback
    const osvArgs = extractOsvArgs(trimmed);
    if (osvArgs !== null) {
      logger.debug(`OsvContainerCommandRunner: routing to OSV container: osv-scanner ${osvArgs.join(' ')}`);
      const result = await this.container.run(osvArgs);
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        command,
        dryRun: false,
      };
    }

    return this.fallback.run(command, options);
  }

  async runArgs(file: string, args: string[], options?: CommandRunnerOptions): Promise<CommandResult> {
    if (this.dryRun) {
      const command = `${file} ${args.join(' ')}`;
      return { stdout: '', stderr: '', exitCode: 0, command, dryRun: true };
    }

    // Route osv-scanner invocations to container
    if (file === 'osv-scanner' || file.endsWith('/osv-scanner')) {
      logger.debug(`OsvContainerCommandRunner: routing to OSV container: osv-scanner ${args.join(' ')}`);
      const result = await this.container.run(args);
      const command = `osv-scanner ${args.join(' ')}`;
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        command,
        dryRun: false,
      };
    }

    return this.fallback.runArgs(file, args, options);
  }
}

/**
 * Extract osv-scanner subcommand args from a shell-style command string.
 * Returns null if the command is not an osv-scanner command.
 *
 * Examples:
 *   "osv-scanner fix --strategy=in-place -L package-lock.json" → ["fix", "--strategy=in-place", "-L", "package-lock.json"]
 *   "osv-scanner --lockfile package-lock.json --format json" → ["--lockfile", "package-lock.json", "--format", "json"]
 *   "npm install" → null
 */
export function extractOsvArgs(command: string): string[] | null {
  const parts = command.match(/\S+/g) ?? [];
  if (parts.length === 0) return null;

  const bin = parts[0]!;
  if (bin !== 'osv-scanner' && !bin.endsWith('/osv-scanner')) return null;

  return parts.slice(1);
}
