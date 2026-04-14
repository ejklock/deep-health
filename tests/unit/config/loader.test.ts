import { describe, it, expect } from 'vitest';
import { loadConfig, validateEcosystemsAgainstRegistry } from '@infra/config/loader';
import { ConfigLoadError } from '@core/errors';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { EcosystemRegistry } from '@modules/ecosystem/registry';
import { npmPlugin } from '@modules/ecosystem/plugins/npm';
import { composerPlugin } from '@modules/ecosystem/plugins/composer';
import type { ProjectConfig } from '@core/types/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, '../../fixtures');

function makeRegistry(): EcosystemRegistry {
  const reg = new EcosystemRegistry();
  reg.register(npmPlugin);
  reg.register(composerPlugin);
  return reg;
}

function baseConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    project: { name: 'test', client: 'test' },
    runtime: { execution: 'local', docker_service: '' },
    ecosystems: [{ id: 'npm' }, { id: 'composer' }],
    protected_packages: {},
    safe_update_policy: {
      allow_patch_and_minor_within_constraints: true,
      require_authorization_for_constraint_change: false,
    },
    conflict_resolution: 'fail',
    ...overrides,
  };
}

describe('loadConfig', () => {
  it('loads a valid config file', async () => {
    const config = await loadConfig('project-config.yml', fixturesDir);
    expect(config.project.name).toBe('Test PHP Project');
    expect(config.project.client).toBe('Test Client');
    expect(config.runtime.execution).toBe('docker');
    expect(config.runtime.docker_service).toBe('app');
    expect(config.protected_packages['composer']).toHaveLength(2);
    expect(config.protected_packages['npm']).toHaveLength(2);
  });

  it('loads ecosystems[] from config', async () => {
    const config = await loadConfig('project-config.yml', fixturesDir);
    expect(Array.isArray(config.ecosystems)).toBe(true);
    expect(config.ecosystems.length).toBeGreaterThanOrEqual(1);
    const ids = config.ecosystems.map((e) => e.id);
    expect(ids).toContain('composer');
    expect(ids).toContain('npm');
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

  it('throws ConfigLoadError when ecosystems[] is empty', async () => {
    const { writeFile, unlink } = await import('node:fs/promises');
    const tempPath = resolve(fixturesDir, '_temp_no_ecosystems.yml');
    await writeFile(
      tempPath,
      `project:\n  name: test\n  client: test\nruntime:\n  execution: local\n  docker_service: app\necosystems: []\nprotected_packages: {}\nsafe_update_policy:\n  allow_patch_and_minor_within_constraints: true\n  require_authorization_for_constraint_change: true\nconflict_resolution: stop_and_ask\n`,
    );
    try {
      await expect(loadConfig('_temp_no_ecosystems.yml', fixturesDir)).rejects.toThrow(
        ConfigLoadError,
      );
    } finally {
      await unlink(tempPath).catch(() => {});
    }
  });

  it('correctly loads protected packages', async () => {
    const config = await loadConfig('project-config.yml', fixturesDir);
    const laravelFramework = config.protected_packages['composer']?.find(
      (p) => p.package === 'laravel/framework',
    );
    expect(laravelFramework).toBeDefined();
    expect(laravelFramework?.constraint).toBe('^10.8');
  });

  it('passes cross-validation with registry when all ecosystem ids are registered', async () => {
    const registry = makeRegistry();
    const config = await loadConfig('project-config.yml', fixturesDir, registry);
    expect(config.ecosystems.map((e) => e.id)).toContain('npm');
    expect(config.ecosystems.map((e) => e.id)).toContain('composer');
  });

  it('throws ConfigLoadError when ecosystem id is not in registry', async () => {
    const { writeFile, unlink } = await import('node:fs/promises');
    const tempPath = resolve(fixturesDir, '_temp_unknown_eco.yml');
    await writeFile(
      tempPath,
      `project:\n  name: test\n  client: test\nruntime:\n  execution: local\n  docker_service: app\necosystems:\n  - id: 'unknown-eco'\nprotected_packages: {}\nsafe_update_policy:\n  allow_patch_and_minor_within_constraints: true\n  require_authorization_for_constraint_change: false\nconflict_resolution: fail\n`,
    );
    try {
      const registry = makeRegistry();
      await expect(loadConfig('_temp_unknown_eco.yml', fixturesDir, registry)).rejects.toThrow(
        ConfigLoadError,
      );
    } finally {
      await unlink(tempPath).catch(() => {});
    }
  });
});

describe('validateEcosystemsAgainstRegistry', () => {
  it('returns empty errors for valid ecosystems', () => {
    const registry = makeRegistry();
    const config = baseConfig({ ecosystems: [{ id: 'npm' }, { id: 'composer' }] });
    const errors = validateEcosystemsAgainstRegistry(config, registry);
    expect(errors).toHaveLength(0);
  });

  it('returns error for unknown ecosystem id', () => {
    const registry = makeRegistry();
    const config = baseConfig({ ecosystems: [{ id: 'cargo' }] });
    const errors = validateEcosystemsAgainstRegistry(config, registry);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/cargo/);
    expect(errors[0]).toMatch(/not registered/i);
  });

  it('returns error when fixer is incompatible with plugin', () => {
    const registry = makeRegistry();
    // composer does not support any fixers — specifying one is an error
    const config = baseConfig({ ecosystems: [{ id: 'composer', fixer: 'osv' }] });
    const errors = validateEcosystemsAgainstRegistry(config, registry);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/composer/);
    expect(errors[0]).toMatch(/fixer/i);
  });

  it('returns error when fixer is not in supported list', () => {
    // If somehow a plugin only supports 'osv' but config specifies 'npm-audit'
    const registry = new EcosystemRegistry();
    const limitedPlugin = { ...npmPlugin, id: 'limited', supportedFixers: ['osv' as const] };
    registry.register(limitedPlugin);
    const config = baseConfig({ ecosystems: [{ id: 'limited', fixer: 'npm-audit' as const }] });
    const errors = validateEcosystemsAgainstRegistry(config, registry);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/npm-audit/);
    expect(errors[0]).toMatch(/not supported/i);
  });

  it('passes when fixer is in plugin supportedFixers', () => {
    const registry = makeRegistry();
    // npm supports both 'osv' and 'npm-audit'
    const config = baseConfig({ ecosystems: [{ id: 'npm', fixer: 'osv' }] });
    const errors = validateEcosystemsAgainstRegistry(config, registry);
    expect(errors).toHaveLength(0);
  });

  it('accumulates multiple errors', () => {
    const registry = makeRegistry();
    const config = baseConfig({
      ecosystems: [
        { id: 'unknown-a' },
        { id: 'unknown-b' },
      ],
    });
    const errors = validateEcosystemsAgainstRegistry(config, registry);
    expect(errors).toHaveLength(2);
  });
});

