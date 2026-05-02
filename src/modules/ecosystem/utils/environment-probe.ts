import type { CommandRunner } from '@core/types/common';
import { logger } from '@infra/utils/logger';

export interface ProbeSpec {
  binary: string;
  args: readonly string[];
  cwd: string;
  errorPrefix: string;
  label: string;
}

export type ProbeResult =
  | { ok: true }
  | { ok: false; exitCode: number; detail: string; error: string };

export async function runEcosystemEnvironmentProbe(
  runner: CommandRunner,
  spec: ProbeSpec,
): Promise<ProbeResult> {
  logger.tagged(spec.label, 'env-check', `Running ${spec.binary} ${spec.args[0]} to verify environment...`);
  const result = await runner.runArgs(spec.binary, [...spec.args], { cwd: spec.cwd });
  if (result.exitCode === 0) {
    logger.tagged(spec.label, 'env-check', 'Environment check passed.');
    return { ok: true };
  }
  const detail = result.stderr || result.stdout || '(no output)';
  const error = `${spec.errorPrefix}: ${spec.binary} ${spec.args[0]} exited with code ${result.exitCode}.\n${detail}`;
  logger.tagged(spec.label, 'env-check', 'Environment check failed — aborting update.', 'error');
  return { ok: false, exitCode: result.exitCode, detail, error };
}
