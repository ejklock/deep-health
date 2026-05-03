import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProjectConfig } from '@core/types/config';
import { defaultRegistry } from '@modules/ecosystem/index';

vi.mock('@infra/config/loader', () => ({
  loadConfig: vi.fn(),
}));

vi.mock('@infra/executor/local-executor', () => ({
  LocalExecutor: vi.fn().mockImplementation(() => ({
    environment: 'local',
    dryRun: false,
    run: vi.fn(),
  })),
}));

vi.mock('@infra/utils/logger', () => ({
  setLogLevel: vi.fn(),
  setJsonMode: vi.fn(),
}));

import { loadConfig } from '@infra/config/loader';
import { LocalExecutor } from '@infra/executor/local-executor';
import { setLogLevel, setJsonMode } from '@infra/utils/logger';
import { createRunContext } from '@app/run-context';

const baseConfig: ProjectConfig = {
  project: { name: 'Test Project', client: 'Test Client' },
  ecosystems: [{ id: 'npm' }],
  protected_packages: { npm: [] },
  safe_update_policy: {
    allow_patch_and_minor_within_constraints: true,
    require_authorization_for_constraint_change: true,
  },
  conflict_resolution: 'stop_and_ask',
};

describe('createRunContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads config with default registry and creates a LocalExecutor', async () => {
    vi.mocked(loadConfig).mockResolvedValue(baseConfig);

    const result = await createRunContext({
      config: 'project-config.yml',
      cwd: '/repo',
      dryRun: false,
      verbose: false,
      quiet: false,
    });

    expect(loadConfig).toHaveBeenCalledWith('project-config.yml', '/repo', defaultRegistry);
    expect(LocalExecutor).toHaveBeenCalledWith({ dryRun: false });
    expect(result.config).toBe(baseConfig);
    expect(result.runner).toBeDefined();
  });

  it('passes dryRun flag to LocalExecutor', async () => {
    vi.mocked(loadConfig).mockResolvedValue(baseConfig);

    await createRunContext({
      config: 'project-config.yml',
      cwd: '/repo',
      dryRun: true,
      verbose: false,
      quiet: false,
    });

    expect(LocalExecutor).toHaveBeenCalledWith({ dryRun: true });
  });

  it('applies verbose and quiet log levels', async () => {
    vi.mocked(loadConfig).mockResolvedValue(baseConfig);

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

  it('calls setJsonMode(true) when opts.json is true', async () => {
    vi.mocked(loadConfig).mockResolvedValue(baseConfig);

    await createRunContext({
      config: 'project-config.yml',
      cwd: '/repo',
      dryRun: false,
      verbose: false,
      quiet: false,
      json: true,
    });

    expect(setJsonMode).toHaveBeenCalledWith(true);
  });

  it('does NOT call setJsonMode when opts.json is falsy', async () => {
    vi.mocked(loadConfig).mockResolvedValue(baseConfig);

    await createRunContext({
      config: 'project-config.yml',
      cwd: '/repo',
      dryRun: false,
      verbose: false,
      quiet: false,
    });

    expect(setJsonMode).not.toHaveBeenCalled();
  });
});
