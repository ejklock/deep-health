import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandRunner } from '@core/types/common';
import type { ProjectConfig, ValidationCommandConfig, FixerStrategyId } from '@core/types/config';
import type { UpdateResultJson } from '@core/types/update';
import type { ScanResultJson } from '@core/types/scan';
import { emptyEcosystem } from '@core/types/scan';
import { logger } from '@infra/utils/logger';
import { runEcosystemEnvironmentProbe } from '../utils/environment-probe';
import { runUpdaterLifecycle } from '../utils/updater-lifecycle';
import { parseComposerAuditJson, parseComposerAuditAdvisories } from './composer-audit-parser';
import type { ComposerAuditAdvisory } from './composer-audit-parser';
import type { AuditFinding } from '@core/types/update';

const COMPOSER_FILES = ['composer.json', 'composer.lock'];

/**
 * Parse a composer.lock JSON string and return a Map of package name → version.
 * Reads from both `packages` and `packages-dev` arrays.
 * Returns an empty Map on parse failure or missing fields (logs a warning).
 */
export function extractComposerLockVersions(lockJsonText: string): Map<string, string> {
  try {
    const parsed = JSON.parse(lockJsonText) as Record<string, unknown>;
    const result = new Map<string, string>();
    const sections = ['packages', 'packages-dev'] as const;
    for (const section of sections) {
      const pkgs = parsed[section];
      if (!Array.isArray(pkgs)) continue;
      for (const pkg of pkgs) {
        if (pkg && typeof pkg === 'object') {
          const p = pkg as Record<string, unknown>;
          if (typeof p['name'] === 'string' && typeof p['version'] === 'string') {
            result.set(p['name'], p['version']);
          }
        }
      }
    }
    return result;
  } catch {
    logger.warn('composer-updater: failed to parse composer.lock JSON — version extraction skipped');
    return new Map();
  }
}

/**
 * Build `packages_updated` array from pre/post lock version maps.
 *
 * For each target package name:
 * - Skip if the post-update version is absent (package not in new lockfile).
 * - Skip if pre-update version equals post-update version (no real change).
 * - Otherwise emit `name@<postVersion>`.
 */
export function buildComposerPackagesUpdated(
  targetNames: string[],
  beforeVersions: Map<string, string>,
  afterVersions: Map<string, string>,
): string[] {
  const updated: string[] = [];
  for (const name of targetNames) {
    const versionTo = afterVersions.get(name);
    if (versionTo === undefined) continue;
    const versionFrom = beforeVersions.get(name);
    if (versionFrom === versionTo) continue;
    updated.push(`${name}@${versionTo}`);
  }
  return updated;
}

export function extractPackageNames(packageRefs: string[]): string[] {
  return packageRefs.map((ref) => {
    const atIndex = ref.lastIndexOf('@');
    return atIndex > 0 ? ref.slice(0, atIndex) : ref;
  });
}

/**
 * Build shared composer flags for all write-path commands (array form for runArgs).
 * --no-interaction      : no prompts (CI context)
 * --no-scripts          : skip post-install-cmd, post-autoload-dump, post-update-cmd, etc.
 *                         Framework hooks (e.g. Laravel's `artisan package:discover`)
 *                         bootstrap app state that depends on runtime services (db, cache, queue)
 *                         — not available inside a dependency-upgrade flow.
 * --ignore-platform-reqs: (Docker mode only, unless overridden) skips PHP extension checks.
 *                         The Docker container is a CI runner, not the production environment.
 *                         Production has ext-intl, ext-gd, ext-exif, etc.; the container does not.
 */
function buildComposerAutomationArgs(runner: CommandRunner, config: ProjectConfig): string[] {
  const composerConfig = config.runners?.composer;
  const ignorePlatformReqs =
    composerConfig?.ignore_platform_reqs ?? runner.environment === 'docker';

  return [
    '--no-interaction',
    '--no-scripts',
    ...(ignorePlatformReqs ? ['--ignore-platform-reqs'] : []),
  ];
}

/**
 * The typed fixer result flowing through applyFix → derivePackagesUpdated.
 * auditPackageNames: additional packages discovered via `composer audit` (osv-then-audit strategy).
 * auditAdvisories: structured advisory data for packages that were successfully fixed by the audit step.
 */
interface ComposerFixerResult {
  auditPackageNames: string[];
  auditAdvisories: ComposerAuditAdvisory[];
}

