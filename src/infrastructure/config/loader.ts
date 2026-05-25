import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import type { ZodIssue } from 'zod';
import { ProjectConfigSchema } from './schema';
import type { ProjectConfig } from '@core/types/config';
import { ConfigLoadError } from '@core/errors';
import type { EcosystemRegistry } from '@modules/ecosystem/registry';
import { CLI_NAME } from '@infra/brand';
import { type Result, ok, err } from '@core/types/result';

export const DEFAULT_CONFIG_PATH = 'project-config.yml';

/**
 * Detects legacy ecosystem runner config placements and throws clear, actionable
 * migration errors before Zod parsing.
 *
 * Migration history:
 * - Phase 1: `scanners.npm/pip/composer` → `runners.npm/pip/composer` (top-level block)
 * - Phase 2: `runners.npm/pip/composer` → `ecosystems[].runner` (per-ecosystem inline)
 *
 * The `mode` field inside ecosystem runner configs is also rejected — Docker is
 * now the only runtime mode (see ADR-0001).
 */
function rejectLegacyModeField(raw: unknown): void {
  if (typeof raw !== 'object' || raw === null) return;
  const obj = raw as Record<string, unknown>;

  // ── Migration check: scanners.npm/pip/composer → ecosystems[].runner ──
  const scanners = obj.scanners;
  if (typeof scanners === 'object' && scanners !== null) {
    const scannersObj = scanners as Record<string, unknown>;
    for (const ecosystem of ['npm', 'pip', 'composer']) {
      if (ecosystem in scannersObj) {
        throw new Error(
          `Config field 'scanners.${ecosystem}' is no longer supported. ` +
          `Move ecosystem runner config to the 'runner' field inside the matching ecosystems[] entry. ` +
          `See docs/adr/0004-ecosystem-runner-config-and-build-context-hardening.md for the rationale.`,
        );
      }
    }
  }

  // ── Migration check: top-level runners block → ecosystems[].runner ──
  const runners = obj.runners;
  if (typeof runners === 'object' && runners !== null) {
    throw new Error(
      `The top-level 'runners' block is no longer supported. ` +
      `Move each runner config (npm, pip, composer) to the 'runner' field inside the ` +
      `matching ecosystems[] entry. ` +
      `Example: ecosystems: [{ id: 'npm', runner: { language_version: '20' } }].`,
    );
  }

  // ── Legacy mode field check in ecosystems[].runner ──
  const ecosystems = obj.ecosystems;
  if (Array.isArray(ecosystems)) {
    for (const entry of ecosystems) {
      if (typeof entry === 'object' && entry !== null) {
        const ecoEntry = entry as Record<string, unknown>;
        const runner = ecoEntry.runner;
        if (typeof runner === 'object' && runner !== null && 'mode' in runner) {
          const value = (runner as { mode: unknown }).mode;
          const id = typeof ecoEntry.id === 'string' ? ecoEntry.id : '?';
          throw new Error(
            `Config field 'ecosystems[${id}].runner.mode' (value: '${String(value)}') is no longer supported. ` +
            `Docker is now the only runtime mode. ` +
            `Remove the 'mode' field from your config. ` +
            `See docs/adr/0001-docker-only-runtime.md for the rationale.`,
          );
        }
      }
    }
  }
}

/**
 * Formats a Zod path array into a human-readable dot+bracket string.
 * Array indices are rendered as `[N]`; object keys are separated by `.`.
 *
 * Examples:
 *   [] → '(root)'
 *   ['project', 'name'] → 'project.name'
 *   ['ecosystems', 0, 'id'] → 'ecosystems[0].id'
 */
export function formatZodPath(path: (string | number)[]): string {
  if (path.length === 0) return '(root)';
  let result = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      result += `[${segment}]`;
    } else {
      result += result.length > 0 ? `.${segment}` : segment;
    }
  }
  return result;
}

/**
 * Formats a single Zod issue into a human-readable line with actionable detail.
 *
 * - `unrecognized_keys`: shows the rejected key(s)
 * - `invalid_enum_value`: shows expected values
 * - all: shows path + message
 */
export function formatZodIssue(issue: ZodIssue): string {
  const path = formatZodPath(issue.path);
  const prefix = `  ${path}: `;

  if (issue.code === 'unrecognized_keys') {
    const keys = issue.keys.map((k) => `"${k}"`).join(', ');
    return `${prefix}Unknown key(s) ${keys} — remove or correct the field name`;
  }

  if (issue.code === 'invalid_enum_value') {
    const expected = issue.options.map((o) => `"${String(o)}"`).join(', ');
    return `${prefix}${issue.message} — expected one of: ${expected}`;
  }

  return `${prefix}${issue.message}`;
}

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
): Promise<Result<ProjectConfig, ConfigLoadError>> {
  const absolutePath = resolve(cwd, configPath);

  let raw: string;
  try {
    raw = await readFile(absolutePath, 'utf-8');
  } catch (_err) {
    return err(new ConfigLoadError(
      `Cannot read config file: ${absolutePath}\n` +
      `  Hint: Run "${CLI_NAME} init" to generate a starter config, ` +
      `or check the --config / --cwd flags.`,
      absolutePath,
    ));
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (_err) {
    return err(new ConfigLoadError(
      `Invalid YAML in config file: ${absolutePath}\n` +
      `  Hint: Validate your YAML syntax at https://yaml.org/spec/ or use a linter.`,
      absolutePath,
    ));
  }

  try {
    rejectLegacyModeField(parsed);
  } catch (e) {
    return err(new ConfigLoadError(
      `${(e as Error).message}`,
      absolutePath,
    ));
  }

  const zodResult = ProjectConfigSchema.safeParse(parsed);
  if (!zodResult.success) {
    const issues = zodResult.error.issues.map(formatZodIssue).join('\n');
    return err(new ConfigLoadError(
      `Config validation failed in ${absolutePath}:\n${issues}`,
      absolutePath,
    ));
  }

  const config = zodResult.data;

  // Cross-validate ecosystems[] against registry if one is provided
  if (registry) {
    const crossErrors = validateEcosystemsAgainstRegistry(config, registry);
    if (crossErrors.length > 0) {
      return err(new ConfigLoadError(
        `Config ecosystem cross-validation failed in ${absolutePath}:\n` +
        crossErrors.map((e) => `  ${e}`).join('\n'),
        absolutePath,
      ));
    }
  }

  return ok(config);
}
