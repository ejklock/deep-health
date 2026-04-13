import { execa } from 'execa';
import type { CommandRunner, CommandRunnerOptions, CommandResult } from '@core/types/common';

export class LocalExecutor implements CommandRunner {
  readonly dryRun: boolean;
  readonly environment = 'local' as const;

  constructor(options: { dryRun?: boolean } = {}) {
    this.dryRun = options.dryRun ?? false;
  }

  async run(command: string, options: CommandRunnerOptions = {}): Promise<CommandResult> {
    if (this.dryRun) {
      return {
        stdout: '',
        stderr: '',
        exitCode: 0,
        command,
        dryRun: true,
      };
    }

    try {
      const stdio = options.stream
        ? (['pipe', 'inherit'] as const)
        : ('pipe' as const);
      const result = await execa(command, {
        shell: true,
        cwd: options.cwd,
        timeout: options.timeout,
        env: options.env ? { ...process.env, ...options.env } : process.env,
        reject: false,
        stdout: stdio,
        stderr: stdio,
      });

      return {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        exitCode: result.exitCode ?? 1,
        command,
        dryRun: false,
      };
    } catch (err) {
      return {
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        exitCode: 1,
        command,
        dryRun: false,
      };
    }
  }
}
