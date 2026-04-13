import { runScanner } from "@modules/scanner/index";
import { writeOutput, formatScanSummary } from "@app/output-writer";
import type { RunContext } from "@app/run-context";

export interface ScanCommandOptions {
  config: string;
  cwd: string;
  dryRun: boolean;
  verbose: boolean;
  quiet: boolean;
  json: boolean;
  output?: string;
}

/**
 * Runs the vulnerability scan phase.
 * Returns an exit code:
 *   0 — clean
 *   1 — breaking vulnerabilities found
 *   2 — scanner error
 */
export async function runScanCommand(
  ctx: RunContext,
  opts: ScanCommandOptions,
): Promise<number> {
  const { config, runner } = ctx;

  const scanResult = await runScanner(runner, config, opts.cwd);

  const output = opts.json
    ? JSON.stringify(scanResult, null, 2)
    : formatScanSummary(scanResult);

  await writeOutput(output, opts.output);

  if (scanResult.status === "error") return 2;
  if (Object.values(scanResult.ecosystems).some((e) => e.breaking > 0)) return 1;
  return 0;
}
