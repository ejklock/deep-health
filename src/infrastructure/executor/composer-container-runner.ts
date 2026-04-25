import type { CommandRunner, CommandRunnerOptions, CommandResult, ExecutionEnv } from '@core/types/common';
import type { EphemeralContainerRunner } from '@infra/provisioner/types';
import { logger } from '../utils/logger';

/**
 * Optional streaming extension on EphemeralContainerRunner<string[]>.
 * ComposerDockerRunner implements this to provide real-time progress logging.
 * ComposerContainerCommandRunner detects it at runtime via duck-typing so that
 * streaming stays entirely within the provisioner layer.
 */
interface StreamingContainerRunner {
  runStreaming(args: string[]): Promise<import('@infra/provisioner/types').ContainerRunResult>;
}

function hasStreaming(c: unknown): c is StreamingContainerRunner {
  return typeof (c as StreamingContainerRunner).runStreaming === 'function';
}

interface RunShellContainer {
  runShell(command: string, opts?: { cwd?: string }): Promise<import('@infra/provisioner/types').ContainerRunResult>;
}

function hasRunShell(c: unknown): c is RunShellContainer {
  return typeof (c as RunShellContainer).runShell === 'function';
}

// Commands that must always run on the host — never in the ecosystem container
function isHostOnlyCommand(bin: string): boolean {
  return bin === 'git' || bin === 'open' || bin === 'gh';
}

/**
 * ComposerContainerCommandRunner — adapts ComposerDockerRunner (EphemeralContainerRunner<string[]>)
 * to the CommandRunner interface.
 *
 * Only composer and php commands are routed to the container; other commands fall back
 * to the provided fallback CommandRunner (typically LocalExecutor).
 *
 * Routing rules (first token):
 *  - `composer`, or a path ending in `/composer` → container
 *  - `php`, or a path ending in `/php` → container (for php artisan, php -r, etc.)
 *  - Everything else → fallback
 *
 * When `options.stream` is true and the underlying container implements `runStreaming`,
 * the streaming variant is used so output is forwarded to logger.info in real time.
 *
 * Environment is always 'docker' to reflect that composer runs in Docker.
 *
 * SEC-004 — Container tokenizer trust boundary:
 * The `run(command: string)` path tokenizes the command string via `extractComposerArgs`
 * (simple whitespace split). This tokenizer is intentionally TRUSTED-STATIC-ONLY:
 * it may only receive compile-time-constant command strings.
 * Variable data (package names, versions) MUST be passed via `runArgs` so that
 * each token is an independent array element, never reaching a tokenizer that
 * could be exploited via injection.
 * All callers in this codebase that supply variable data already use `runArgs`.
 */
export class ComposerContainerCommandRunner implements CommandRunner {
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

    // Route composer/php commands to container; everything else to fallback
    const composerArgs = extractComposerArgs(trimmed);
    if (composerArgs !== null) {
      logger.debug(`ComposerContainerCommandRunner: routing to container: ${trimmed}`);
      const result = await this._runContainer(composerArgs, options?.stream);
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        command,
        dryRun: false,
      };
    }

    if (hasRunShell(this.container)) {
      const firstToken = trimmed.split(/\s+/)[0] ?? '';
      if (!isHostOnlyCommand(firstToken)) {
        logger.debug(`ComposerContainerCommandRunner: routing to container shell: ${trimmed}`);
        const result = await this.container.runShell(trimmed, { cwd: options?.cwd });
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          command,
          dryRun: false,
        };
      }
    }
    return this.fallback.run(command, options);
  }

  async runArgs(file: string, args: string[], options?: CommandRunnerOptions): Promise<CommandResult> {
    if (this.dryRun) {
      const command = `${file} ${args.join(' ')}`;
      return { stdout: '', stderr: '', exitCode: 0, command, dryRun: true };
    }

    // Route composer and php invocations to container
    if (isComposerOrPhpBin(file)) {
      logger.debug(`ComposerContainerCommandRunner: routing to container: ${file} ${args.join(' ')}`);
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

    if (hasRunShell(this.container)) {
      if (!isHostOnlyCommand(file)) {
        const shellCmd = [file, ...args].join(' ');
        logger.debug(`ComposerContainerCommandRunner: routing to container shell: ${shellCmd}`);
        const result = await this.container.runShell(shellCmd, { cwd: options?.cwd });
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          command: shellCmd,
          dryRun: false,
        };
      }
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
 * Returns true when the binary name is composer or php (or a path ending in those).
 */
function isComposerOrPhpBin(bin: string): boolean {
  return (
    bin === 'composer' ||
    bin.endsWith('/composer') ||
    bin === 'php' ||
    bin.endsWith('/php')
  );
}

/**
 * Extract composer/php command tokens from a shell-style command string.
 * Returns null if the command is not a composer or php command.
 *
 * Examples:
 *   "composer install" → ["composer", "install"]
 *   "composer update vendor/pkg" → ["composer", "update", "vendor/pkg"]
 *   "composer outdated --direct" → ["composer", "outdated", "--direct"]
 *   "php artisan test" → ["php", "artisan", "test"]
 *   "git status" → null
 */
function extractComposerArgs(command: string): string[] | null {
  const parts = command.match(/\S+/g) ?? [];
  if (parts.length === 0) return null;

  const bin = parts[0]!;
  if (!isComposerOrPhpBin(bin)) return null;

  return parts;
}
