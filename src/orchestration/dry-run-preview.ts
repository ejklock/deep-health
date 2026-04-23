import type { EcosystemScanResult } from "@core/types/scan";
import { logger } from "@infra/utils/logger";

/**
 * Log a structured "planned changes" preview for a single ecosystem when running in dry-run mode.
 *
 * Shows which packages would be updated and (if authorizeBreaking is true)
 * which breaking-change packages would be installed.
 *
 * Output goes to logger.info. Never throws.
 */
export function logDryRunPreview(
  pluginId: string,
  ecosystemResult: EcosystemScanResult,
  authorizeBreaking: boolean,
): void {
  const autoSafe = ecosystemResult.vulnerabilities.filter(
    (v) => v.classification === "auto_safe" && v.safeVersion,
  );

  const breaking = authorizeBreaking
    ? ecosystemResult.vulnerabilities.filter(
        (v) =>
          v.classification === "breaking" &&
          v.safeVersion &&
          v.breakingReason !== "protected-constraint",
      )
    : [];

  // Deduplicate by package name (multiple CVEs may target the same package)
  const uniqueAutoSafe = new Map<
    string,
    { currentVersion: string; safeVersion: string }
  >();
  for (const v of autoSafe) {
    if (!uniqueAutoSafe.has(v.package)) {
      uniqueAutoSafe.set(v.package, {
        currentVersion: v.currentVersion,
        safeVersion: v.safeVersion!,
      });
    }
  }

  const uniqueBreaking = new Map<
    string,
    { currentVersion: string; safeVersion: string }
  >();
  for (const v of breaking) {
    if (!uniqueBreaking.has(v.package)) {
      uniqueBreaking.set(v.package, {
        currentVersion: v.currentVersion,
        safeVersion: v.safeVersion!,
      });
    }
  }

  if (uniqueAutoSafe.size === 0 && uniqueBreaking.size === 0) {
    logger.info(`[DRY-RUN] ${pluginId}: no planned changes`);
    return;
  }

  logger.info(
    `[DRY-RUN] ${pluginId}: planned changes preview (${uniqueAutoSafe.size + uniqueBreaking.size} package(s)):`,
  );

  for (const [name, { currentVersion, safeVersion }] of uniqueAutoSafe) {
    logger.info(`  [auto-safe]  ${name}: ${currentVersion} → ${safeVersion}`);
  }

  for (const [name, { currentVersion, safeVersion }] of uniqueBreaking) {
    logger.info(`  [breaking]   ${name}: ${currentVersion} → ${safeVersion}`);
  }
}
