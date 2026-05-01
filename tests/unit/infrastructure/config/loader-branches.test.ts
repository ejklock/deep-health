/**
 * Branch coverage top-up for src/infrastructure/config/loader.ts
 * Targets:
 *   lines 85-89: plugin.supportedFixers.length === 0 (ecosystem has no fixers but fixer was specified)
 *   lines 90-95: fixer not in plugin.supportedFixers (unsupported fixer strategy)
 *   lines 125-130: invalid YAML syntax triggers ConfigLoadError
 *
 * NOTE: validateEcosystemsAgainstRegistry (lines 85-95) must be called directly because
 * the Zod schema enforces a fixed fixer enum before cross-validation can fire via loadConfig.
 */
import { describe, it, expect, vi } from 'vitest';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

vi.mock('@infra/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), tagged: vi.fn() },
}));

import { loadConfig, validateEcosystemsAgainstRegistry } from '@infra/config/loader';
import { ConfigLoadError } from '@core/errors';
import { EcosystemRegistry } from '@modules/ecosystem/registry';
import type { EcosystemPlugin } from '@modules/ecosystem/types';
import type { ProjectConfig } from '@core/types/config';

// Minimal plugin stub
function makePluginStub(id: string, supportedFixers: string[]): EcosystemPlugin {
  return {
    id,
    name: id,
    lockfiles: [],
    osvEcosystems: [],
    reportLabel: id,
    supportedFixers,
    postUpdateOsvVerify: 'always',
    runtimeContainer: 'npm-docker' as const,
    defaultValidationCommands: [],
    defaultAdvisors: [],
    buildScanArgs: () => [],
    getProtectedPackages: () => [],
    runUpdater: async () => ({ agent: id, status: 'success', environment: 'local', packages_updated: [], validations: [] }),
  } as unknown as EcosystemPlugin;
}

async function writeTempConfig(content: string): Promise<string> {
  const dir = join(tmpdir(), `loader-test-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'project-config.yml');
  await writeFile(path, content, 'utf-8');
  return path;
}

// YAML with syntax error
const invalidYaml = `
project: {
  name: "broken
`;

describe('loadConfig() — YAML parse error branch (lines 125-130)', () => {
  it('throws ConfigLoadError when YAML is malformed', async () => {
    const configPath = await writeTempConfig(invalidYaml);
    await expect(loadConfig(configPath, '/')).rejects.toBeInstanceOf(ConfigLoadError);
    await expect(loadConfig(configPath, '/')).rejects.toThrow('Invalid YAML');
    await unlink(configPath);
  });
});

describe('validateEcosystemsAgainstRegistry() — direct coverage (lines 85-95)', () => {
  it('returns error when plugin has no supported fixers but a fixer was specified (line 85-89)', () => {
    const registry = new EcosystemRegistry();
    registry.register(makePluginStub('npm', [])); // no fixers

    const config = {
      ecosystems: [{ id: 'npm', fixer: 'osv' }],
    } as unknown as ProjectConfig;

    const errors = validateEcosystemsAgainstRegistry(config, registry);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('does not support any fixer strategy');
  });

  it('returns error when fixer is not in plugin supportedFixers list (lines 90-95)', () => {
    const registry = new EcosystemRegistry();
    registry.register(makePluginStub('npm', ['osv', 'npm-audit']));

    const config = {
      ecosystems: [{ id: 'npm', fixer: 'custom-fixer' }],
    } as unknown as ProjectConfig;

    const errors = validateEcosystemsAgainstRegistry(config, registry);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('custom-fixer');
  });

  it('returns empty errors when fixer is valid', () => {
    const registry = new EcosystemRegistry();
    registry.register(makePluginStub('npm', ['osv', 'npm-audit']));

    const config = {
      ecosystems: [{ id: 'npm', fixer: 'osv' }],
    } as unknown as ProjectConfig;

    const errors = validateEcosystemsAgainstRegistry(config, registry);
    expect(errors).toHaveLength(0);
  });

  it('returns error when ecosystem id is not registered (line 76-82)', () => {
    const registry = new EcosystemRegistry();
    // registry is empty

    const config = {
      ecosystems: [{ id: 'ruby' }],
    } as unknown as ProjectConfig;

    const errors = validateEcosystemsAgainstRegistry(config, registry);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('"ruby"');
  });
});
