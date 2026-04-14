import type { CommandRunner } from '@core/types/common';
import type { ScanResultJson } from '@core/types/scan';
import { emptyEcosystem } from '@core/types/scan';
import { logger } from '@infra/utils/logger';

export interface NpmAuditFixerOptions {
  runner: CommandRunner;
  cwd: string;
  scanResult: ScanResultJson;
  authorizeBreaking: boolean;
}

export interface NpmAuditFixerResult {
  /** Breaking packages install error, if any */
  breakingInstallError: string | null;
  /** Packages that were updated */
  packagesUpdated: string[];
}

/**
 * Apply npm audit fix to address vulnerabilities.
 * Uses `npm audit fix` for auto-safe packages and targeted npm install for authorized breaking changes.
 */
export async function applyNpmAuditFix(opts: NpmAuditFixerOptions): Promise<NpmAuditFixerResult> {
  const { runner, cwd, scanResult, authorizeBreaking } = opts;

  const npmEcosystem = scanResult.ecosystems['npm'] ?? emptyEcosystem();
  const packagesUpdated = npmEcosystem.auto_safe_packages;

  logger.info('Applying npm audit fix for auto-safe vulnerabilities...');
  const fixResult = await runner.run('npm audit fix', { cwd, stream: true });
  if (fixResult.exitCode !== 0) {
    logger.warn(`npm audit fix exited with ${fixResult.exitCode}: ${fixResult.stderr}`);
  }

  if (!authorizeBreaking) {
    return { breakingInstallError: null, packagesUpdated };
  }

  // Install authorized breaking-change packages via targeted npm install --force
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
