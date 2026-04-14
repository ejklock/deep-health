import { ConfigLoadError, GateValidationError, PhaseError } from '@core/errors';

/**
 * Structured CLI error result — pure, no side effects.
 */
export interface CliErrorResult {
  /** Human-readable message for stderr */
  message: string;
  /** Process exit code */
  exitCode: number;
}

/**
 * Maps any thrown error to a { message, exitCode } pair.
 *
 * Exit code semantics (preserved from original runCliAction):
 *   0 — success (not an error; not produced here)
 *   1 — vulnerabilities / update errors (returned by handler, not thrown)
 *   2 — GateValidationError | PhaseError | unexpected error
 *   3 — ConfigLoadError
 *
 * Pure function — does not write to stderr or call process.exit.
 */
export function formatCliError(err: unknown): CliErrorResult {
  if (err instanceof ConfigLoadError) {
    return {
      message: `Configuration error: ${err.message}`,
      exitCode: 3,
    };
  }

  if (err instanceof GateValidationError) {
    const lines = [`Gate ${err.gate} validation failed:`, ...err.errors.map((e) => `  - ${e}`)];
    return {
      message: lines.join('\n'),
      exitCode: 2,
    };
  }

  if (err instanceof PhaseError) {
    return {
      message: `Phase "${err.phase}" failed: ${err.message}`,
      exitCode: 2,
    };
  }

  return {
    message: `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    exitCode: 2,
  };
}
