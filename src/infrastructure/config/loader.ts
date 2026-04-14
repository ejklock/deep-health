import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { ProjectConfigSchema } from './schema';
import type { ProjectConfig } from '@core/types/config';
import { ConfigLoadError } from '@core/errors';
import type { EcosystemRegistry } from '@modules/ecosystem/registry';

export const DEFAULT_CONFIG_PATH = 'project-config.yml';

/**
 * Cross-validate config.ecosystems[] against the plugin registry.
 *
 * Validates:
 * 1. Every ecosystem id in config.ecosystems[] must be registered in the plugin registry.
 * 2. If a fixer strategy is specified, it must be in the plugin's supportedFixers list.
 *
 * Returns an array of error messages (empty = valid).
 */
export function validateEcosystemsAgainstRegistry(
  config: ProjectConfig,
  registry: EcosystemRegistry,
): string[] {
  const errors: string[] = [];

  for (const ecoEntry of config.ecosystems) {
    const plugin = registry.get(ecoEntry.id);

    if (!plugin) {
      errors.push(
        `Ecosystem id "${ecoEntry.id}" is not registered. ` +
        `Available ids: ${registry.getAll().map((p) => p.id).join(', ') || '(none registered)'}`,
      );
      continue;
    }

    if (ecoEntry.fixer !== undefined) {
      if (plugin.supportedFixers.length === 0) {
        errors.push(
          `Ecosystem "${ecoEntry.id}" does not support any fixer strategy, ` +
          `but fixer "${ecoEntry.fixer}" was specified in config.`,
        );
      } else if (!plugin.supportedFixers.includes(ecoEntry.fixer)) {
        errors.push(
          `Fixer strategy "${ecoEntry.fixer}" is not supported by ecosystem "${ecoEntry.id}". ` +
          `Supported fixers: ${plugin.supportedFixers.join(', ')}`,
        );
      }
    }
  }

  return errors;
}

export async function loadConfig(
  configPath: string,
  cwd: string = process.cwd(),
  registry?: EcosystemRegistry,
): Promise<ProjectConfig> {
  const absolutePath = resolve(cwd, configPath);

  let raw: string;
  try {
    raw = await readFile(absolutePath, 'utf-8');
  } catch (_err) {
    throw new ConfigLoadError(
      `Cannot read config file: ${absolutePath}`,
      absolutePath,
    );
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (_err) {
    throw new ConfigLoadError(
      `Invalid YAML in config file: ${absolutePath}`,
      absolutePath,
    );
  }

  const result = ProjectConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new ConfigLoadError(
      `Config validation failed in ${absolutePath}:\n${issues}`,
      absolutePath,
    );
  }

  const config = result.data;

  // Cross-validate ecosystems[] against registry if one is provided
  if (registry) {
    const crossErrors = validateEcosystemsAgainstRegistry(config, registry);
    if (crossErrors.length > 0) {
      throw new ConfigLoadError(
        `Config ecosystem cross-validation failed in ${absolutePath}:\n` +
        crossErrors.map((e) => `  ${e}`).join('\n'),
        absolutePath,
      );
    }
  }

  return config;
}
