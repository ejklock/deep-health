import type { ScanResultJson, EcosystemScanResult } from '@core/types/scan';
import type { EngineWarning } from './types';

/**
 * The result of aggregating scan output from one or more scanner engines.
 *
 * The `primary` field points to the canonical result used for Gate A validation
 * and downstream update orchestration. It is always driven by the OSV engine.
 * Additional engines contribute their results to `engineResults` for reporting.
 */
export interface AggregatedScanResult {
  /**
   * Canonical result consumed by Gate A and the update loop.
   * Shape mirrors ScanResultJson; populated from the primary engine (OSV).
   */
  primary: ScanResultJson;

  /**
   * Non-fatal warnings from engines that ran but did not block the pipeline.
   */
  warnings: EngineWarning[];

  /**
   * Raw per-engine results indexed by engine id.
   * Consumers needing engine-specific data can inspect this map directly.
   */
  engineResults: Record<string, ScanResultJson>;
}

/**
 * Merge per-ecosystem results from multiple engines into a single ecosystems map.
 *
 * Strategy:
 * - Each engine's ecosystem entries are included as-is.
 * - If two engines emit the same ecosystem key, their vulnerability lists are
 *   concatenated and counters are summed. Package ref sets are union-merged.
 */
function mergeEcosystems(
  engineResults: ScanResultJson[],
): Record<string, EcosystemScanResult> {
  const merged: Record<string, EcosystemScanResult> = {};

  for (const result of engineResults) {
    for (const [id, eco] of Object.entries(result.ecosystems)) {
      if (!merged[id]) {
        // First engine to report this ecosystem — copy directly (no need to clone deeply)
        merged[id] = {
          vulnerabilities_total: eco.vulnerabilities_total,
          auto_safe: eco.auto_safe,
          breaking: eco.breaking,
          manual: eco.manual,
          auto_safe_packages: [...eco.auto_safe_packages],
          breaking_packages: [...eco.breaking_packages],
          manual_packages: [...eco.manual_packages],
          vulnerabilities: [...eco.vulnerabilities],
        };
      } else {
        // Subsequent engine: merge into existing entry
        const target = merged[id]!;
        target.vulnerabilities_total += eco.vulnerabilities_total;
        target.auto_safe += eco.auto_safe;
        target.breaking += eco.breaking;
        target.manual += eco.manual;
        // Union-merge package ref arrays (dedup by string equality)
        const autoSafeSet = new Set(target.auto_safe_packages);
        for (const p of eco.auto_safe_packages) autoSafeSet.add(p);
        target.auto_safe_packages = [...autoSafeSet];
        const breakingSet = new Set(target.breaking_packages);
        for (const p of eco.breaking_packages) breakingSet.add(p);
        target.breaking_packages = [...breakingSet];
        const manualSet = new Set(target.manual_packages);
        for (const p of eco.manual_packages) manualSet.add(p);
        target.manual_packages = [...manualSet];
        target.vulnerabilities.push(...eco.vulnerabilities);
      }
    }
  }

  return merged;
}

/**
 * Aggregate a set of per-engine scan results into a single AggregatedScanResult.
 *
 * The first engine in `engineResults` is treated as the primary (drives Gate A).
 * Warnings are passed through from the caller — engines that fail non-fatally
 * emit an EngineWarning instead of throwing.
 */
export function aggregateScanResults(
  engineResults: Array<{ engineId: string; result: ScanResultJson }>,
  warnings: EngineWarning[] = [],
): AggregatedScanResult {
  if (engineResults.length === 0) {
    throw new Error('aggregateScanResults: at least one engine result is required');
  }

  const byId: Record<string, ScanResultJson> = {};
  for (const { engineId, result } of engineResults) {
    byId[engineId] = result;
  }

  const primaryEntry = engineResults[0]!;
  const primaryRaw = primaryEntry.result;

  // Merge ecosystems across all successful engine results
  const successfulResults = engineResults
    .filter(({ result }) => result.status !== 'error')
    .map(({ result }) => result);

  const mergedEcosystems = mergeEcosystems(
    successfulResults.length > 0 ? successfulResults : [primaryRaw],
  );

  // Determine overall status: error if primary failed, otherwise success
  const overallStatus = primaryRaw.status;

  const primary: ScanResultJson = {
    ...primaryRaw,
    ecosystems: mergedEcosystems,
    status: overallStatus,
  };

  return {
    primary,
    warnings,
    engineResults: byId,
  };
}
