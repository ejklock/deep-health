/**
 * Branch coverage top-up for src/infrastructure/executor/local-executor.ts
 * Covers ENOENT detection in both run() and runArgs(), plus stream option,
 * and non-ENOENT error fallback.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { execa } from 'execa';
import { LocalExecutor } from '@infra/executor/local-executor';
import { EnvironmentError } from '@core/errors';

const mockExeca = vi.mocked(execa);

describe('LocalExecutor.run()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns dry-run result when dryRun=true', async () => {
    const executor = new LocalExecutor({ dryRun: true });
    const result = await executor.run('npm install');
    expect(result.dryRun).toBe(true);
    expect(result.stdout).toBe('');
    expect(execa).not.toHaveBeenCalled();
  });

  it('returns success result when command succeeds', async () => {
    mockExeca.mockResolvedValue({ stdout: 'output', stderr: '', exitCode: 0 } as any);
    const executor = new LocalExecutor();
    const result = await executor.run('echo hello');
    expect(result.stdout).toBe('output');
    expect(result.exitCode).toBe(0);
    expect(result.dryRun).toBe(false);
  });

  it('uses stream stdio when options.stream=true', async () => {
    mockExeca.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 } as any);
    const executor = new LocalExecutor();
    await executor.run('npm install', { stream: true });
    expect(mockExeca).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      stdout: expect.any(Array),
    }));
  });

  it('passes env options when provided', async () => {
    mockExeca.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 } as any);
    const executor = new LocalExecutor();
    await executor.run('cmd', { env: { FOO: 'bar' } });
    expect(mockExeca).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      env: expect.objectContaining({ FOO: 'bar' }),
    }));
  });

  it('throws EnvironmentError when ENOENT error occurs (direct code)', async () => {
    const err = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    mockExeca.mockRejectedValue(err);
    const executor = new LocalExecutor();
    await expect(executor.run('nonexistent-cmd')).rejects.toBeInstanceOf(EnvironmentError);
  });

  it('throws EnvironmentError when ENOENT is on err.cause', async () => {
    const cause = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const err = new Error('spawn failed');
    (err as any).cause = cause;
    mockExeca.mockRejectedValue(err);
    const executor = new LocalExecutor();
    await expect(executor.run('nonexistent-cmd')).rejects.toBeInstanceOf(EnvironmentError);
  });

  it('returns error result for non-ENOENT error', async () => {
    mockExeca.mockRejectedValue(new Error('permission denied'));
    const executor = new LocalExecutor();
    const result = await executor.run('restricted-cmd');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('permission denied');
  });

  it('returns error result for non-Error thrown value', async () => {
    mockExeca.mockRejectedValue('string error');
    const executor = new LocalExecutor();
    const result = await executor.run('cmd');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('string error');
  });

  it('falls back to empty strings and exitCode=1 when execa result fields are undefined (lines 39-41)', async () => {
    // Execa returns an object without stdout/stderr/exitCode
    mockExeca.mockResolvedValue({} as any);
    const executor = new LocalExecutor();
    const result = await executor.run('cmd');
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(1);
  });
});

describe('LocalExecutor.runArgs()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns dry-run result when dryRun=true', async () => {
    const executor = new LocalExecutor({ dryRun: true });
    const result = await executor.runArgs('npm', ['install']);
    expect(result.dryRun).toBe(true);
    expect(execa).not.toHaveBeenCalled();
  });

  it('returns success result when command succeeds', async () => {
    mockExeca.mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 } as any);
    const executor = new LocalExecutor();
    const result = await executor.runArgs('npm', ['install']);
    expect(result.stdout).toBe('ok');
    expect(result.exitCode).toBe(0);
  });

  it('throws EnvironmentError for ENOENT in runArgs', async () => {
    const err = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    mockExeca.mockRejectedValue(err);
    const executor = new LocalExecutor();
    await expect(executor.runArgs('nonexistent', ['arg'])).rejects.toBeInstanceOf(EnvironmentError);
  });

  it('throws EnvironmentError when ENOENT on cause in runArgs', async () => {
    const cause = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const err = new Error('spawn failed');
    (err as any).cause = cause;
    mockExeca.mockRejectedValue(err);
    const executor = new LocalExecutor();
    await expect(executor.runArgs('nonexistent', ['arg'])).rejects.toBeInstanceOf(EnvironmentError);
  });

  it('returns error result for non-ENOENT error in runArgs', async () => {
    mockExeca.mockRejectedValue(new Error('access denied'));
    const executor = new LocalExecutor();
    const result = await executor.runArgs('cmd', ['arg']);
    expect(result.exitCode).toBe(1);
  });

  it('falls back to empty strings and exitCode=1 when runArgs execa result fields are undefined (lines 85-87)', async () => {
    mockExeca.mockResolvedValue({} as any);
    const executor = new LocalExecutor();
    const result = await executor.runArgs('npm', ['install']);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(1);
  });

  it('uses String(err) when runArgs catches a non-Error value (line 101 in runArgs)', async () => {
    mockExeca.mockRejectedValue('runArgs string error');
    const executor = new LocalExecutor();
    const result = await executor.runArgs('cmd', ['arg']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('runArgs string error');
  });

  it('uses process.env when options.env is absent (line 80 false branch)', async () => {
    mockExeca.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 } as any);
    const executor = new LocalExecutor();
    // runArgs with no env option → options.env is undefined → false branch fires
    const result = await executor.runArgs('npm', ['install'], {});
    expect(result.exitCode).toBe(0);
  });
});
