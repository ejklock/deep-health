import type { CommandRunner } from '@core/types/common';
import type { ScanResultJson } from '@core/types/scan';
import { emptyEcosystem } from '@core/types/scan';
import { logger } from '@infra/utils/logger';

/** osv-scanner in-place fix command for npm lockfile */
const OSV_FIX_NPM = 'osv-scanner fix --strategy=in-place -L package-lock.json';

export interface OsvFixerOptions {
  runner: CommandRunner;
  cwd: string;
  scanResult: ScanResultJson;
  authorizeBreaking: boolean;
}

export interface OsvFixerResult {
  /** Breaking packages install error, if any */
  breakingInstallError: string | null;
  /** Packages that were updated by the OSV fix */
  packagesUpdated: string[];
}

/**
 * Apply OSV in-place fix to npm lockfile.
 * Handles both auto-safe (osv-scanner fix) and authorized breaking changes (targeted npm install).
 */
export async function applyOsvFix(opts: OsvFixerOptions): Promise<OsvFixerResult> {
  const { runner, cwd, scanResult, authorizeBreaking } = opts;

  logger.info(`Applying OSV in-place fix: ${OSV_FIX_NPM}`);
  const fixResult = await runner.run(OSV_FIX_NPM, { cwd, stream: true });
  if (fixResult.exitCode !== 0) {
    logger.warn(`osv-scanner fix exited with ${fixResult.exitCode}: ${fixResult.stderr}`);
  }

  const npmEcosystem = scanResult.ecosystems['npm'] ?? emptyEcosystem();
  const packagesUpdated = npmEcosystem.auto_safe_packages;

  if (!authorizeBreaking) {
    return { breakingInstallError: null, packagesUpdated };
  }

  // Install authorized breaking-change packages via targeted npm install
  const breakingPkgs = npmEcosystem.vulnerabilities
    .filter((v) => v.classification === 'breaking' && v.safeVersion)
    .reduce<Map<string, string>>((map, v) => {
      if (!map.has(v.package)) map.set(v.package, v.safeVersion!);
      return map;
    }, new Map());

  if (breakingPkgs.size === 0) {
    return { breakingInstallError: null, packagesUpdated };
  }

  const specs = [...breakingPkgs.entries()].map(([name, ver]) => `${name}@${ver}`).join(' ');
  logger.info(`Installing authorized breaking-change packages: ${specs}`);
  const installResult = await runner.run(`npm install ${specs}`, { cwd, stream: true });

  if (installResult.exitCode !== 0) {
    return {
      breakingInstallError: `npm install ${specs} failed: ${installResult.stderr}`,
      packagesUpdated,
    };
  }

  return { breakingInstallError: null, packagesUpdated };
}

export { OSV_FIX_NPM };
