import type { CommandRunner, CommandRunnerOptions, CommandResult, ExecutionEnv } from '@core/types/common';
import type { EphemeralContainerRunner } from '@infra/provisioner/types';
import type { EcosystemRuntimeSpec } from './types';
import { logger } from '../utils/logger';

// ─── Duck-type interfaces ────────────────────────────────────────────────────

/**
 * Optional streaming extension on EphemeralContainerRunner<string[]>.
 * Detected at runtime via duck-typing so streaming stays entirely within
 * the provisioner layer.
 */
interface StreamingContainerRunner {
  runStreaming(args: string[]): Promise<import('@infra/provisioner/types').ContainerRunResult>;
}

/**
 * Optional shell-execution extension on EphemeralContainerRunner<string[]>.
 * Detected at runtime via duck-typing.
 */
interface RunShellContainer {
  runShell(command: string, opts?: { cwd?: string }): Promise<import('@infra/provisioner/types').ContainerRunResult>;
}

function hasStreaming(c: unknown): c is StreamingContainerRunner {
  return typeof (c as StreamingContainerRunner).runStreaming === 'function';
}

function hasRunShell(c: unknown): c is RunShellContainer {
  return typeof (c as RunShellContainer).runShell === 'function';
}

// ─── Host-only commands ───────────────────────────────────────────────────────

/** Returns true for commands that must always run on the host — never in an ecosystem container. */
function isHostOnlyCommand(bin: string): boolean {
  return bin === 'git' || bin === 'open' || bin === 'gh';
}

// ─── Binary matching ──────────────────────────────────────────────────────────

/**
 * Returns true when `file` is one of the ecosystem's container binaries.
 * Matches bare names (`'npm'`) and absolute paths that end with the binary name
 * (`'/usr/bin/npm'` matches `'npm'`).
 */
function matchesContainerBinary(file: string, binaries: readonly string[]): boolean {
  for (const binary of binaries) {
    if (file === binary || file.endsWith('/' + binary)) return true;
  }
  return false;
}

// ─── EcosystemContainerCommandRunner ─────────────────────────────────────────

/**
 * EcosystemContainerCommandRunner — unified CommandRunner for all ecosystem containers.
 *
 * Parameterized by an `EcosystemRuntimeSpec`, this class replaces (in Batch 3)
 * the three legacy `*ContainerCommandRunner` classes:
 *   - NpmContainerCommandRunner
 *   - PipContainerCommandRunner
 *   - ComposerContainerCommandRunner
 *
 * Routing is driven by `spec.containerBinaries` and `spec.runMode`:
 * - A command whose first token (or `file` argument) matches a container binary
 *   is routed to the container.
 * - Commands that are not host-only may alternatively be routed through
 *   `container.runShell` when available.
 * - All remaining commands (git, open, gh, and anything the container can't handle)
 *   fall through to `hostRunner`.
 *
 * SEC-004 — Container tokenizer trust boundary:
 * The `run(command: string)` path tokenizes via whitespace split and is
 * TRUSTED-STATIC-ONLY: it may only receive compile-time-constant command strings
 * (e.g. "npm audit fix", "pip check"). Variable data (package names, versions,
 * branch names) MUST be passed via `runArgs` so that each token is an independent
 * array element, never reaching a shell or any tokenizer that could be exploited
 * via injection. All callers in this codebase that supply variable data already
 * use `runArgs`.
 */
export class EcosystemContainerCommandRunner implements CommandRunner {
  readonly dryRun: boolean;
  readonly environment: ExecutionEnv = 'docker';

  private readonly container: EphemeralContainerRunner<string[]>;
  private readonly hostRunner: CommandRunner;
  private readonly spec: EcosystemRuntimeSpec;

  constructor(options: {
    container: EphemeralContainerRunner<string[]>;
    hostRunner: CommandRunner;
    spec: EcosystemRuntimeSpec;
    dryRun?: boolean;
  }) {
    this.container = options.container;
    this.hostRunner = options.hostRunner;
    this.spec = options.spec;
    this.dryRun = options.dryRun ?? false;
  }

  async run(command: string, options?: CommandRunnerOptions): Promise<CommandResult> {
    if (this.dryRun) {
      return { stdout: '', stderr: '', exitCode: 0, command, dryRun: true };
    }

    const trimmed = command.trim();
    const tokens = trimmed.match(/\S+/g) ?? [];
    const firstToken = tokens[0] ?? '';

    if (firstToken && matchesContainerBinary(firstToken, this.spec.containerBinaries)) {
      // Route to container — argv shape depends on runMode
      const containerTokens = this._buildContainerTokensFromRun(firstToken, tokens);
      logger.tagged('ecosystem-runtime', 'ecosystem-runtime', `routing to container: ${trimmed}`, 'debug');
      const result = await this._runContainer(containerTokens, options?.stream);
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        command,
        dryRun: false,
      };
    }

