import type { CommandRunner, CommandRunnerOptions, CommandResult, ExecutionEnv } from '@core/types/common';
import type { EphemeralContainerRunner } from '@infra/provisioner/types';
import { logger } from '../utils/logger';

/**
 * NpmContainerCommandRunner — adapts NpmDockerRunner (EphemeralContainerRunner<string[]>)
 * to the CommandRunner interface.
 *
 * Only npm commands are routed to the container; other commands (git, etc.) fall back
 * to the provided fallback CommandRunner (typically LocalExecutor).
 *
 * For npm commands:
 *  - `run("npm install", ...)` → container.run(["install"])
 *  - `runArgs("npm", ["install"], ...)` → container.run(["install"])
 *  - Non-npm commands are delegated to `fallback`.
 *
 * Environment is always 'docker' to reflect that npm runs in Docker.
 */
export class NpmContainerCommandRunner implements CommandRunner {
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

    // Route npm commands to container; everything else to fallback
    const npmArgs = extractNpmArgs(trimmed);
    if (npmArgs !== null) {
      logger.debug(`NpmContainerCommandRunner: routing to container: npm ${npmArgs.join(' ')}`);
      const result = await this.container.run(npmArgs);
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

    // Route npm invocations to container
    if (file === 'npm' || file.endsWith('/npm')) {
      logger.debug(`NpmContainerCommandRunner: routing to container: npm ${args.join(' ')}`);
      const result = await this.container.run(args);
      const command = `npm ${args.join(' ')}`;
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
 * Extract npm subcommand args from a shell-style command string.
 * Returns null if the command is not an npm command.
 *
 * Examples:
 *   "npm install" → ["install"]
 *   "npm update lodash" → ["update", "lodash"]
 *   "npm audit" → ["audit"]
 *   "osv-scanner ..." → null
 */
function extractNpmArgs(command: string): string[] | null {
  const parts = command.match(/\S+/g) ?? [];
  if (parts.length === 0) return null;

  const bin = parts[0]!;
  if (bin !== 'npm' && !bin.endsWith('/npm')) return null;

  return parts.slice(1);
}
