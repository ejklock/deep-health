import type { ScannerEngine, ScannerEngineContext } from './types';
import type { ScanResultJson, VulnerabilityEntry } from '@core/types/scan';
import { emptyEcosystem } from '@core/types/scan';
import { classifyPackage } from '@core/policy/safe-update';
import type { ProtectedPackage } from '@core/types/config';

/**
 * Normalized vulnerability shape that external scanner adapters must produce.
 * The adapter translates from this intermediate format to ScanResultJson.
 */
export interface RawVulnerability {
  ecosystem: string;        // 'npm', 'packagist', 'PyPI', 'WordPress', etc.
  package: string;
  currentVersion: string;
  safeVersion: string | null;
  severity: string;         // 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'
  cvss?: string;            // CVSS vector or base score string (optional)
  advisoryId: string;       // CVE-xxx, GHSA-xxx, WS-xxx, etc.
}

/**
 * Base class for scanner engines whose output format differs from OSV.
 *
 * Subclass this when adding a new CVE source (Snyk, WPScan, Patchstack, NVD).
 * Implement `assertAvailable()` and `fetchVulnerabilities()`.
 * The base class handles ScanResultJson assembly and classifyPackage() calls.
 *
 * Template Method pattern: scan() orchestrates the fixed algorithm;
 * subclasses plug in the source-specific data fetching.
 */
export abstract class ExternalScannerAdapter implements ScannerEngine {
  abstract readonly id: string;
  abstract readonly name: string;

  abstract assertAvailable(ctx: ScannerEngineContext): Promise<void>;

  /**
   * Fetch raw vulnerabilities from the external source.
   * Must never throw for non-fatal failures — return [] and log a warning instead.
   */
  abstract fetchVulnerabilities(ctx: ScannerEngineContext): Promise<RawVulnerability[]>;

  async scan(ctx: ScannerEngineContext): Promise<ScanResultJson> {
    const raw = await this.fetchVulnerabilities(ctx);
    return this.buildScanResult(raw, ctx);
  }

  protected buildScanResult(
    vulns: RawVulnerability[],
    ctx: ScannerEngineContext,
  ): ScanResultJson {
    const ecosystems: Record<string, ReturnType<typeof emptyEcosystem>> = {};

    for (const vuln of vulns) {
      if (!ecosystems[vuln.ecosystem]) {
        ecosystems[vuln.ecosystem] = emptyEcosystem();
      }
      const eco = ecosystems[vuln.ecosystem]!;

      const plugin = ctx.ecosystemRegistry.findByOsvEcosystem(vuln.ecosystem);
      const protectedPkgs: ProtectedPackage[] = plugin
        ? plugin.getProtectedPackages(ctx.config)
        : [];

      const classified = classifyPackage(
        {
          name: vuln.package,
          currentVersion: vuln.currentVersion,
          safeVersion: vuln.safeVersion,
        },
        protectedPkgs,
      );

      const entry: VulnerabilityEntry = {
        ecosystem: vuln.ecosystem,
        package: vuln.package,
        currentVersion: vuln.currentVersion,
        safeVersion: vuln.safeVersion,
        cvss: vuln.cvss ?? vuln.severity,
        ghsaId: vuln.advisoryId,
        risk: vuln.severity,
        classification: classified.classification,
        reason: classified.reason ?? '',
        breakingReason: classified.breakingReason,
      };

      eco.vulnerabilities.push(entry);
      eco.vulnerabilities_total++;

      const pkgRef = `${vuln.package}@${vuln.currentVersion}`;
      if (classified.classification === 'auto_safe') {
        eco.auto_safe++;
        eco.auto_safe_packages.push(pkgRef);
      } else if (classified.classification === 'breaking') {
        eco.breaking++;
        eco.breaking_packages.push(pkgRef);
      } else {
        eco.manual++;
        eco.manual_packages.push(pkgRef);
      }
    }

    return {
      $schema: 'osv-scan-result/v1',
      agent: this.id,
      status: 'success',
      environment: 'docker',
      ecosystems,
      error: null,
      branch: ctx.branch,
    };
  }
}
