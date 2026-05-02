import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import os from 'node:os';
import semver from 'semver';
import { OsvDockerRunner } from '@infra/provisioner/osv-runner';
import { backupFiles } from '@infra/utils/fs-backup';
import { logger } from '@infra/utils/logger';
import { collectNpmLockfileVersions, collectRootNpmLockfileVersions } from '@modules/ecosystem/utils/lockfile-inspect';

export interface OsvFixApplyInput {
  cwd: string;
  osvConfig?: { image?: string; platform?: string };
  osvFixSpec: {
    fixLockfile: string;            // e.g. 'package-lock.json'
    backupFiles: readonly string[]; // files to stage
  };
  /**
   * When `scan.paths` is configured, the caller may supply an explicit lockfile
   * path (relative to /project) that overrides `osvFixSpec.fixLockfile`.
   * For example: 'app/package-lock.json' instead of 'package-lock.json'.
   * When absent, `osvFixSpec.fixLockfile` is used (default behaviour).
   */
  fixLockfileOverride?: string;
  dryRun: boolean;
}

export interface OsvFixApplyResult {
  /** true iff we wrote a new lockfile to the host (verified upgrades present). */
  applied: boolean;
  /**
   * Packages whose `versionTo` was verified to be present in the host lockfile
   * after the fix was written. Never contains unverifiable claims from osv-scanner.
   */
  packagesUpdated: Array<{ name: string; versionFrom: string; versionTo: string }>;
  /** Pre-fix snapshot of all osvFixSpec.backupFiles, for downstream rollback */
  backups: Map<string, string>;
  rawFixStdout: string;
  rawFixStderr: string;
}

type PackageUpdate = OsvFixApplyResult['packagesUpdated'][number];

/**
 * Parse the JSON output from `osv-scanner fix --format=json`.
 *
 * Accesses top-level patches[].packageUpdates[] and returns a deduplicated
 * (by name, last-wins) list of { name, versionFrom, versionTo }.
 */
function parseOsvFixJson(stdout: string): PackageUpdate[] {
  try {
    const parsed: unknown = JSON.parse(stdout);

    if (!parsed || typeof parsed !== 'object') return [];

    const asObj = parsed as Record<string, unknown>;
    const patches = asObj['patches'];
    if (!Array.isArray(patches)) return [];

    const dedupe = new Map<string, PackageUpdate>();

    for (const patch of patches) {
      if (!patch || typeof patch !== 'object') continue;
      const packageUpdates = (patch as Record<string, unknown>)['packageUpdates'];
      if (!Array.isArray(packageUpdates)) continue;

      for (const update of packageUpdates) {
        if (!update || typeof update !== 'object') continue;
        const u = update as Record<string, unknown>;
        const name = String(u['name'] ?? '');
        const versionFrom = String(u['versionFrom'] ?? '');
        const versionTo = String(u['versionTo'] ?? '');
        if (!name) continue;
        dedupe.set(name, { name, versionFrom, versionTo });
      }
    }

    return Array.from(dedupe.values());
  } catch (err) {
    logger.tagged('osv', 'OSV fix', `Could not parse osv-scanner fix JSON output: ${err}`, 'warn');
    return [];
  }
}

/**
 * Return true iff `versionTo` (or something strictly newer by semver) appears
 * among the versions we found in the lockfile for that package name. Non-semver
 * strings must match exactly — we refuse to speculate.
 */
function claimIsSatisfiedOnDisk(
  claim: PackageUpdate,
  versionsOnDisk: Set<string> | undefined,
): boolean {
  if (!versionsOnDisk || versionsOnDisk.size === 0) return false;
  if (versionsOnDisk.has(claim.versionTo)) return true;

  const claimedValid = semver.valid(claim.versionTo);
  if (!claimedValid) return false;

  for (const onDisk of versionsOnDisk) {
    const onDiskValid = semver.valid(onDisk);
    if (onDiskValid && semver.gte(onDiskValid, claimedValid)) return true;
  }
  return false;
}

