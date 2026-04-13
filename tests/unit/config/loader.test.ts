import { describe, it, expect } from 'vitest';
import { loadConfig } from '@infra/config/loader';
import { ConfigLoadError } from '@core/errors';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, '../../fixtures');

describe('loadConfig', () => {
  it('loads a valid config file', async () => {
    const config = await loadConfig('project-config.yml', fixturesDir);
    expect(config.project.name).toBe('Test PHP Project');
    expect(config.project.client).toBe('Test Client');
    expect(config.runtime.execution).toBe('docker');
    expect(config.runtime.docker_service).toBe('app');
    expect(config.protected_packages.composer).toHaveLength(2);
    expect(config.protected_packages.npm).toHaveLength(2);
  });

  it('throws ConfigLoadError when file does not exist', async () => {
    await expect(loadConfig('nonexistent.yml', fixturesDir)).rejects.toThrow(ConfigLoadError);
  });

  it('throws ConfigLoadError for missing required fields', async () => {
    // Write a temp config missing required fields
    const { writeFile, unlink } = await import('node:fs/promises');
    const tempPath = resolve(fixturesDir, '_temp_test_config.yml');
    await writeFile(tempPath, 'project:\n  name: test\n');
    try {
      await expect(loadConfig('_temp_test_config.yml', fixturesDir)).rejects.toThrow(
        ConfigLoadError,
      );
    } finally {
      await unlink(tempPath).catch(() => {});
    }
  });

  it('correctly loads protected packages', async () => {
    const config = await loadConfig('project-config.yml', fixturesDir);
    const laravelFramework = config.protected_packages.composer.find(
      (p) => p.package === 'laravel/framework',
    );
    expect(laravelFramework).toBeDefined();
    expect(laravelFramework?.constraint).toBe('^10.8');
  });
});
