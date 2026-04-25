import { logger } from './logger';

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  retryOn?: (err: Error) => boolean;
}

const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  retryOn: () => true,
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: Partial<RetryOptions> = {},
): Promise<T> {
  const options = { ...DEFAULT_RETRY_OPTIONS, ...opts };
  let lastErr: Error = new Error('withRetry: no attempts made');

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));

      const shouldRetry = options.retryOn(lastErr);
      if (!shouldRetry || attempt === options.maxAttempts) {
        throw lastErr;
      }

      const delay = options.baseDelayMs * Math.pow(2, attempt - 1);
      logger.warn(
        `[retry] Attempt ${attempt} failed: ${lastErr.message}. Retrying in ${delay}ms (${attempt}/${options.maxAttempts})...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastErr;
}

export function isDockerTransientError(err: Error): boolean {
  const msg = err.message.toLowerCase();
  return (
    msg.includes('docker pull') ||
    msg.includes('network timeout') ||
    msg.includes('connection refused') ||
    msg.includes('exit code 125')
  );
}