describe('SonarQube project_key schema validation', () => {
  it('rejects an invalid project_key containing spaces', async () => {
    const { writeFile, unlink } = await import('node:fs/promises');
    const tempPath = resolve(fixturesDir, '_temp_invalid_sonar_key.yml');
    await writeFile(
      tempPath,
      `project:\n  name: test\n  client: test\nruntime:\n  execution: local\n  docker_service: app\necosystems:\n  - id: npm\nprotected_packages: {}\nsafe_update_policy:\n  allow_patch_and_minor_within_constraints: true\n  require_authorization_for_constraint_change: false\nconflict_resolution: fail\nscanners:\n  sonarqube:\n    enabled: true\n    project_key: 'My Invalid Key'\n`,
    );
    try {
      await expect(loadConfig('_temp_invalid_sonar_key.yml', fixturesDir)).rejects.toThrow(
        ConfigLoadError,
      );
    } finally {
      await unlink(tempPath).catch(() => {});
    }
  });

  it('rejects an invalid project_key containing special characters', async () => {
    const { writeFile, unlink } = await import('node:fs/promises');
    const tempPath = resolve(fixturesDir, '_temp_invalid_sonar_key2.yml');
    await writeFile(
      tempPath,
      `project:\n  name: test\n  client: test\nruntime:\n  execution: local\n  docker_service: app\necosystems:\n  - id: npm\nprotected_packages: {}\nsafe_update_policy:\n  allow_patch_and_minor_within_constraints: true\n  require_authorization_for_constraint_change: false\nconflict_resolution: fail\nscanners:\n  sonarqube:\n    enabled: true\n    project_key: 'my project!'\n`,
    );
    try {
      await expect(loadConfig('_temp_invalid_sonar_key2.yml', fixturesDir)).rejects.toThrow(
        ConfigLoadError,
      );
    } finally {
      await unlink(tempPath).catch(() => {});
    }
  });

  it('accepts a valid project_key with hyphens and colons', async () => {
    const { writeFile, unlink } = await import('node:fs/promises');
    const tempPath = resolve(fixturesDir, '_temp_valid_sonar_key.yml');
    await writeFile(
      tempPath,
      `project:\n  name: test\n  client: test\nruntime:\n  execution: local\n  docker_service: app\necosystems:\n  - id: npm\nprotected_packages: {}\nsafe_update_policy:\n  allow_patch_and_minor_within_constraints: true\n  require_authorization_for_constraint_change: false\nconflict_resolution: fail\nscanners:\n  sonarqube:\n    enabled: true\n    project_key: 'org:my-project_v2'\n`,
    );
    try {
      const config = await loadConfig('_temp_valid_sonar_key.yml', fixturesDir);
      expect(config.scanners?.sonarqube?.project_key).toBe('org:my-project_v2');
    } finally {
      await unlink(tempPath).catch(() => {});
    }
  });
});
