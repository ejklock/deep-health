import { describe, it, expect } from 'vitest';
import { LocalExecutor } from '@infra/executor/local-executor';

describe('LocalExecutor', () => {
  it('returns dry-run result without executing', async () => {
    const runner = new LocalExecutor({ dryRun: true });
    const result = await runner.run('echo hello');
    expect(result.dryRun).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.command).toBe('echo hello');
  });

  it('has correct environment', () => {
    const runner = new LocalExecutor();
    expect(runner.environment).toBe('local');
  });

  it('executes a real command', async () => {
    const runner = new LocalExecutor();
    const result = await runner.run('echo test-output');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('test-output');
    expect(result.dryRun).toBe(false);
  });

  it('captures non-zero exit code', async () => {
    const runner = new LocalExecutor();
    const result = await runner.run('exit 1');
    expect(result.exitCode).toBe(1);
  });
});