/**
 * Apply `osv-scanner fix` using a staging temp directory approach.
 *
 * Instead of bind-mounting the real project directory (unreliable on macOS /Volumes),
 * we copy the relevant files into a temp dir, run osv-scanner fix there, then write
 * the result back to the host via Node.js fs.writeFile.
 *
 * `packagesUpdated` is an intersection of (a) osv-scanner's JSON patch list and
 * (b) what the staging lockfile actually contains. Osv-scanner has been observed
 * to emit patches in its JSON output that never reach the lockfile on disk — most
 * commonly on `lockfileVersion: 1` (npm 6) projects. The verification step below
 * protects reporting from those false claims.
 */
export async function applyOsvFixViaStaging(
  input: OsvFixApplyInput,
): Promise<OsvFixApplyResult> {
  const { cwd, osvConfig, osvFixSpec, fixLockfileOverride, dryRun } = input;

  // When scan.paths is configured the caller may supply a path-qualified lockfile
  // (e.g. 'app/package-lock.json').  Fall back to plugin default when absent.
  const effectiveFixLockfile = fixLockfileOverride ?? osvFixSpec.fixLockfile;

  if (fixLockfileOverride && fixLockfileOverride !== osvFixSpec.fixLockfile) {
    logger.debug(
      `[OSV fix] scan.paths override: using lockfile "${effectiveFixLockfile}" instead of "${osvFixSpec.fixLockfile}"`,
    );
  }

  if (dryRun) {
    logger.tagged('osv', 'DRY-RUN', 'Would run osv-scanner fix in staging temp dir');
    return {
      applied: false,
      packagesUpdated: [],
      backups: new Map(),
      rawFixStdout: '',
      rawFixStderr: '',
    };
  }

  // Take pre-fix backups for downstream rollback
  const backups = await backupFiles(Array.from(osvFixSpec.backupFiles), cwd);

  // Create isolated staging temp dir
  const stagingDir = await mkdtemp(join(os.tmpdir(), 'deep-health-osv-fix-'));

  try {
    // Copy files into staging dir
    for (const file of osvFixSpec.backupFiles) {
      if (backups.has(file)) {
        await writeFile(join(stagingDir, file), backups.get(file)!, 'utf-8');
      }
    }

    // Run osv-scanner fix inside staging dir container
    const runner = new OsvDockerRunner({
      projectDir: stagingDir,
      image: osvConfig?.image,
      platform: osvConfig?.platform,
      readonly: false,
    });

    const result = await runner.run([
      'fix',
      '--strategy=in-place',
      '--format=json',
      '-L',
      effectiveFixLockfile,
    ]);

    logger.tagged('osv', 'OSV fix', `osv-scanner fix exited with code ${result.exitCode}`, 'debug');

    if (result.exitCode !== 0) {
      logger.tagged('osv', 'OSV fix', 'osv-scanner fix exited with non-zero exit code (no changes applied)', 'warn');
      return {
        applied: false,
        packagesUpdated: [],
        backups,
        rawFixStdout: result.stdout,
        rawFixStderr: result.stderr,
      };
    }

    const claimedUpdates = parseOsvFixJson(result.stdout);

    // The staging dir contains the lockfile at effectiveFixLockfile (which may include
    // a subdirectory prefix, e.g. 'app/package-lock.json'). Use the basename to resolve
    // the staging path because files were copied by filename only.
    const stagingLockfileName = effectiveFixLockfile.includes('/')
      ? effectiveFixLockfile.split('/').pop()!
      : effectiveFixLockfile;
    const fixedContent = await readFile(join(stagingDir, stagingLockfileName), 'utf-8');
    const backupContent = backups.get(osvFixSpec.fixLockfile) ?? '';
    const bytesChanged = fixedContent !== backupContent;

    // Case A: osv-scanner produced no byte-level change to the lockfile.
    // Any claims in JSON are false (this is the lockfileVersion 1 quirk) —
    // drop them so the report does not overclaim.
    if (!bytesChanged) {
      if (claimedUpdates.length > 0) {
        logger.tagged('osv', 'OSV fix', `osv-scanner reported ${claimedUpdates.length} patch(es) in JSON but the staging lockfile is byte-identical to the host lockfile. This is a known osv-scanner limitation on lockfileVersion 1 (npm 6). Dropping unverifiable claims.`, 'warn');
      } else {
        logger.tagged('osv', 'OSV fix', 'No lockfile changes produced (lockfile already compliant or no patches found)');
      }
      return {
        applied: false,
        packagesUpdated: [],
        backups,
        rawFixStdout: result.stdout,
        rawFixStderr: result.stderr,
      };
    }

    // Case B: bytes changed — verify each claimed update against the actual
    // staging lockfile contents before propagating to host disk.
    const versionsInStaging = collectNpmLockfileVersions(fixedContent);
    const rootVersionsInStaging = collectRootNpmLockfileVersions(fixedContent);

    if (versionsInStaging.size === 0) {
      // Parser could not extract any package versions from the patched lockfile.
      // We refuse to write changes we cannot reason about.
      logger.tagged('osv', 'OSV fix', `Staging lockfile differs from host but could not be parsed; refusing to propagate ${claimedUpdates.length} unverifiable claim(s) to host disk.`, 'warn');
      return {
        applied: false,
        packagesUpdated: [],
        backups,
        rawFixStdout: result.stdout,
        rawFixStderr: result.stderr,
      };
    }

    const verified: PackageUpdate[] = [];
    const dropped: PackageUpdate[] = [];
    for (const claim of claimedUpdates) {
      const diskVersions = versionsInStaging.get(claim.name);
      if (claimIsSatisfiedOnDisk(claim, diskVersions)) {
        const rootVersion = rootVersionsInStaging.get(claim.name);
        verified.push({ ...claim, versionTo: rootVersion ?? claim.versionTo });
      } else {
        dropped.push(claim);
      }
    }

    if (verified.length === 0) {
      // Bytes changed but nothing we can attribute to a concrete upgrade.
      // Refuse to write a change we cannot explain.
      logger.tagged('osv', 'OSV fix', `Staging lockfile differs from host but none of the ${claimedUpdates.length} claimed upgrade(s) were verifiable in its contents. Refusing to write host disk — likely a non-functional normalization from osv-scanner.`, 'warn');
      return {
        applied: false,
        packagesUpdated: [],
        backups,
        rawFixStdout: result.stdout,
        rawFixStderr: result.stderr,
      };
    }

    await writeFile(resolve(cwd, effectiveFixLockfile), fixedContent, 'utf-8');

    // Propagate package.json to host disk if osv-scanner fix also modified it.
    if (backups.has('package.json')) {
      try {
        const stagingManifest = await readFile(join(stagingDir, 'package.json'), 'utf-8');
        if (stagingManifest === backups.get('package.json')) {
          logger.tagged('osv', 'OSV fix', 'package.json unchanged in staging', 'debug');
        } else {
          await writeFile(resolve(cwd, 'package.json'), stagingManifest, 'utf-8');
          logger.tagged('osv', 'OSV fix', 'package.json also updated on host disk (manifest range changed by osv-scanner fix)');
        }
      } catch {
        // Staging package.json does not exist — skip silently.
      }
    }

    if (dropped.length > 0) {
      logger.tagged('osv', 'OSV fix', `${dropped.length} of ${claimedUpdates.length} osv-scanner patch(es) could not be verified in the lockfile and were excluded from the report: ` +
          dropped.map((p) => `${p.name}@${p.versionTo}`).join(', '), 'warn');
    }

    logger.tagged('osv', 'OSV fix', `Applied and verified ${verified.length} package upgrade(s) on host disk`);

    return {
      applied: true,
      packagesUpdated: verified,
      backups,
      rawFixStdout: result.stdout,
      rawFixStderr: result.stderr,
    };
  } finally {
    try {
      await rm(stagingDir, { recursive: true, force: true });
    } catch (e) {
      logger.tagged('osv', 'OSV fix', `Failed to clean staging dir: ${e}`, 'warn');
    }
  }
}