export async function runComposerUpdater(
  runner: CommandRunner,
  config: ProjectConfig,
  scanResult: ScanResultJson,
  cwd: string,
  authorizeBreaking = false,
  validationCommands: ValidationCommandConfig[] = [],
  fixerStrategy: FixerStrategyId | undefined = undefined,
): Promise<UpdateResultJson> {
  logger.info('Running Composer safe updates...');

  const automationArgs = buildComposerAutomationArgs(runner, config);
  const composerEcosystem = scanResult.ecosystems['composer'] ?? emptyEcosystem();

  const autoSafePackageNames = extractPackageNames(composerEcosystem.auto_safe_packages);
  const breakingPackageNames = authorizeBreaking
    ? extractPackageNames(composerEcosystem.breaking_packages)
    : [];
  const packageNamesToUpdate = [...new Set([...autoSafePackageNames, ...breakingPackageNames])];

  const probeArgs = ['install', ...automationArgs];

  // Capture the before-lock text here so derivePackagesUpdated can access it.
  // Populated before applyFix runs (at backup time) via a separate backup call.
  let beforeLockText = '';

  return runUpdaterLifecycle<ComposerFixerResult>(
    {
      agentName: 'composer-safe-update',
      ecosystemKey: 'composer',
      backupPaths: COMPOSER_FILES,
      bootstrapSpec: {
        binary: 'composer',
        args: probeArgs,
        label: 'composer install (revert)',
      },

      async probe(ctx) {
        // ── Short-circuit: no packages to update ──
        if (packageNamesToUpdate.length === 0) {
          return {
            $schema: 'osv-update-result/v1' as const,
            agent: 'composer-safe-update',
            status: 'success' as const,
            packages_updated: [],
            packages_skipped: [],
            packages_pending_breaking: composerEcosystem.breaking_packages,
            validations: [{ name: 'validation', status: 'skipped' as const, detail: 'No packages to update' }],
            error: null,
          };
        }
        // ── Dry-run: log would-execute commands and let lifecycle handle the early return ──
        if (ctx.runner.dryRun) {
          logger.tagged('composer', 'DRY-RUN', `Would execute: composer install ${automationArgs.join(' ')} (env-check)`);
          logger.tagged('composer', 'DRY-RUN', `Would execute: composer update ${packageNamesToUpdate.join(' ')} ${automationArgs.join(' ')}`);
          for (const vc of validationCommands) {
            logger.tagged('composer', 'DRY-RUN', `Would execute: ${vc.command}`);
          }
          return null;
        }
        // ── Environment check: verify PHP + composer are functional BEFORE any mutation ──
        const probe = await runEcosystemEnvironmentProbe(ctx.runner, {
          binary: 'composer',
          args: probeArgs,
          cwd: ctx.cwd,
          errorPrefix: 'Composer environment mismatch',
          label: 'composer',
        });
        if (!probe.ok) {
          return {
            $schema: 'osv-update-result/v1' as const,
            agent: 'composer-safe-update',
            status: 'error' as const,
            packages_updated: [],
            packages_skipped: [],
            packages_pending_breaking: composerEcosystem.breaking_packages,
            validations: [{ name: 'validation', status: 'skipped' as const, detail: 'Composer environment check failed — skipped' }],
            error: probe.error,
          };
        }
        return null;
      },

      async applyFix(ctx) {
        // Capture the pre-update composer.lock before mutation so derivePackagesUpdated
        // can diff before/after. Read directly — backupFiles already ran inside the lifecycle
        // but its Map is internal. A second read here is a single file read, not a backup copy.
        try {
          beforeLockText = await readFile(join(ctx.cwd, 'composer.lock'), 'utf-8');
        } catch {
          // File missing before update — treat as empty; derivePackagesUpdated will fall back
          beforeLockText = '';
        }

        logger.debug('Running composer outdated --direct (informational)...');
        await ctx.runner.runArgs('composer', ['outdated', '--direct'], { cwd: ctx.cwd });

        const pkgList = packageNamesToUpdate.join(' ');
        logger.info(`Updating packages: ${pkgList}`);
        // SEC: use runArgs (shell: false) — packageNames from scanner are variable data
        const updateResult = await ctx.runner.runArgs(
          'composer',
          ['update', ...packageNamesToUpdate, '--with-all-dependencies', ...automationArgs],
          { cwd: ctx.cwd, stream: true },
        );

        if (updateResult.exitCode !== 0) {
          // composer update may fail AFTER writing composer.lock (post-autoload-dump
          // scripts, e.g. Laravel's `artisan package:discover`, run at the end and can
          // return non-zero even though the lockfile is already on disk). Revert so
          // the working tree is left byte-identical to the pre-update state.
          logger.error('composer update failed — reverting Composer changes...');
          return { ok: false, error: `composer update failed: ${updateResult.stderr}` };
        }

        // ── osv-then-audit step ───────────────────────────────────────────────────
        let auditPackageNames: string[] = [];
        let auditAdvisories: ComposerAuditAdvisory[] = [];

        if (fixerStrategy === 'osv-then-audit') {
          try {
            logger.tagged('composer', 'audit-fix', 'Running composer audit to find additional vulnerabilities...');
            // SEC: use runArgs (shell: false)
            const auditResult = await ctx.runner.runArgs(
              'composer',
              ['audit', '--format=json'],
              { cwd: ctx.cwd },
            );

            const rawAudit = auditResult.stdout ?? '';
            const auditFindings = parseComposerAuditJson(rawAudit);
            const allAdvisories = parseComposerAuditAdvisories(rawAudit);

            // Filter out packages already targeted by the OSV update
            const newAuditPackages = auditFindings.filter(
              (name) => !packageNamesToUpdate.includes(name),
            );

            if (newAuditPackages.length > 0) {
              logger.tagged(
                'composer',
                'audit-fix',
                `Found ${newAuditPackages.length} additional package(s) from audit: ${newAuditPackages.join(', ')}`,
              );
              // SEC: use runArgs (shell: false) — package names from audit output are variable data
              const auditUpdateResult = await ctx.runner.runArgs(
                'composer',
                ['update', ...newAuditPackages, '--with-all-dependencies', ...automationArgs],
                { cwd: ctx.cwd, stream: true },
              );

              if (auditUpdateResult.exitCode !== 0) {
                logger.tagged(
                  'composer',
                  'audit-fix',
                  `composer update for audit packages failed (exit ${auditUpdateResult.exitCode}) — continuing with OSV results only`,
                  'warn',
                );
              } else {
                auditPackageNames = newAuditPackages;
                // Store structured advisories only for the packages that were actually fixed.
                auditAdvisories = allAdvisories.filter((a) => auditPackageNames.includes(a.package));
              }
            } else {
              logger.tagged('composer', 'audit-fix', 'No additional packages found by audit — continuing with OSV results only');
            }

            // Warn-level summary — always visible regardless of progressSink state
            let auditSummary: string;
            if (newAuditPackages.length > 0 && auditPackageNames.length > 0) {
              auditSummary = `Audit step completed — fixed ${auditPackageNames.length} additional package(s): ${auditPackageNames.join(', ')}`;
            } else if (newAuditPackages.length > 0 && auditPackageNames.length === 0) {
              auditSummary = `Audit step completed — update failed for ${newAuditPackages.length} audit package(s), continuing with OSV results only`;
            } else if (auditFindings.length > 0) {
              auditSummary = `Audit step completed — ${auditFindings.length} finding(s) already covered by OSV update`;
            } else {
              auditSummary = 'Audit step completed — no additional vulnerabilities found after OSV update';
            }
            logger.tagged('composer', 'audit-fix', auditSummary, 'warn');
          } catch (auditErr) {
            // Audit step failure is non-blocking — log warning and continue with OSV results
            logger.tagged(
              'composer',
              'audit-fix',
              `composer audit step failed: ${auditErr instanceof Error ? auditErr.message : String(auditErr)} — continuing with OSV results only`,
              'warn',
            );
          }
        }

        return { ok: true, value: { auditPackageNames, auditAdvisories } };
      },

      async derivePackagesUpdated(ctx, fixerResult) {
        const beforeVersions = extractComposerLockVersions(beforeLockText);
        try {
          const afterLockText = await readFile(join(ctx.cwd, 'composer.lock'), 'utf-8');
          const afterVersions = extractComposerLockVersions(afterLockText);

          // Merge OSV target list with audit-discovered packages (highest-version-wins
          // is automatic: the final composer.lock reflects the last write, so the version
          // in afterVersions is always >= any intermediate version).
          const allTargetNames = [
            ...new Set([...packageNamesToUpdate, ...fixerResult.auditPackageNames]),
          ];

          return buildComposerPackagesUpdated(allTargetNames, beforeVersions, afterVersions);
        } catch (readErr) {
          logger.warn(
            `composer-updater: could not read post-update composer.lock (${readErr instanceof Error ? readErr.message : String(readErr)}) — falling back to scan package list`,
          );
          return composerEcosystem.auto_safe_packages;
        }
      },

      async deriveAuditFindings(_ctx, fixerResult): Promise<AuditFinding[] | undefined> {
        if (fixerResult.auditAdvisories.length === 0) return undefined;
        return fixerResult.auditAdvisories.map((advisory) => ({
          ecosystem: 'composer',
          package: advisory.package,
          advisoryId: advisory.advisoryId,
          title: advisory.title,
          cve: advisory.cve,
          affectedVersions: advisory.affectedVersions,
        }));
      },
    },
    { runner, cwd, scanResult, ecosystemId: 'composer', validationCommands, authorizeBreaking },
  );
}
