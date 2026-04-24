import type { CommandRunner } from '@core/types/common';
import type { AdvisorConfig } from '@core/types/config';
import type { AdvisorResult, AdvisorFinding } from '@core/types/report';
import { logger } from '@infra/utils/logger';
import { parseNpmAuditJson } from '@modules/ecosystem/plugins/npm-audit-parser';

/**
 * Run advisor commands for a single ecosystem (informational only — never throws).
 *
 * Advisors produce observability output but never affect the pipeline outcome.
 * Even if an advisor command fails (non-zero exit), the pipeline continues.
 *
 * Status semantics:
 * - 'clean':    command exited 0 and (for json format) produced no findings.
 * - 'findings': command completed (any exit code) and findings were detected.
 * - 'error':    command threw an exception or produced unparseable output for json format.
 * - 'skipped':  not currently used at runtime (reserved for config-level suppression).
 *
 * SEC-004 — Trust boundary:
 * Advisor command strings come from the project config file (operator-controlled).
 * They are run via `runner.run(advisor.command)` using `shell: true` in LocalExecutor.
 * This is intentional: operators author advisor commands as shell strings.
 * The trust boundary is: advisor command strings MUST NOT include external
 * (scanner-sourced or network-sourced) data. Callers are responsible for this invariant.
 */
export async function runAdvisors(
  runner: CommandRunner,
  cwd: string,
  ecosystemId: string,
  advisors: AdvisorConfig[],
): Promise<AdvisorResult[]> {
  if (advisors.length === 0) return [];

  const results: AdvisorResult[] = [];

  for (const advisor of advisors) {
    logger.info(`[Advisor] ${ecosystemId}/${advisor.name}: ${advisor.command}`);
    const isJsonFormat = advisor.format === 'json';

    try {
      const cmdResult = await runner.run(advisor.command, { cwd });
      const rawOutput = cmdResult.stdout.trim();

      if (isJsonFormat) {
        // Structured JSON advisor (e.g. npm audit --json)
        let findings: AdvisorFinding[];
        try {
          findings = parseNpmAuditJson(rawOutput);
        } catch (parseErr) {
          // Malformed / unparseable JSON → classify as error, not clean
          const parseMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
          logger.warn(`[Advisor] ${ecosystemId}/${advisor.name} JSON parse failed (non-fatal): ${parseMsg}`);
          results.push({
            name: advisor.name,
            command: advisor.command,
            exitCode: cmdResult.exitCode,
            output: rawOutput.slice(0, 200),
            status: 'error',
          });
          continue;
        }
        const hasFindings = findings.length > 0;

        results.push({
          name: advisor.name,
          command: advisor.command,
          exitCode: cmdResult.exitCode,
          output: '',
          status: hasFindings ? 'findings' : 'clean',
          findings,
        });
      } else {
        // Plain text advisor
        const outputLines = rawOutput.split('\n');
        const output = outputLines.slice(-20).join('\n');
        results.push({
          name: advisor.name,
          command: advisor.command,
          exitCode: cmdResult.exitCode,
          output,
          status: cmdResult.exitCode === 0 ? 'clean' : 'findings',
        });
      }
    } catch (err) {
      // Advisor failure is always non-fatal
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[Advisor] ${ecosystemId}/${advisor.name} failed (non-fatal): ${message}`);
      results.push({
        name: advisor.name,
        command: advisor.command,
        exitCode: -1,
        output: message,
        status: 'error',
      });
    }
  }

  return results;
}
