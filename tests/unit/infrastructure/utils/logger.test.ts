/**
 * Tests for src/infrastructure/utils/logger.ts
 * Covers all log levels, setLogLevel, shouldLog filtering.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Import the module — note logger module has module-level state (currentLevel)
// We need to reset between tests by reimporting or calling setLogLevel

describe('logger', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    // Reimport to reset module state
    vi.resetModules();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs info messages at default level', async () => {
    const { logger } = await import('@infra/utils/logger');
    logger.info('hello info');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('[INFO]'));
  });

  it('logs warn messages at default level', async () => {
    const { logger } = await import('@infra/utils/logger');
    logger.warn('hello warn');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('[WARN]'));
  });

  it('logs error messages at default level', async () => {
    const { logger } = await import('@infra/utils/logger');
    logger.error('hello error');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('[ERROR]'));
  });

  it('does NOT log debug messages at default (info) level', async () => {
    const { logger } = await import('@infra/utils/logger');
    logger.debug('hidden debug');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('logs debug messages after setLogLevel("debug")', async () => {
    const { logger, setLogLevel } = await import('@infra/utils/logger');
    setLogLevel('debug');
    logger.debug('visible debug');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('[DEBUG]'));
  });

  it('suppresses info when level is set to warn', async () => {
    const { logger, setLogLevel } = await import('@infra/utils/logger');
    setLogLevel('warn');
    logger.info('suppressed info');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('suppresses warn when level is set to error', async () => {
    const { logger, setLogLevel } = await import('@infra/utils/logger');
    setLogLevel('error');
    logger.warn('suppressed warn');
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});
