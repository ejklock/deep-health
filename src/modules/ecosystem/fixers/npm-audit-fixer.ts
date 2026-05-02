import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import semver from 'semver';
import type { CommandRunner } from '@core/types/common';
import type { ScanResultJson } from '@core/types/scan';
import { emptyEcosystem } from '@core/types/scan';
import { logger } from '@infra/utils/logger';
import { collectNpmLockfileVersions, collectRootNpmLockfileVersions } from '@modules/ecosystem/utils/lockfile-inspect';

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
 * Return the semver-maximum version string from a set, or undefined if the set is empty
 * or contains no valid semver versions. Falls back to an arbitrary element for non-semver
 * sets (rare; non-semver packages are handled by exact-match verification elsewhere).
 */
function semverMax(versions: Set<string>): string | undefined {
  if (versions.size === 0) return undefined;
  let best: string | undefined;
  for (const v of versions) {
    if (!best) { best = v; continue; }
    const vValid = semver.valid(v);
    const bestValid = semver.valid(best);
    if (vValid && bestValid) {
      if (semver.gt(vValid, bestValid)) best = v;
    } else if (vValid && !bestValid) {
      best = v;
    }
  }
  return best;
}

/**
 * Return true iff `versionAfter` is strictly newer than `versionBefore` by semver,
 * or `packageName` appeared post-fix but not pre-fix (net-new install counts as update).
 *
 * For non-semver strings we require `versionAfter !== versionBefore && versionBefore !== undefined`.
 */
function isUpgraded(
  versionBefore: string | undefined,
  versionAfter: string | undefined,
): boolean {
  if (!versionAfter) return false;
  // Package appeared post-fix but was absent pre-fix: counts as an upgrade.
  if (!versionBefore) return true;
  if (versionBefore === versionAfter) return false;

  const afterValid = semver.valid(versionAfter);
  const beforeValid = semver.valid(versionBefore);
  if (afterValid && beforeValid) {
    return semver.gt(afterValid, beforeValid);
  }
  // Non-semver: any string change is conservatively rejected (we cannot order them).
  return false;
}

/**
 * Apply npm audit fix to address vulnerabilities.
 *
 * Uses `npm audit fix` for auto-safe packages and targeted npm install for authorized breaking
 * changes. Both phases verify the resulting package-lock.json on disk before claiming any
 * package was updated — preventing false-positive entries in the executive report when
 * `npm audit fix` applies partial patches, hits peer-dep constraints, or exits non-zero.
 */
