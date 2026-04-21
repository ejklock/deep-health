import type { CommandRunner, CommandRunnerOptions, CommandResult, ExecutionEnv } from '@core/types/common';
import type { EphemeralContainerRunner } from '@infra/provisioner/types';
import { logger } from '../utils/logger';

/**
 * Optional streaming extension on EphemeralContainerRunner<string[]>.
 * PipDockerRunner implements this to provide real-time progress logging.
 * PipContainerCommandRunner detects it at runtime via duck-typing so that
 * streaming stays entirely within the provisioner layer.
 */
interface StreamingContainerRunner {
  runStreaming(args: string[]): Promise<import('@infra/provisioner/types').ContainerRunResult>;
}

function hasStreaming(c: unknown): c is StreamingContainerRunner {
  return typeof (c as StreamingContainerRunner).runStreaming === 'function';
}

/**
 * PipContainerCommandRunner — adapts PipDockerRunner (EphemeralContainerRunner<string[]>)
 * to the CommandRunner interface.
 *
 * Only pip commands are routed to the container; other commands fall back
 * to the provided fallback CommandRunner (typically LocalExecutor).
 *
 * Routing rules (first token):
 *  - `pip`, `pip3`, or a path ending in `/pip` or `/pip3` → container
 *  - Everything else → fallback
 *
 * When `options.stream` is true and the underlying container implements `runStreaming`,
 * the streaming variant is used so output is forwarded to logger.info in real time.
 *
 * Environment is always 'docker' to reflect that pip runs in Docker.
 */
export class PipContainerCommandRunner implements CommandRunner {
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

    // Route pip commands to container; everything else to fallback
    const pipArgs = extractPipArgs(trimmed);
    if (pipArgs !== null) {
      logger.debug(`PipContainerCommandRunner: routing to container: ${trimmed}`);
      const result = await this._runContainer(pipArgs, options?.stream);
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

    // Route pip invocations to container
    if (file === 'pip' || file === 'pip3' || file.endsWith('/pip') || file.endsWith('/pip3')) {
      logger.debug(`PipContainerCommandRunner: routing to container: ${file} ${args.join(' ')}`);
      const cmdTokens = [file, ...args];
      const result = await this._runContainer(cmdTokens, options?.stream);
      const command = `${file} ${args.join(' ')}`;
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

  /**
   * Dispatch to runStreaming (if supported and stream=true) or plain run.
   */
  private async _runContainer(
    args: string[],
    stream?: boolean,
  ): Promise<import('@infra/provisioner/types').ContainerRunResult> {
    if (stream && hasStreaming(this.container)) {
      return this.container.runStreaming(args);
    }
    return this.container.run(args);
  }
}

/**
 * Extract pip command tokens from a shell-style command string.
 * Returns null if the command is not a pip/pip3 command.
 *
 * Examples:
 *   "pip install requests" → ["pip", "install", "requests"]
 *   "pip3 list --outdated" → ["pip3", "list", "--outdated"]
 *   "pip check" → ["pip", "check"]
 *   "git status" → null
 */
function extractPipArgs(command: string): string[] | null {
  const parts = command.match(/\S+/g) ?? [];
  if (parts.length === 0) return null;

  const bin = parts[0]!;
  if (bin !== 'pip' && bin !== 'pip3' && !bin.endsWith('/pip') && !bin.endsWith('/pip3')) return null;

  return parts;
}
