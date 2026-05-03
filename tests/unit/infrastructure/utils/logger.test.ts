/**
 * Tests for src/infrastructure/utils/logger.ts
 * Covers all log levels, setLogLevel, shouldLog filtering, JSON mode, and timestamps.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Import the module — note logger module has module-level state (currentLevel, jsonMode)
// We need to reset between tests by reimporting

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

  it('includes ISO timestamp prefix in debug (verbose) mode', async () => {
    const { logger, setLogLevel } = await import('@infra/utils/logger');
    setLogLevel('debug');
    logger.debug('timestamped debug');
    const written = String((stderrSpy.mock.calls[0] as string[])[0]);
    // ISO 8601 format: YYYY-MM-DDTHH:MM:SS...Z
    expect(written).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('does NOT include ISO timestamp on info messages in non-debug mode', async () => {
    const { logger } = await import('@infra/utils/logger');
    logger.info('regular info');
    const written = String((stderrSpy.mock.calls[0] as string[])[0]);
    expect(written).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

describe('logger — JSON mode', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.resetModules();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits valid NDJSON with level/ts/msg for info in JSON mode', async () => {
    const { logger, setJsonMode } = await import('@infra/utils/logger');
    setJsonMode(true);
    logger.info('json info message');
    const written = String((stderrSpy.mock.calls[0] as string[])[0]).trim();
    const parsed = JSON.parse(written) as Record<string, unknown>;
    expect(parsed['level']).toBe('info');
    expect(parsed['msg']).toBe('json info message');
    expect(typeof parsed['ts']).toBe('string');
    // ts must be ISO 8601
    expect(String(parsed['ts'])).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('emits valid NDJSON for warn in JSON mode', async () => {
    const { logger, setJsonMode } = await import('@infra/utils/logger');
    setJsonMode(true);
    logger.warn('json warn message');
    const written = String((stderrSpy.mock.calls[0] as string[])[0]).trim();
    const parsed = JSON.parse(written) as Record<string, unknown>;
    expect(parsed['level']).toBe('warn');
    expect(parsed['msg']).toBe('json warn message');
  });

  it('emits valid NDJSON for error in JSON mode', async () => {
    const { logger, setJsonMode } = await import('@infra/utils/logger');
    setJsonMode(true);
    logger.error('json error message');
    const written = String((stderrSpy.mock.calls[0] as string[])[0]).trim();
    const parsed = JSON.parse(written) as Record<string, unknown>;
    expect(parsed['level']).toBe('error');
    expect(parsed['msg']).toBe('json error message');
  });

  it('emits valid NDJSON for debug in JSON mode when log level is debug', async () => {
    const { logger, setJsonMode, setLogLevel } = await import('@infra/utils/logger');
    setJsonMode(true);
    setLogLevel('debug');
    logger.debug('json debug message');
    const written = String((stderrSpy.mock.calls[0] as string[])[0]).trim();
    const parsed = JSON.parse(written) as Record<string, unknown>;
    expect(parsed['level']).toBe('debug');
    expect(parsed['msg']).toBe('json debug message');
  });

  it('does NOT emit plain text in JSON mode', async () => {
    const { logger, setJsonMode } = await import('@infra/utils/logger');
    setJsonMode(true);
    logger.info('plain test');
    const written = String((stderrSpy.mock.calls[0] as string[])[0]);
    expect(written).not.toContain('[INFO]');
  });

  it('setJsonMode(false) restores plain text output', async () => {
    const { logger, setJsonMode } = await import('@infra/utils/logger');
    setJsonMode(true);
    setJsonMode(false);
    logger.info('plain after toggle');
    const written = String((stderrSpy.mock.calls[0] as string[])[0]);
    expect(written).toContain('[INFO]');
    expect(() => JSON.parse(written)).toThrow();
  });

  it('JSON mode does NOT route info through progressSink', async () => {
    const { logger, setJsonMode, setProgressSink } = await import('@infra/utils/logger');
    setJsonMode(true);
    const sinkMessages: string[] = [];
    setProgressSink((msg) => sinkMessages.push(msg));
    logger.info('json mode info');
    setProgressSink(null);
    // progressSink should NOT have been called in JSON mode
    expect(sinkMessages).toHaveLength(0);
    // stderr should have been called with JSON
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  it('JSON mode still respects log level filtering', async () => {
    const { logger, setJsonMode } = await import('@infra/utils/logger');
    setJsonMode(true);
    // default level is info — debug should be suppressed
    logger.debug('suppressed in json mode');
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
