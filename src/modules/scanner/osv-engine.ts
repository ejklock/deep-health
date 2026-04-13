import type { ScannerEngine, ScannerEngineContext } from './types.js';
import type { ScanResultJson, EcosystemScanResult, VulnerabilityEntry } from '@core/types/scan.js';
import type { ProjectConfig } from '@core/types/config.js';
import type { EcosystemRegistry } from '@modules/ecosystem/registry.js';
import { PhaseError, EnvironmentError } from '@core/errors.js';
import { logger } from '@infra/utils/logger.js';
import { buildScanCommand, OSV } from '@infra/utils/osv-commands.js';
import { classifyPackage } from '@core/policy/safe-update.js';
import { getPlatformInstallHint } from '@infra/utils/platform.js';

// ─── Internal types ────────────────────────────────────────────────────────────

type OsvVulnerability = {
  id?: string;
  summary?: string;
  severity?: Array<{ type?: string; score?: string }>;
  affected?: Array<{ ranges?: Array<{ events?: Array<{ fixed?: string }> }> }>;
};

type OsvJsonOutput = {
  results?: Array<{
    packages?: Array<{
      package?: { name?: string; version?: string; ecosystem?: string };
      vulnerabilities?: OsvVulnerability[];
    }>;
  }>;
};

// ─── CVSS helpers (moved from scanner.ts) ─────────────────────────────────────

function parseCvssBaseScore(score: string): string {
  try {
    const match = score.match(/CVSS:\d+\.\d+\/(.+)/);
    if (!match) return '—';
    const metrics: Record<string, string> = {};
    for (const part of match[1]!.split('/')) {
      const [k, v] = part.split(':');
      if (k && v) metrics[k] = v;
    }

    const av = ({ N: 0.85, A: 0.62, L: 0.55, P: 0.2 })[metrics['AV'] ?? ''] ?? 0;
    const ac = ({ L: 0.77, H: 0.44 })[metrics['AC'] ?? ''] ?? 0;
    const scope = metrics['S'] === 'C';
    const prMap = scope
      ? { N: 0.85, L: 0.68, H: 0.50 }
      : { N: 0.85, L: 0.62, H: 0.27 };
    const pr = prMap[metrics['PR'] as keyof typeof prMap] ?? 0;
    const ui = ({ N: 0.85, R: 0.62 })[metrics['UI'] ?? ''] ?? 0;
    const impMap = { N: 0, L: 0.22, H: 0.56 };
    const c = impMap[metrics['C'] as keyof typeof impMap] ?? 0;
    const i = impMap[metrics['I'] as keyof typeof impMap] ?? 0;
    const a = impMap[metrics['A'] as keyof typeof impMap] ?? 0;

    const iscBase = 1 - (1 - c) * (1 - i) * (1 - a);
    if (iscBase <= 0) return '0.0';

    let isc: number;
    if (!scope) {
      isc = 6.42 * iscBase;
    } else {
      isc = 7.52 * (iscBase - 0.029) - 3.25 * Math.pow(iscBase - 0.02, 15);
    }

    const exploitability = 8.22 * av * ac * pr * ui;

    let raw: number;
    if (!scope) {
      raw = Math.min(isc + exploitability, 10);
    } else {
      raw = Math.min(1.08 * (isc + exploitability), 10);
    }

    const rounded = Math.ceil(raw * 10) / 10;
    return rounded.toFixed(1);
  } catch {
    return '—';
  }
}

function extractCvss(vuln: { severity?: Array<{ type?: string; score?: string }> }): string {
  for (const s of vuln.severity ?? []) {
    if (s.type === 'CVSS_V3' && s.score) {
      return parseCvssBaseScore(s.score);
    }
  }
  return '—';
}

function extractSafeVersionFromVuln(vuln: {
  affected?: Array<{ ranges?: Array<{ events?: Array<{ fixed?: string }> }> }>;
}): string | null {
  for (const affected of vuln.affected ?? []) {
    for (const range of affected.ranges ?? []) {
      for (const event of range.events ?? []) {
        if (event.fixed) return event.fixed;
      }
    }
  }
  return null;
}

// ─── Parse helpers ─────────────────────────────────────────────────────────────

export function emptyEcosystem(): EcosystemScanResult {
  return {
    vulnerabilities_total: 0,
    auto_safe: 0,
    breaking: 0,
    manual: 0,
    auto_safe_packages: [],
    breaking_packages: [],
    manual_packages: [],
    vulnerabilities: [],
  };
}

