import { describe, it, expect, vi } from 'vitest';
import { LocalExecutor } from '@infra/executor/local-executor';
import { DockerExecutor } from '@infra/executor/docker-executor';

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

describe('DockerExecutor', () => {
  it('returns dry-run result with docker-prefixed command', async () => {
    const runner = new DockerExecutor('app', { dryRun: true });
    const result = await runner.run('composer install');
    expect(result.dryRun).toBe(true);
    expect(result.command).toContain('docker-compose exec -T app');
    expect(result.command).toContain('composer install');
  });

  it('has correct environment', () => {
    const runner = new DockerExecutor('app');
    expect(runner.environment).toBe('docker');
  });
});
