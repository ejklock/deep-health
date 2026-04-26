import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { EcosystemPlugin, EcosystemUpdaterContext } from '../types';
import type { ProjectConfig, ProtectedPackage } from '@core/types/config';
import type { UpdateResultJson } from '@core/types/update';
import { runComposerUpdater } from './composer-updater';
import { resolveComposerDockerImage } from '@infra/provisioner/php-image-resolver';
import { COMPOSER_BOOTSTRAP, isPhpCliImage } from '@infra/provisioner/composer-runner';
import { COMPOSER_DEFAULT_IMAGE } from '@infra/provisioner/php-profiles';

// ─── Version inference helpers ────────────────────────────────────────────────

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
 * Parse a `composer.json#require.php` constraint into a best-effort version string.
 *
 * Supported patterns:
 * - `>=8.2`   → "8.2"
 * - `^8.2`    → "8.2"
 * - `~8.2.0`  → "8.2.0"
 * - `8.2.*`   → "8.2"
 * - `8.2`     → "8.2"
 *
 * Returns undefined when the constraint is too broad or unparseable.
 */
function parseComposerPhpConstraint(constraint: string): string | undefined {
  const trimmed = constraint.trim();
  if (!trimmed || trimmed === '*') return undefined;

  // Take the first "version-like" part of potentially compound constraints
  const firstPart = trimmed.split(/\s*[|,&]\s*/)[0]?.trim();
  if (!firstPart) return undefined;

  // Handle wildcard suffix: "8.2.*" → "8.2"
  const wildcardMatch = firstPart.match(/[>=^~]*(\d[\d.]*)\.\*/);
  if (wildcardMatch) {
    return wildcardMatch[1] ?? undefined;
  }

  // General numeric version after operator prefix
  const match = firstPart.match(/[>=^~]*(\d[\d.]*)/);
  if (!match) return undefined;

  const version = match[1]!;
  if (!version || !/^\d[\d.]*$/.test(version)) return undefined;

  return version;
}

export const composerPlugin: EcosystemPlugin = {
  id: 'composer',
  name: 'Composer',
  lockfiles: ['composer.json', 'composer.lock'],
  // OSV returns 'packagist' for PHP packages; include 'composer' as fallback
  osvEcosystems: ['packagist', 'composer'],

  /** Label used in executive report evidence tables */
  reportLabel: 'PHP/Composer',

  /** Composer does not support osv-scanner fix; osv fixer used as best-effort only */
  supportedFixers: [],

  postUpdateOsvVerify: 'always',

  /** Declarative tag: composer commands run in a PHP Docker container */
  runtimeContainer: 'composer-docker' as const,

  runtimeSpec: {
    defaultImage: COMPOSER_DEFAULT_IMAGE,
    resolveImage: resolveComposerDockerImage,
    containerBinaries: ['composer', 'php'],
    runMode: {
      kind: 'shell-wrap',
      preamble: (image) => (isPhpCliImage(image) ? COMPOSER_BOOTSTRAP : undefined),
    },
  },

  defaultValidationCommands: [
    { name: 'tests', command: 'php artisan test --compact' },
  ],

  defaultAdvisors: [
    { name: 'audit', command: 'composer audit' },
  ],

  buildScanArgs(): string[] {
    return ['--lockfile', 'composer.lock'];
  },

  getProtectedPackages(config: ProjectConfig): ProtectedPackage[] {
    return config.protected_packages['composer'] ?? [];
  },

  async runUpdater(ctx: EcosystemUpdaterContext): Promise<UpdateResultJson> {
    return runComposerUpdater(
      ctx.runner,
      ctx.config,
      ctx.scanResult,
      ctx.cwd,
      ctx.authorizeBreaking,
      ctx.validationCommands ?? [],
    );
  },

  /**
   * Infer PHP version for the composer ecosystem.
   *
   * Precedence:
   * 1. `.php-version`
   * 2. `composer.json#require.php`
   *
   * Returns undefined on missing/malformed/unparseable values. Never throws.
   */
  async inferVersion(cwd: string): Promise<string | undefined> {
    // 1. .php-version
    const phpVersionFile = await readTextFile(resolve(cwd, '.php-version'));
    if (phpVersionFile !== undefined) {
      const stripped = phpVersionFile.replace(/^v/i, '').trim();
      if (stripped && /^\d[\d.]*$/.test(stripped)) {
        return stripped;
      }
    }

    // 2. composer.json#require.php
    try {
      const raw = await readFile(resolve(cwd, 'composer.json'), 'utf-8');
      const composer: unknown = JSON.parse(raw as string);
      if (
        composer !== null &&
        typeof composer === 'object' &&
        'require' in (composer as Record<string, unknown>)
      ) {
        const req = (composer as Record<string, unknown>)['require'];
        if (typeof req === 'object' && req !== null && 'php' in req) {
          const phpConstraint = (req as Record<string, unknown>)['php'];
          if (typeof phpConstraint === 'string') {
            return parseComposerPhpConstraint(phpConstraint);
          }
        }
      }
    } catch {
      // file missing or malformed — fall through
    }

    return undefined;
  },
};
