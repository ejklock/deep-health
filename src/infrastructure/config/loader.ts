import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { ProjectConfigSchema } from './schema.js';
import type { ProjectConfig } from '@core/types/config.js';
import { ConfigLoadError } from '@core/errors.js';

export const DEFAULT_CONFIG_PATH = 'project-config.yml';

export async function loadConfig(
  configPath: string,
  cwd: string = process.cwd(),
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

  return result.data;
}
