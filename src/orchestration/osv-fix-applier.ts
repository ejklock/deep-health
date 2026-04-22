import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import os from 'node:os';
import { OsvDockerRunner } from '@infra/provisioner/osv-runner';
import { backupFiles } from '@infra/utils/git';
import { logger } from '@infra/utils/logger';

export interface OsvFixApplyInput {
  cwd: string;
  osvConfig?: { image?: string; platform?: string };
  osvFixSpec: {
    fixLockfile: string;            // e.g. 'package-lock.json'
    backupFiles: readonly string[]; // files to stage
  };
  dryRun: boolean;
}

export interface OsvFixApplyResult {
  /** true if host lockfile was physically rewritten (staging diff != backup) */
  applied: boolean;
  /** Packages actually upgraded, from osv-scanner fix --format=json stdout */
  packagesUpdated: Array<{ name: string; versionFrom: string; versionTo: string }>;
  /** Pre-fix snapshot of all osvFixSpec.backupFiles, for downstream rollback */
  backups: Map<string, string>;
  rawFixStdout: string;
  rawFixStderr: string;
}

/**
 * Parse the JSON output from `osv-scanner fix --format=json`.
 *
 * Accesses top-level patches[].packageUpdates[] and returns a deduplicated
 * (by name, last-wins) list of { name, versionFrom, versionTo }.
 */
function parseOsvFixJson(
  stdout: string,
): Array<{ name: string; versionFrom: string; versionTo: string }> {
  try {
    const parsed: unknown = JSON.parse(stdout);

    if (!parsed || typeof parsed !== 'object') return [];

    const asObj = parsed as Record<string, unknown>;
    const patches = asObj['patches'];
    if (!Array.isArray(patches)) return [];

    const dedupe = new Map<string, { name: string; versionFrom: string; versionTo: string }>();

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
    logger.warn(`[OSV fix] Could not parse osv-scanner fix JSON output: ${err}`);
    return [];
  }
}

/**
 * Apply `osv-scanner fix` using a staging temp directory approach.
 *
 * Instead of bind-mounting the real project directory (unreliable on macOS /Volumes),
 * we copy the relevant files into a temp dir, run osv-scanner fix there, then write
 * the result back to the host via Node.js fs.writeFile.
 *
 * `packages_updated` is derived from `osv-scanner fix --format=json` stdout — NOT
 * from the scan result auto_safe_packages list.
 */
export async function applyOsvFixViaStaging(
  input: OsvFixApplyInput,
): Promise<OsvFixApplyResult> {
  const { cwd, osvConfig, osvFixSpec, dryRun } = input;

  if (dryRun) {
    logger.info('[DRY-RUN] Would run osv-scanner fix in staging temp dir');
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
      osvFixSpec.fixLockfile,
    ]);

    logger.debug(`[OSV fix] osv-scanner fix exited with code ${result.exitCode}`);

    if (result.exitCode !== 0) {
      logger.warn(
        '[OSV fix] osv-scanner fix exited with non-zero exit code (no changes applied)',
      );
      return {
        applied: false,
        packagesUpdated: [],
        backups,
        rawFixStdout: result.stdout,
        rawFixStderr: result.stderr,
      };
    }

    const packagesUpdated = parseOsvFixJson(result.stdout);

    // Compare staging lockfile vs original backup
    const fixedContent = await readFile(join(stagingDir, osvFixSpec.fixLockfile), 'utf-8');
    const backupContent = backups.get(osvFixSpec.fixLockfile) ?? '';
    const applied = fixedContent !== backupContent;

    if (applied) {
      await writeFile(resolve(cwd, osvFixSpec.fixLockfile), fixedContent, 'utf-8');
      logger.info(`[OSV fix] Applied ${packagesUpdated.length} package upgrade(s) to host disk`);
    } else {
      logger.info(
        '[OSV fix] No lockfile changes produced (lockfile already compliant or no patches found)',
      );
    }

    return { applied, packagesUpdated, backups, rawFixStdout: result.stdout, rawFixStderr: result.stderr };
  } finally {
    try {
      await rm(stagingDir, { recursive: true, force: true });
    } catch (e) {
      logger.warn(`[OSV fix] Failed to clean staging dir: ${e}`);
    }
  }
}
