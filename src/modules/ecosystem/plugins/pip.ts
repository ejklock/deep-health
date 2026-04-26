import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { EcosystemPlugin, EcosystemUpdaterContext } from '../types';
import type { ProjectConfig, ProtectedPackage } from '@core/types/config';
import type { UpdateResultJson } from '@core/types/update';
import { runPipUpdater } from './pip-updater';
import { resolvePipDockerImage, PIP_DEFAULT_IMAGE } from '@infra/provisioner/pip-runner';

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
 * Extract a major.minor version from a raw Python version string.
 *
 * Rules:
 * - Trim whitespace; strip leading `v` (case-insensitive).
 * - Accept numeric versions like "3", "3.11", "3.11.2".
 * - Returns at most `major.minor` (e.g. "3.11.2" → "3.11", "3" → "3").
 * - Returns undefined for empty/non-numeric input.
 */
function extractPythonMajorMinor(raw: string): string | undefined {
  const stripped = raw.trim().replace(/^v/i, '');
  if (!stripped || !/^\d[\d.]*$/.test(stripped)) return undefined;
  const parts = stripped.split('.');
  // Keep at most major.minor
  const result = parts.slice(0, 2).join('.');
  return result || undefined;
}

/**
 * Parse a PEP 517 `requires-python` or `python_requires` constraint.
 *
 * Supported patterns:
 * - `>=3.10`   → "3.10"
 * - `^3.11`    → "3.11"
 * - `~=3.9.2`  → "3.9"  (major.minor only)
 * - `3.11`     → "3.11"
 *
 * Returns undefined when unparseable or too broad.
 */
function parsePythonConstraint(constraint: string): string | undefined {
  const trimmed = constraint.trim();
  if (!trimmed || trimmed === '*') return undefined;

  // Take the first "version-like" part of potentially compound constraints
  const firstPart = trimmed.split(/\s*[,|]\s*/)[0]?.trim();
  if (!firstPart) return undefined;

  // General numeric version after operator prefix
  const match = firstPart.match(/[>=^~!]*(\d[\d.]*)/);
  if (!match) return undefined;

  const version = match[1]!;
  if (!version || !/^\d[\d.]*$/.test(version)) return undefined;

  return extractPythonMajorMinor(version);
}

export const pipPlugin: EcosystemPlugin = {
  id: 'pip',
  name: 'pip',
  lockfiles: ['requirements.txt'],
  osvEcosystems: ['PyPI'],

  /** Label used in executive report evidence tables */
  reportLabel: 'Python/pip',

  runtimeContainer: 'pip-docker',

  runtimeSpec: {
    defaultImage: PIP_DEFAULT_IMAGE,
    resolveImage: resolvePipDockerImage,
    containerBinaries: ['pip', 'pip3'],
    runMode: { kind: 'shell-wrap' },
  },

  postUpdateOsvVerify: 'always',

  supportedFixers: [],

  defaultValidationCommands: [
    { name: 'check', command: 'pip check' },
  ],

  defaultAdvisors: [
    { name: 'audit', command: 'pip-audit' },
  ],

  buildScanArgs(): string[] {
    return ['--lockfile', 'requirements.txt'];
  },

  getProtectedPackages(config: ProjectConfig): ProtectedPackage[] {
    return config.protected_packages['pip'] ?? [];
  },

  async runUpdater(ctx: EcosystemUpdaterContext): Promise<UpdateResultJson> {
    return runPipUpdater(
      ctx.runner,
      ctx.config,
      ctx.scanResult,
      ctx.cwd,
      ctx.authorizeBreaking,
      ctx.validationCommands ?? [],
    );
  },

  /**
   * Infer Python version for the pip ecosystem.
   *
   * Precedence:
   * 1. `.python-version`
   * 2. `.tool-versions` (asdf/mise format: `python X.Y.Z`)
   * 3. `pyproject.toml` (requires-python field)
   * 4. `setup.cfg` (python_requires field)
   * 5. `runtime.txt` (Heroku format: `python-X.Y.Z`)
   *
   * Returns at most major.minor (e.g. "3.11.2" → "3.11").
   * Returns undefined on missing/malformed/unparseable values. Never throws.
   */
  async inferVersion(cwd: string): Promise<string | undefined> {
    // 1. .python-version
    const pythonVersion = await readTextFile(resolve(cwd, '.python-version'));
    if (pythonVersion !== undefined) {
      const version = extractPythonMajorMinor(pythonVersion);
      if (version !== undefined) return version;
    }

    // 2. .tool-versions (asdf/mise format)
    const toolVersions = await readTextFile(resolve(cwd, '.tool-versions'));
    if (toolVersions !== undefined) {
      for (const line of toolVersions.split('\n')) {
        const trimmedLine = line.trim();
        const match = trimmedLine.match(/^python\s+(\S+)/i);
        if (match) {
          const version = extractPythonMajorMinor(match[1]!);
          if (version !== undefined) return version;
        }
      }
    }

    // 3. pyproject.toml (requires-python)
    try {
      const raw = await readFile(resolve(cwd, 'pyproject.toml'), 'utf-8');
      const match = (raw as string).match(/requires-python\s*=\s*["']([^"']+)["']/);
      if (match) {
        const version = parsePythonConstraint(match[1]!);
        if (version !== undefined) return version;
      }
    } catch {
      // file missing or malformed — fall through
    }

    // 4. setup.cfg (python_requires)
    try {
      const raw = await readFile(resolve(cwd, 'setup.cfg'), 'utf-8');
      const match = (raw as string).match(/python_requires\s*=\s*(.+)/);
      if (match) {
        const version = parsePythonConstraint(match[1]!.trim());
        if (version !== undefined) return version;
      }
    } catch {
      // file missing or malformed — fall through
    }

    // 5. runtime.txt (Heroku format: "python-3.11.4")
    const runtimeTxt = await readTextFile(resolve(cwd, 'runtime.txt'));
    if (runtimeTxt !== undefined) {
      const match = runtimeTxt.match(/^python-(\d[\d.]*)/i);
      if (match) {
        const version = extractPythonMajorMinor(match[1]!);
        if (version !== undefined) return version;
      }
    }

    return undefined;
  },
};
