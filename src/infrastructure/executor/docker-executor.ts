import { execa } from 'execa';
import type { CommandRunner, CommandRunnerOptions, CommandResult } from '@core/types/common.js';

export class DockerExecutor implements CommandRunner {
  readonly dryRun: boolean;
  readonly environment = 'docker' as const;

  constructor(
    private readonly service: string,
    options: { dryRun?: boolean; workdir?: string } = {},
  ) {
    this.dryRun = options.dryRun ?? false;
    this.workdir = options.workdir;
  }

  private readonly workdir?: string;

  private buildDockerCommand(command: string): string {
    const workdirFlag = this.workdir ? `--workdir ${this.workdir} ` : '';
    return `docker-compose exec -T ${workdirFlag}${this.service} sh -c "${command.replace(/"/g, '\\"')}"`;
  }

  async run(command: string, options: CommandRunnerOptions = {}): Promise<CommandResult> {
    const dockerCommand = this.buildDockerCommand(command);

    if (this.dryRun) {
      return { stdout: '', stderr: '', exitCode: 0, command: dockerCommand, dryRun: true };
    }

    try {
      const stdio = options.stream
        ? (['pipe', 'inherit'] as const)
        : ('pipe' as const);
      const result = await execa(dockerCommand, {
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
        command: dockerCommand,
        dryRun: false,
      };
    } catch (err) {
      return {
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        exitCode: 1,
        command: dockerCommand,
        dryRun: false,
      };
    }
  }
}