export async function applyNpmAuditFix(opts: NpmAuditFixerOptions): Promise<NpmAuditFixerResult> {
  const { runner, cwd, scanResult, authorizeBreaking } = opts;

  const npmEcosystem = scanResult.ecosystems['npm'] ?? emptyEcosystem();

  // ── Pre-fix lockfile snapshot ─────────────────────────────────────────────
  let preLockfileContent: string;
  try {
    preLockfileContent = await readFile(join(cwd, 'package-lock.json'), 'utf-8');
  } catch (err) {
    logger.warn(
      `[npm-audit fix] package-lock.json not found or unreadable before fix (${err}); skipping npm audit fix`,
    );
    return { breakingInstallError: null, packagesUpdated: [] };
  }

  const rootVersionsBefore = collectRootNpmLockfileVersions(preLockfileContent);
  if (rootVersionsBefore.size === 0) {
    logger.warn(
      '[npm-audit fix] Could not parse package-lock.json before fix; skipping npm audit fix',
    );
    return { breakingInstallError: null, packagesUpdated: [] };
  }

  // ── Run npm audit fix ─────────────────────────────────────────────────────
  logger.info('Applying npm audit fix for auto-safe vulnerabilities...');
  // SEC: use runArgs (shell: false) — 'npm audit fix' has no variable data but
  // runArgs is used for consistency with all other npm invocations in this module.
  const fixResult = await runner.runArgs('npm', ['audit', 'fix'], { cwd, stream: true });
  if (fixResult.exitCode !== 0) {
    // npm audit fix applies partial patches before failing in many cases — do not abort.
    logger.warn(
      `[npm-audit fix] npm audit fix exited with ${fixResult.exitCode}; checking lockfile for partial upgrades`,
    );
  }

  // ── Post-fix lockfile snapshot ────────────────────────────────────────────
  let postAutoSafeLockfile: string;
  try {
    postAutoSafeLockfile = await readFile(join(cwd, 'package-lock.json'), 'utf-8');
  } catch (err) {
    logger.tagged('npm', 'npm-audit fix', `Could not read package-lock.json after npm audit fix (${err})`, 'warn');
    postAutoSafeLockfile = preLockfileContent;
  }

  const rootVersionsAfterAutoSafe = collectRootNpmLockfileVersions(postAutoSafeLockfile);

  // ── Verify auto-safe upgrades ─────────────────────────────────────────────
  // auto_safe_packages is a string[] of "name@version" or bare "name" strings from the scanner.
  // We only care about the package name for verification — the lockfile is the authority on which
  // version actually landed.
  const autoSafeVerified: string[] = [];
  const autoSafeFalsePositives: string[] = [];

  for (const pkgSpec of npmEcosystem.auto_safe_packages) {
    const name = pkgSpec.includes('@') && pkgSpec.lastIndexOf('@') > 0
      ? pkgSpec.slice(0, pkgSpec.lastIndexOf('@'))
      : pkgSpec;

    const before = rootVersionsBefore.get(name);
    const after = rootVersionsAfterAutoSafe.get(name);

    if (isUpgraded(before, after)) {
      autoSafeVerified.push(`${name}@${after!}`);
    } else {
      autoSafeFalsePositives.push(name);
    }
  }

  logger.tagged('npm', 'npm-audit fix', `Verified ${autoSafeVerified.length} of ${npmEcosystem.auto_safe_packages.length} auto-safe upgrade(s) on host disk`);

  if (autoSafeFalsePositives.length > 0) {
    logger.tagged('npm', 'npm-audit fix', `Scanner classified ${autoSafeFalsePositives.length} package(s) as auto_safe but post-fix lockfile has no newer version: ${autoSafeFalsePositives.join(', ')}`, 'warn');
  }

  const packagesUpdated = [...autoSafeVerified];

  if (!authorizeBreaking) {
    return { breakingInstallError: null, packagesUpdated };
  }

  // ── Breaking install (authorized) ────────────────────────────────────────
  const skippedProtected = npmEcosystem.vulnerabilities
    .filter((v) => v.classification === 'breaking' && v.breakingReason === 'protected-constraint');
  if (skippedProtected.length > 0) {
    logger.tagged('npm', 'npm-audit fix', `Skipping ${skippedProtected.length} protected-constraint package(s) — cannot be installed automatically: ` +
      skippedProtected.map((v) => v.package).join(', '), 'warn');
  }
  const breakingPkgs = npmEcosystem.vulnerabilities
    .filter((v) => v.classification === 'breaking' && v.safeVersion && v.breakingReason !== 'protected-constraint')
    .reduce<Map<string, string>>((map, v) => {
      if (!map.has(v.package)) map.set(v.package, v.safeVersion!);
      return map;
    }, new Map());

  if (breakingPkgs.size === 0) {
    return { breakingInstallError: null, packagesUpdated };
  }

  const specs = [...breakingPkgs.entries()].map(([name, ver]) => `${name}@${ver}`);
  const specsStr = specs.join(' ');
  logger.info(`Installing authorized breaking-change packages: ${specsStr}`);
  // SEC: use runArgs (shell: false) — package-name@version data must not reach a shell tokenizer
  const installResult = await runner.runArgs('npm', ['install', ...specs], { cwd, stream: true });

  // Read lockfile after breaking install regardless of exit code — partial patches may apply.
  let postBreakingLockfile: string;
  try {
    postBreakingLockfile = await readFile(join(cwd, 'package-lock.json'), 'utf-8');
  } catch (err) {
    logger.tagged('npm', 'npm-audit fix', `Could not read package-lock.json after breaking install (${err})`, 'warn');
    postBreakingLockfile = postAutoSafeLockfile;
  }

  const versionsAfterBreaking = collectNpmLockfileVersions(postBreakingLockfile);

  const breakingVerified: string[] = [];
  const breakingUnverified: string[] = [];

  for (const [name, targetVersion] of breakingPkgs) {
    const diskVersions = versionsAfterBreaking.get(name);
    const diskMax = semverMax(diskVersions ?? new Set());

    const targetValid = semver.valid(targetVersion);
    const diskValid = diskMax ? semver.valid(diskMax) : null;

    let verified = false;
    if (diskVersions && diskVersions.has(targetVersion)) {
      // Exact match
      verified = true;
    } else if (targetValid && diskValid && semver.gte(diskValid, targetValid)) {
      // Disk has a version >= target (semver-aware)
      verified = true;
    }

    if (verified) {
      breakingVerified.push(`${name}@${diskMax ?? targetVersion}`);
    } else {
      breakingUnverified.push(`${name}@${targetVersion}`);
    }
  }

  if (breakingUnverified.length > 0) {
    logger.tagged('npm', 'npm-audit fix', `${breakingVerified.length} of ${breakingPkgs.size} authorized breaking upgrade(s) verified on disk; unverified: ${breakingUnverified.join(', ')}`, 'warn');
  }

  packagesUpdated.push(...breakingVerified);

  if (installResult.exitCode !== 0 && breakingVerified.length === 0) {
    return {
      breakingInstallError: `npm install ${specsStr} failed: ${installResult.stderr}`,
      packagesUpdated,
    };
  }

  return { breakingInstallError: null, packagesUpdated };
}
