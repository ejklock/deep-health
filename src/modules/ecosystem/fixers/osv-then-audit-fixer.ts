import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import semver from 'semver';
import type { CommandRunner } from '@core/types/common';
import type { ScanResultJson } from '@core/types/scan';
import { emptyEcosystem } from '@core/types/scan';
import { logger } from '@infra/utils/logger';
import { collectNpmLockfileVersions, collectRootNpmLockfileVersions } from '@orchestration/lockfile-inspect';
import { revertWithBootstrap, type BootstrapSpec } from '@modules/ecosystem/utils/updater-transaction';
import type { FixerCallOptions, FixerCallResult } from './index';

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
 * Apply npm audit fix on top of an already-applied OSV fix.
 *
 * This fixer is called after the orchestrator has already run osv-scanner fix. It:
 * 1. Snapshots the current (post-OSV) lockfile as `intermediateBackup` for partial rollback.
 * 2. Runs `npm audit fix` to pick up any vulnerabilities osv-scanner could not address
 *    (e.g. lockfileVersion: 1 projects, or packages not in the OSV database).
 * 3. Verifies which auto_safe packages were actually upgraded by comparing lockfile versions
 *    before and after the audit-fix step.
 *
 * Returns `intermediateBackup` so the updater can attempt a partial revert (back to OSV-only
 * state) before falling back to a full pre-fix revert if validation fails.
 */
export async function applyOsvThenAuditFix(opts: FixerCallOptions): Promise<FixerCallResult> {
  const { runner, cwd, scanResult } = opts;
  const npmEcosystem = scanResult.ecosystems['npm'] ?? emptyEcosystem();

  // ── Snapshot pós-OSV (estado atual quando o fixer é chamado) ────────────────
  let postOsvContent: string;

  try {
    postOsvContent = await readFile(join(cwd, 'package-lock.json'), 'utf-8');
  } catch (err) {
    logger.warn(
      `[osv-then-audit] package-lock.json not found before npm audit fix (${err}); skipping audit fix`,
    );
    return { breakingInstallError: null, packagesUpdated: [] };
  }

  const versionsPreAudit = collectNpmLockfileVersions(postOsvContent);
  if (versionsPreAudit.size === 0) {
    logger.tagged('npm', 'osv-then-audit', 'Could not parse package-lock.json before audit fix; skipping', 'warn');
    return { breakingInstallError: null, packagesUpdated: [] };
  }

  // intermediateBackup = estado pós-OSV para rollback parcial se audit-fix quebrar
  let postOsvManifest: string | undefined;
  try {
    postOsvManifest = await readFile(join(cwd, 'package.json'), 'utf-8');
    logger.tagged('npm', 'osv-then-audit', 'package.json included in intermediateBackup', 'debug');
  } catch {
      logger.tagged('npm', 'osv-then-audit', 'package.json not found before audit fix; partial revert will not restore manifest', 'warn');
  }

  const intermediateBackup = new Map<string, string>([
    ['package-lock.json', postOsvContent],
    ...(postOsvManifest ? [['package.json', postOsvManifest] as [string, string]] : []),
  ]);

  // ── npm audit fix ────────────────────────────────────────────────────────────
  logger.tagged('npm', 'osv-then-audit', 'Running npm audit fix on top of OSV changes...');
  const auditResult = await runner.runArgs('npm', ['audit', 'fix'], { cwd, stream: true });
  if (auditResult.exitCode !== 0) {
    logger.tagged('npm', 'osv-then-audit', `npm audit fix exited with ${auditResult.exitCode}; checking lockfile for partial upgrades`, 'warn');
  }

  // ── Snapshot pós-audit ───────────────────────────────────────────────────────
  let postAuditContent: string;
  try {
    postAuditContent = await readFile(join(cwd, 'package-lock.json'), 'utf-8');
  } catch (err) {
    logger.tagged('npm', 'osv-then-audit', `Could not read package-lock.json after audit fix (${err})`, 'warn');
    postAuditContent = postOsvContent;
  }

  const versionsPostAudit = collectNpmLockfileVersions(postAuditContent);
  const rootVersionsPostAudit = collectRootNpmLockfileVersions(postAuditContent);

  // ── Verificar quais pacotes o audit-fix adicionou além do OSV ───────────────
  const auditVerified: string[] = [];
  const auditFalsePositives: string[] = [];

  for (const pkgSpec of npmEcosystem.auto_safe_packages) {
    const name = pkgSpec.includes('@') && pkgSpec.lastIndexOf('@') > 0
      ? pkgSpec.slice(0, pkgSpec.lastIndexOf('@'))
      : pkgSpec;

    const before = semverMax(versionsPreAudit.get(name) ?? new Set());
    const after = semverMax(versionsPostAudit.get(name) ?? new Set());
    const rootAfter = rootVersionsPostAudit.get(name);

    if (isUpgraded(before, after)) {
      // Report root-level version to avoid false positives from transitive nested copies
      auditVerified.push(`${name}@${rootAfter ?? after!}`);
    } else {
      auditFalsePositives.push(name);
    }
  }

  logger.tagged('npm', 'osv-then-audit', `Verified ${auditVerified.length} of ${npmEcosystem.auto_safe_packages.length} audit-fix upgrade(s) on disk`);

  if (auditFalsePositives.length > 0) {
    logger.tagged('npm', 'osv-then-audit', `${auditFalsePositives.length} package(s) classified auto_safe but not upgraded by audit fix: ${auditFalsePositives.join(', ')}`, 'warn');
  }

  // Merge OSV-sourced packages with audit-verified packages.
  // Algorithm: last-writer-wins with audit overwriting OSV for the same package name.
  // OSV packages go in first; audit packages overwrite when name matches.
  // When osvFixOutcome is absent (e.g. fixer was demoted to npm-audit only), returns
  // auditVerified as-is (same behaviour as before).
  let packagesUpdated: string[];
  if (opts.osvFixOutcome) {
    const osvPackages = opts.osvFixOutcome.packagesUpdated.map((p) => `${p.name}@${p.versionTo}`);
    const merged = new Map<string, string>();
    for (const spec of [...osvPackages, ...auditVerified]) {
      const at = spec.lastIndexOf('@');
      const name = at > 0 ? spec.slice(0, at) : spec;
      merged.set(name, spec);
    }
    packagesUpdated = [...merged.values()];
  } else {
    packagesUpdated = auditVerified;
  }

  // Bootstrap spec for partial revert: restore to post-OSV state + npm ci
  const bootstrapSpec: BootstrapSpec = { binary: 'npm', args: ['ci'], label: 'npm ci' };

  // partialRevert: callable that restores to the post-OSV intermediate state and
  // re-runs npm ci. Closed over intermediateBackup and bootstrapSpec. Follows the
  // same restore → bootstrap → restore-again protocol as the full revert.
  const partialRevert = (runner: CommandRunner, cwd: string): Promise<void> =>
    revertWithBootstrap(runner, bootstrapSpec, intermediateBackup, cwd);

  return {
    breakingInstallError: null,
    packagesUpdated,
    intermediateBackup,
    partialRevert,
  };
}
