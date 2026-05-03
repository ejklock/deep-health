export type Ecosystem = string; // Maintains the alias; plugins define their own IDs
export type ExecutionEnv = 'docker' | 'local';
export type PhaseStatus = 'success' | 'error' | 'skipped';
export type VulnerabilityClass = 'auto_safe' | 'breaking' | 'manual';

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  command: string;
  dryRun: boolean;
  timedOut?: boolean;
  durationMs?: number;
}

export interface CommandRunnerOptions {
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
  stream?: boolean;
}

export interface CommandRunner {
  run(command: string, options?: CommandRunnerOptions): Promise<CommandResult>;
  /**
   * Shell-safe variant: executes `file` with `args` without a shell
   * (analogous to `execFile`). Use this for every invocation that embeds
   * untrusted values such as tokens or branch names to prevent shell-injection.
   *
   * All implementations MUST provide this method.
   * `run()` is reserved for static, trusted commands such as `--version` checks.
   */
  runArgs(file: string, args: string[], options?: CommandRunnerOptions): Promise<CommandResult>;
  readonly dryRun: boolean;
  readonly environment: ExecutionEnv;
}

export interface GateResult {
  valid: boolean;
  gate: string;
  errors: string[];
}
