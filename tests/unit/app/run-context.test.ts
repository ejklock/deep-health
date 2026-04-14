import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProjectConfig } from '@core/types/config';
import { defaultRegistry } from '@modules/ecosystem/index';

vi.mock('@infra/config/loader', () => ({
  loadConfig: vi.fn(),
}));

vi.mock('@infra/environment/detector', () => ({
  detectEnvironment: vi.fn(),
}));

vi.mock('@infra/utils/logger', () => ({
  setLogLevel: vi.fn(),
}));

import { loadConfig } from '@infra/config/loader';
import { detectEnvironment } from '@infra/environment/detector';
import { setLogLevel } from '@infra/utils/logger';
import { createRunContext } from '@app/run-context';

const baseConfig: ProjectConfig = {
  project: { name: 'Test Project', client: 'Test Client' },
  runtime: { execution: 'local', docker_service: 'app' },
  ecosystems: [{ id: 'npm' }],
  protected_packages: { npm: [] },
  safe_update_policy: {
    allow_patch_and_minor_within_constraints: true,
    require_authorization_for_constraint_change: true,
    authorization_format: 'yes',
  },
  conflict_resolution: 'stop_and_ask',
};

describe('createRunContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads config with default registry and builds runner', async () => {
    const runner = { environment: 'local', run: vi.fn() };
    vi.mocked(loadConfig).mockResolvedValue(baseConfig);
    vi.mocked(detectEnvironment).mockResolvedValue(runner as never);

    const result = await createRunContext({
      config: 'project-config.yml',
      cwd: '/repo',
      dryRun: false,
      verbose: false,
      quiet: false,
    });

    expect(loadConfig).toHaveBeenCalledWith('project-config.yml', '/repo', defaultRegistry);
    expect(detectEnvironment).toHaveBeenCalledWith('local', 'app', '/repo', false, undefined);
    expect(result).toEqual({ config: baseConfig, runner });
  });

  it('applies verbose and quiet log levels', async () => {
    const runner = { environment: 'docker', run: vi.fn() };
    vi.mocked(loadConfig).mockResolvedValue(baseConfig);
    vi.mocked(detectEnvironment).mockResolvedValue(runner as never);

    await createRunContext({
      config: 'project-config.yml',
      cwd: '/repo',
      dryRun: true,
      verbose: true,
      quiet: true,
    });

    expect(setLogLevel).toHaveBeenCalledWith('debug');
    expect(setLogLevel).toHaveBeenCalledWith('error');
  });
});