    if (hasRunShell(this.container) && !isHostOnlyCommand(firstToken)) {
      logger.tagged('ecosystem-runtime', 'ecosystem-runtime', `routing to container shell: ${trimmed}`, 'debug');
      const result = await this.container.runShell(trimmed, { cwd: options?.cwd });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        command,
        dryRun: false,
      };
    }

    return this.hostRunner.run(command, options);
  }

  async runArgs(file: string, args: string[], options?: CommandRunnerOptions): Promise<CommandResult> {
    if (this.dryRun) {
      const command = `${file} ${args.join(' ')}`;
      return { stdout: '', stderr: '', exitCode: 0, command, dryRun: true };
    }

    if (matchesContainerBinary(file, this.spec.containerBinaries)) {
      // Route to container — argv shape depends on runMode
      const containerTokens = this._buildContainerTokensFromRunArgs(file, args);
      logger.tagged('ecosystem-runtime', 'ecosystem-runtime', `routing to container: ${file} ${args.join(' ')}`, 'debug');
      const result = await this._runContainer(containerTokens, options?.stream);
      const command = `${file} ${args.join(' ')}`;
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        command,
        dryRun: false,
      };
    }

    if (hasRunShell(this.container) && !isHostOnlyCommand(file)) {
      const shellCmd = [file, ...args].join(' ');
      logger.tagged('ecosystem-runtime', 'ecosystem-runtime', `routing to container shell: ${shellCmd}`, 'debug');
      const result = await this.container.runShell(shellCmd, { cwd: options?.cwd });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        command: shellCmd,
        dryRun: false,
      };
    }

    return this.hostRunner.runArgs(file, args, options);
  }

  /**
   * Dispatch to runStreaming (if supported and stream=true) or plain run.
   */
  private async _runContainer(
    tokens: string[],
    stream?: boolean,
  ): Promise<import('@infra/provisioner/types').ContainerRunResult> {
    if (stream && hasStreaming(this.container)) {
      return this.container.runStreaming(tokens);
    }
    return this.container.run(tokens);
  }

  /**
   * Build the argv array to pass to `_runContainer` for a `run(command)` call.
   *
   * Argv shape is determined by `spec.runMode.kind`:
   *
   * - `direct-exec`: The underlying DockerRunner prepends the binary itself
   *   (e.g. NpmDockerRunner appends 'npm' before the args internally).
   *   So we strip the binary token from the front and pass only the subcommand args.
   *   Example: run('npm install') → tokens=['npm','install'] → pass ['install']
   *
   * - `shell-wrap`: The underlying DockerRunner passes the joined string to sh -lc
   *   and does NOT prepend any binary. We pass the full token array as-is.
   *   Example: run('pip install requests') → tokens=['pip','install','requests'] → pass ['pip','install','requests']
   */
  private _buildContainerTokensFromRun(firstToken: string, tokens: string[]): string[] {
    if (this.spec.runMode.kind === 'direct-exec') {
      // Strip the leading binary token; the DockerRunner prepends it internally
      return tokens.slice(1);
    }
    // shell-wrap: pass tokens as-is (full command)
    return tokens;
  }

  /**
   * Build the argv array to pass to `_runContainer` for a `runArgs(file, args)` call.
   *
   * Argv shape is determined by `spec.runMode.kind`:
   *
   * - `direct-exec`: The underlying DockerRunner prepends the binary itself.
   *   So we pass only `args` (not `[file, ...args]`).
   *   Example: runArgs('npm', ['install']) → pass ['install']
   *
   * - `shell-wrap`: The underlying DockerRunner sh-wraps the joined string and does
   *   NOT prepend any binary. We pass `[file, ...args]` (full command).
   *   Example: runArgs('pip', ['install', 'requests']) → pass ['pip', 'install', 'requests']
   */
  private _buildContainerTokensFromRunArgs(file: string, args: string[]): string[] {
    if (this.spec.runMode.kind === 'direct-exec') {
      // Strip the binary; the DockerRunner prepends it internally
      return args;
    }
    // shell-wrap: pass [file, ...args] (full command)
    return [file, ...args];
  }
}
