import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CommandRunner, CommandResult } from '@core/types/common';

// ─── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@infra/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    phase: vi.fn(),
    skip: vi.fn(),
    header: vi.fn(),
    tagged: vi.fn(),
  },
}));

import { logger } from '@infra/utils/logger';
import { runEcosystemEnvironmentProbe } from '@modules/ecosystem/utils/environment-probe';
import type { ProbeSpec, ProbeResult } from '@modules/ecosystem/utils/environment-probe';

// ─── Helpers ───────────────────────────────────────────────────────────────────

function makeRunner(result: Partial<CommandResult>): CommandRunner {
  const full: CommandResult = {
    stdout: '',
    stderr: '',
    exitCode: 0,
    ...result,
  };
  return {
    run: vi.fn(),
    runArgs: vi.fn().mockResolvedValue(full),
    environment: 'local',
    dryRun: false,
  } as unknown as CommandRunner;
}

const BASE_SPEC: ProbeSpec = {
  binary: 'composer',
  args: ['install', '--no-interaction'],
  cwd: '/project',
  errorPrefix: 'Composer environment mismatch',
  label: 'composer',
};

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('runEcosystemEnvironmentProbe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('(1) returns { ok: true } when runner exits 0', async () => {
    const runner = makeRunner({ exitCode: 0 });
    const result = await runEcosystemEnvironmentProbe(runner, BASE_SPEC);
    expect(result).toEqual({ ok: true });
  });

  it('(2) returns { ok: false } with correct exitCode when runner exits non-zero', async () => {
    const runner = makeRunner({ exitCode: 1, stderr: 'some error' });
    const result = await runEcosystemEnvironmentProbe(runner, BASE_SPEC);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.exitCode).toBe(1);
    }
  });

  it('(3) error string format: {errorPrefix}: {binary} {args[0]} exited with code {N}.\\n{detail}', async () => {
    const runner = makeRunner({ exitCode: 2, stderr: 'PHP not found' });
    const result = await runEcosystemEnvironmentProbe(runner, BASE_SPEC);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(
        'Composer environment mismatch: composer install exited with code 2.\nPHP not found',
      );
    }
  });

  it('(4) detail uses stderr when present', async () => {
    const runner = makeRunner({ exitCode: 1, stderr: 'stderr content', stdout: 'stdout content' });
    const result = await runEcosystemEnvironmentProbe(runner, BASE_SPEC);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).toBe('stderr content');
    }
  });

  it('(5) detail uses stdout when stderr is empty', async () => {
    const runner = makeRunner({ exitCode: 1, stderr: '', stdout: 'stdout content' });
    const result = await runEcosystemEnvironmentProbe(runner, BASE_SPEC);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).toBe('stdout content');
    }
  });

  it('(6) detail is "(no output)" when both stderr and stdout are empty', async () => {
    const runner = makeRunner({ exitCode: 1, stderr: '', stdout: '' });
    const result = await runEcosystemEnvironmentProbe(runner, BASE_SPEC);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).toBe('(no output)');
    }
  });

  it('(7) forwards spec.cwd to runner.runArgs', async () => {
    const runner = makeRunner({ exitCode: 0 });
    const spec: ProbeSpec = { ...BASE_SPEC, cwd: '/custom/path' };
    await runEcosystemEnvironmentProbe(runner, spec);
    expect(runner.runArgs).toHaveBeenCalledWith(
      'composer',
      expect.any(Array),
      expect.objectContaining({ cwd: '/custom/path' }),
    );
  });
});
