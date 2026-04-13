import type { CommandRunner, ExecutionEnv } from '@core/types/common.js';
import { LocalExecutor } from '../executor/local-executor.js';
import { DockerExecutor } from '../executor/docker-executor.js';
import { logger } from '../utils/logger.js';

export async function detectEnvironment(
  preferredEnv: ExecutionEnv,
  dockerService: string,
  cwd: string,
  dryRun = false,
  dockerWorkdir?: string,
): Promise<CommandRunner> {
  if (preferredEnv === 'local') {
    logger.debug('Using local execution (configured preference)');
    return new LocalExecutor({ dryRun });
  }

  const probe = new LocalExecutor();
  const result = await probe.run(
    `docker-compose ps ${dockerService} 2>/dev/null | grep -c "Up"`,
    { cwd },
  );

  if (result.exitCode === 0 && parseInt(result.stdout.trim(), 10) > 0) {
    const workdirInfo = dockerWorkdir ? ` (workdir: ${dockerWorkdir})` : '';
    logger.debug(`Using Docker execution (service: ${dockerService}${workdirInfo})`);
    return new DockerExecutor(dockerService, { dryRun, workdir: dockerWorkdir });
  }

  logger.warn(`Docker service "${dockerService}" not running — falling back to local execution`);
  return new LocalExecutor({ dryRun });
}
