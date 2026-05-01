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

describe('logger.tagged()', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.resetModules();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes to stderr at info level by default', async () => {
    const { logger } = await import('@infra/utils/logger');
    logger.tagged('osv', 'OSV verify', 'hello');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('[INFO]'));
  });

  it('output contains the literal [<label>] substring', async () => {
    const { logger } = await import('@infra/utils/logger');
    logger.tagged('osv', 'OSV verify', 'hello');
    const written = String((stderrSpy.mock.calls[0] as string[])[0]);
    // strip ANSI
    const plain = written.replace(/\x1B\[[0-9;]*m/g, '');
    expect(plain).toContain('[OSV verify] hello');
  });

  it('writes at warn level when level="warn"', async () => {
    const { logger } = await import('@infra/utils/logger');
    logger.tagged('npm', 'npm-audit fix', 'something went wrong', 'warn');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('[WARN]'));
  });

  it('writes at error level when level="error"', async () => {
    const { logger } = await import('@infra/utils/logger');
    logger.tagged('composer', 'composer env-check', 'env failed', 'error');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('[ERROR]'));
    const written = String((stderrSpy.mock.calls[0] as string[])[0]);
    const plain = written.replace(/\x1B\[[0-9;]*m/g, '');
    expect(plain).toContain('[composer env-check] env failed');
  });

  it('writes at debug level when level="debug" and log level is debug', async () => {
    const { logger, setLogLevel } = await import('@infra/utils/logger');
    setLogLevel('debug');
    logger.tagged('osv', 'OSV fix', 'exited with code 0', 'debug');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('[DEBUG]'));
    const written = String((stderrSpy.mock.calls[0] as string[])[0]);
    const plain = written.replace(/\x1B\[[0-9;]*m/g, '');
    expect(plain).toContain('[OSV fix] exited with code 0');
  });

  it('suppresses debug-level tagged when log level is info (default)', async () => {
    const { logger } = await import('@infra/utils/logger');
    logger.tagged('osv', 'OSV fix', 'hidden debug msg', 'debug');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('routes through progressSink for info level', async () => {
    const { logger, setProgressSink } = await import('@infra/utils/logger');
    const sinkMessages: string[] = [];
    setProgressSink((msg) => sinkMessages.push(msg));
    logger.tagged('osv', 'OSV fix', 'staged');
    setProgressSink(null);
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(sinkMessages.length).toBe(1);
    const plain = sinkMessages[0].replace(/\x1B\[[0-9;]*m/g, '');
    expect(plain).toContain('[OSV fix] staged');
  });

  it('does NOT route warn through progressSink', async () => {
    const { logger, setProgressSink } = await import('@infra/utils/logger');
    const sinkMessages: string[] = [];
    setProgressSink((msg) => sinkMessages.push(msg));
    logger.tagged('npm', 'osv-then-audit', 'problem', 'warn');
    setProgressSink(null);
    expect(sinkMessages.length).toBe(0);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('[WARN]'));
  });

  it('unknown id falls back to default badge color', async () => {
    const { logger } = await import('@infra/utils/logger');
    logger.tagged('mystery-tool', 'mystery-tool label', 'msg');
    const written = String((stderrSpy.mock.calls[0] as string[])[0]);
    const plain = written.replace(/\x1B\[[0-9;]*m/g, '');
    expect(plain).toContain('[mystery-tool label] msg');
  });

  it('respects shouldLog gating — suppresses info when level=warn', async () => {
    const { logger, setLogLevel } = await import('@infra/utils/logger');
    setLogLevel('warn');
    logger.tagged('osv', 'OSV verify', 'hidden');
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});
