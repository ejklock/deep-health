import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { EcosystemPlugin, EcosystemUpdaterContext } from '../types';
import type { ProjectConfig, ProtectedPackage } from '@core/types/config';
import type { CommandRunner } from '@core/types/common';
import type { ScanResultJson } from '@core/types/scan';
import type { UpdateResultJson } from '@core/types/update';
import { emptyEcosystem } from '@core/types/scan';
import { logger } from '@infra/utils/logger';
import { runNpmUpdater } from './npm-updater';

// ─── Version inference helpers ────────────────────────────────────────────────

/**
 * Sanitize a raw version string read from `.nvmrc` or `.node-version`.
 *
 * Rules:
 * - Trim whitespace; strip leading `v` (case-insensitive).
 * - Reject LTS aliases (`lts/*`, `lts/hydrogen`, `node`, `stable`, `latest`, `*`).
 * - Accept only bare numeric versions like "20", "20.11", "20.11.1".
 * - Returns undefined when the value is not a concrete version.
 */
function sanitizeNodeVersionFile(raw: string): string | undefined {
  const value = raw.trim().toLowerCase();

  if (
    !value ||
    value === '*' ||
    value === 'node' ||
    value === 'stable' ||
    value === 'latest' ||
    value.startsWith('lts/')
  ) {
    return undefined;
  }

  // Strip leading "v"
  const stripped = value.startsWith('v') ? value.slice(1) : value;

  // Must look like a numeric version (e.g. "20", "20.11", "20.11.1")
  if (!/^\d[\d.]*$/.test(stripped)) return undefined;

  return stripped;
}

/** Read a UTF-8 text file and return its trimmed contents, or undefined on any error. */
async function readTextFile(filePath: string): Promise<string | undefined> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return (content as string).trim();
  } catch {
    return undefined;
  }
}

/**
 * Parse a `package.json#engines.node` range into a best-effort version string.
 *
 * Supported patterns (non-exhaustive):
 * - `>=20.0.0` → "20.0.0"
 * - `>=20`     → "20"
 * - `^20`      → "20"
 * - `~20.11`   → "20.11"
 * - `20.x`     → "20"
 * - `20`       → "20"
 * - `*`        → undefined (too broad)
 *
 * Returns undefined when the range is too broad, empty, or unparseable.
 */
function parseEnginesNodeRange(range: string): string | undefined {
  const trimmed = range.trim();
  if (!trimmed || trimmed === '*') return undefined;

  // Extract the first numeric version segment from the range
  const match = trimmed.match(/[>=^~]*(\d[\d.x]*)/);
  if (!match) return undefined;

  // Normalise: drop trailing `.x` suffix → "20.x" becomes "20"
  const version = match[1]!.replace(/\.x$/i, '');
  if (!version || version === '*') return undefined;

  // Must look like a numeric version after normalisation
  if (!/^\d[\d.]*$/.test(version)) return undefined;

  return version;
}

export const npmPlugin: EcosystemPlugin = {
  id: 'npm',
  name: 'npm',
  lockfiles: ['package.json', 'package-lock.json'],
  osvEcosystems: ['npm'],

  /** Label used in executive report evidence tables */
  reportLabel: 'npm',

  runtimeContainer: 'npm-docker',

  osvFixSpec: {
    fixLockfile: 'package-lock.json',
    backupFiles: ['package.json', 'package-lock.json'],
  },

  postUpdateOsvVerify: 'osv-strategy-only',

  supportedFixers: ['osv', 'npm-audit'],

  defaultValidationCommands: [
    { name: 'build', command: 'npm run build' },
  ],

  defaultAdvisors: [
    { name: 'audit', command: 'npm audit --json', format: 'json' as const },
  ],

  buildScanArgs(): string[] {
    return ['--lockfile', 'package-lock.json'];
  },

  getProtectedPackages(config: ProjectConfig): ProtectedPackage[] {
    return config.protected_packages['npm'] ?? [];
  },

  async runUpdater(ctx: EcosystemUpdaterContext): Promise<UpdateResultJson> {
    return runNpmUpdater(
      ctx.runner,
      ctx.config,
      ctx.scanResult,
      ctx.cwd,
      ctx.authorizeBreaking,
      ctx.validationCommands ?? [],
      ctx.fixerStrategy ?? 'osv',
      ctx.preFixBackups,
    );
  },

  async installBreakingPackages(args: {
    runner: CommandRunner;
    cwd: string;
    scanResult: ScanResultJson;
    dryRun: boolean;
    fixerStrategy: string;
  }): Promise<{ status: 'success' | 'error'; error?: string } | null> {
    // Only applies for osv strategy
    if (args.fixerStrategy !== 'osv') return null;

    const ecosystemResult = args.scanResult.ecosystems['npm'] ?? emptyEcosystem();
    const breakingPkgs = ecosystemResult.vulnerabilities
      .filter((v) => v.classification === 'breaking' && v.safeVersion)
      .reduce<Map<string, string>>((map, v) => {
        if (!map.has(v.package)) map.set(v.package, v.safeVersion!);
        return map;
      }, new Map());

    if (breakingPkgs.size === 0) return { status: 'success' };

    const specs = [...breakingPkgs.entries()].map(([name, ver]) => `${name}@${ver}`).join(' ');
    logger.info(`[OSV strategy] Installing authorized breaking-change packages via npm: ${specs}`);

    if (args.dryRun) {
      logger.info(`[DRY-RUN] Would execute: npm install ${specs}`);
      return { status: 'success' };
    }

    const installResult = await args.runner.run(`npm install ${specs}`, { cwd: args.cwd, stream: true });
    if (installResult.exitCode !== 0) {
      logger.error(
        `[OSV strategy] npm install for breaking packages failed (exit ${installResult.exitCode}): ${installResult.stderr}`,
      );
      return { status: 'error', error: `npm install ${specs} failed: ${installResult.stderr}` };
    }

    return { status: 'success' };
  },

  /**
   * Infer Node.js version for the npm ecosystem.
   *
   * Precedence:
   * 1. `.nvmrc`
   * 2. `.node-version`
   * 3. `package.json#engines.node`
   *
   * Returns undefined on missing/malformed/unparseable values. Never throws.
   */
  async inferVersion(cwd: string): Promise<string | undefined> {
    // 1. .nvmrc
    const nvmrc = await readTextFile(resolve(cwd, '.nvmrc'));
    if (nvmrc !== undefined) {
      const version = sanitizeNodeVersionFile(nvmrc);
      if (version !== undefined) return version;
    }

    // 2. .node-version
    const nodeVersion = await readTextFile(resolve(cwd, '.node-version'));
    if (nodeVersion !== undefined) {
      const version = sanitizeNodeVersionFile(nodeVersion);
      if (version !== undefined) return version;
    }

    // 3. package.json#engines.node
    try {
      const raw = await readFile(resolve(cwd, 'package.json'), 'utf-8');
      const pkg: unknown = JSON.parse(raw as string);
      if (
        pkg !== null &&
        typeof pkg === 'object' &&
        'engines' in pkg &&
        typeof (pkg as Record<string, unknown>)['engines'] === 'object'
      ) {
        const engines = (pkg as Record<string, unknown>)['engines'] as Record<string, unknown>;
        if (typeof engines['node'] === 'string') {
          return parseEnginesNodeRange(engines['node']);
        }
      }
    } catch {
      // file missing or malformed — fall through
    }

    return undefined;
  },
};
