import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import semver from 'semver';
import type { ScanResultJson } from '@core/types/scan';
import { emptyEcosystem } from '@core/types/scan';
import { logger } from '@infra/utils/logger';
import { collectNpmLockfileVersions } from '@orchestration/lockfile-inspect';
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
    logger.warn('[osv-then-audit] Could not parse package-lock.json before audit fix; skipping');
    return { breakingInstallError: null, packagesUpdated: [] };
  }

  // intermediateBackup = estado pós-OSV para rollback parcial se audit-fix quebrar
  const intermediateBackup = new Map([['package-lock.json', postOsvContent]]);

  // ── npm audit fix ────────────────────────────────────────────────────────────
  logger.info('[osv-then-audit] Running npm audit fix on top of OSV changes...');
  const auditResult = await runner.run('npm audit fix', { cwd, stream: true });
  if (auditResult.exitCode !== 0) {
    logger.warn(
      `[osv-then-audit] npm audit fix exited with ${auditResult.exitCode}; checking lockfile for partial upgrades`,
    );
  }

  // ── Snapshot pós-audit ───────────────────────────────────────────────────────
  let postAuditContent: string;
  try {
    postAuditContent = await readFile(join(cwd, 'package-lock.json'), 'utf-8');
  } catch (err) {
    logger.warn(`[osv-then-audit] Could not read package-lock.json after audit fix (${err})`);
    postAuditContent = postOsvContent;
  }

  const versionsPostAudit = collectNpmLockfileVersions(postAuditContent);

  // ── Verificar quais pacotes o audit-fix adicionou além do OSV ───────────────
  const auditVerified: string[] = [];
  const auditFalsePositives: string[] = [];

  for (const pkgSpec of npmEcosystem.auto_safe_packages) {
    const name = pkgSpec.includes('@') && pkgSpec.lastIndexOf('@') > 0
      ? pkgSpec.slice(0, pkgSpec.lastIndexOf('@'))
      : pkgSpec;

    const before = semverMax(versionsPreAudit.get(name) ?? new Set());
    const after = semverMax(versionsPostAudit.get(name) ?? new Set());

    if (isUpgraded(before, after)) {
      auditVerified.push(`${name}@${after!}`);
    } else {
      auditFalsePositives.push(name);
    }
  }

  logger.info(
    `[osv-then-audit] Verified ${auditVerified.length} of ${npmEcosystem.auto_safe_packages.length} audit-fix upgrade(s) on disk`,
  );

  if (auditFalsePositives.length > 0) {
    logger.warn(
      `[osv-then-audit] ${auditFalsePositives.length} package(s) classified auto_safe but not upgraded by audit fix: ${auditFalsePositives.join(', ')}`,
    );
  }

  return {
    breakingInstallError: null,
    packagesUpdated: auditVerified,
    intermediateBackup,
  };
}