function parseOsvJsonOutput(
  stdout: string,
  config: ProjectConfig,
  registry: EcosystemRegistry,
): Pick<ScanResultJson, 'ecosystems'> {
  const data = JSON.parse(stdout) as OsvJsonOutput;
  const ecosystems: Record<string, EcosystemScanResult> = {};

  if (!data.results) return { ecosystems };

  const protectedByPlugin = new Map(
    registry.getAll().map((plugin) => [
      plugin.id,
      new Map(plugin.getProtectedPackages(config).map((p) => [p.package, p])),
    ]),
  );

  const ecosystemSets: Record<
    string,
    { auto_safe: Set<string>; breaking: Set<string>; manual: Set<string> }
  > = {};

  for (const result of data.results) {
    for (const pkg of result.packages ?? []) {
      const pkgName = pkg.package?.name ?? '';
      const pkgVersion = pkg.package?.version ?? '';
      const osvEcosystem = pkg.package?.ecosystem ?? '';

      const plugin = registry.findByOsvEcosystem(osvEcosystem);
      if (!plugin) continue;

      const pluginId = plugin.id;

      if (!ecosystems[pluginId]) {
        ecosystems[pluginId] = emptyEcosystem();
        ecosystemSets[pluginId] = {
          auto_safe: new Set<string>(),
          breaking: new Set<string>(),
          manual: new Set<string>(),
        };
      }
      const target = ecosystems[pluginId]!;
      const targetSets = ecosystemSets[pluginId]!;
      const protectedMap = protectedByPlugin.get(pluginId) ?? new Map();

      for (const vuln of pkg.vulnerabilities ?? []) {
        const ghsaId = vuln.id ?? '';
        const risk = vuln.summary ?? '';
        const cvss = extractCvss(vuln);
        const safeVersion = extractSafeVersionFromVuln(vuln);

        const classified = classifyPackage(
          { name: pkgName, currentVersion: pkgVersion, safeVersion },
          protectedMap,
        );

        const entry: VulnerabilityEntry = {
          ecosystem: pluginId,
          package: pkgName,
          currentVersion: pkgVersion,
          safeVersion,
          cvss,
          ghsaId,
          risk,
          classification: classified.classification,
          reason: classified.reason ?? '',
        };

        target.vulnerabilities.push(entry);
        target.vulnerabilities_total++;

        const packageRef = `${pkgName}@${pkgVersion}`;

        if (classified.classification === 'auto_safe') {
          target.auto_safe++;
          if (!targetSets.auto_safe.has(packageRef)) {
            targetSets.auto_safe.add(packageRef);
            target.auto_safe_packages.push(packageRef);
          }
        } else if (classified.classification === 'breaking') {
          target.breaking++;
          if (!targetSets.breaking.has(packageRef)) {
            targetSets.breaking.add(packageRef);
            target.breaking_packages.push(packageRef);
          }
        } else {
          target.manual++;
          if (!targetSets.manual.has(packageRef)) {
            targetSets.manual.add(packageRef);
            target.manual_packages.push(packageRef);
          }
        }
      }
    }
  }

  return { ecosystems };
}

// ─── OsvScannerEngine ──────────────────────────────────────────────────────────

/**
 * Scanner engine wrapping osv-scanner CLI.
 *
 * Encapsulates: availability assertion, command construction, JSON parsing,
 * and result normalization into ScanResultJson.
 */
export class OsvScannerEngine implements ScannerEngine {
  readonly id = 'osv-scanner';
  readonly name = 'OSV Scanner';

  async assertAvailable(ctx: ScannerEngineContext): Promise<void> {
    const result = await ctx.runner.run(OSV.checkAvailable, { cwd: ctx.cwd });
    if (result.exitCode !== 0) {
      const hint = getPlatformInstallHint('osv-scanner');
      throw new EnvironmentError(
        `osv-scanner not found. ${hint}`,
      );
    }
  }

  async scan(ctx: ScannerEngineContext): Promise<ScanResultJson> {
    const { runner, config, cwd, ecosystemRegistry } = ctx;

    logger.info('Phase 1: Running OSV vulnerability scan...');

    const base: ScanResultJson = {
      $schema: 'osv-scan-result/v1',
      agent: 'osv-scanner',
      status: 'success',
      environment: runner.environment,
      ecosystems: {},
      error: null,
    };

    try {
      await this.assertAvailable(ctx);

      if (runner.dryRun) {
        const activePlugins = ecosystemRegistry.getActive(config);
        logger.info(`[DRY-RUN] Would execute: ${buildScanCommand(activePlugins)}`);
        return base;
      }

      const activePlugins = ecosystemRegistry.getActive(config);
      const cmd = buildScanCommand(activePlugins);
      logger.debug(`Running: ${cmd}`);
      const scanResult = await runner.run(cmd, { cwd });

      if (scanResult.exitCode !== 0 && !scanResult.stdout) {
        return {
          ...base,
          status: 'error',
          error: `Scan failed (exit ${scanResult.exitCode}): ${scanResult.stderr}`,
        };
      }

      const parsed = parseOsvJsonOutput(scanResult.stdout, config, ecosystemRegistry);
      return { ...base, ...parsed };
    } catch (err) {
      if (err instanceof EnvironmentError) throw err;
      throw new PhaseError(
        `OSV scanner phase failed: ${err instanceof Error ? err.message : String(err)}`,
        'scanner',
        err,
      );
    }
  }
}
