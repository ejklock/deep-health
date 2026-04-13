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
}

export interface CommandRunnerOptions {
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
  stream?: boolean;
}

export interface CommandRunner {
  run(command: string, options?: CommandRunnerOptions): Promise<CommandResult>;
  readonly dryRun: boolean;
  readonly environment: ExecutionEnv;
}

export interface GateResult {
  valid: boolean;
  gate: string;
  errors: string[];
}
