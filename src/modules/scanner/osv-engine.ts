import type { ScannerEngine, ScannerEngineContext } from './types';
import type { ScanResultJson, EcosystemScanResult, VulnerabilityEntry } from '@core/types/scan';
import { emptyEcosystem } from '@core/types/scan';
import type { ProjectConfig } from '@core/types/config';
import type { EcosystemRegistry } from '@modules/ecosystem/registry';
import { PhaseError, EnvironmentError } from '@core/errors';
import { logger } from '@infra/utils/logger';
import {
  buildScanCommand,
  OSV,
  OSV_DEFAULT_IMAGE,
  validateScanPath,
  resolveScanPathArgs,
} from '@infra/utils/osv-commands';
import { classifyPackage } from '@core/policy/safe-update';
import { getPlatformInstallHint } from '@infra/utils/platform';
import { OsvDockerRunner } from '@infra/provisioner/osv-runner';
import semver from 'semver';

// ─── Internal types ────────────────────────────────────────────────────────────

type OsvVulnerability = {
  id?: string;
  summary?: string;
  severity?: Array<{ type?: string; score?: string }>;
  affected?: Array<{
    ranges?: Array<{
      /**
       * OSV range type: 'SEMVER' | 'ECOSYSTEM' | 'GIT'.
       * GIT ranges carry commit SHAs, not installable package versions — must be
       * excluded from version-based fix detection to avoid semver.coerce() treating
       * a leading-digit SHA (e.g. "9e08eb8f…") as "9.0.0".
       */
      type?: string;
      events?: Array<{
        fixed?: string;
        introduced?: string;
        last_affected?: string;
      }>;
    }>;
  }>;
};

type OsvJsonOutput = {
  results?: Array<{
    packages?: Array<{
      package?: { name?: string; version?: string; ecosystem?: string };
      vulnerabilities?: OsvVulnerability[];
    }>;
  }>;
};

// ─── CVSS helpers ─────────────────────────────────────────────────────────────

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

function extractSafeVersionFromVuln(
  vuln: OsvVulnerability,
  currentVersion: string,
): string | null {
  const coercedCurrent = semver.coerce(currentVersion);
  if (!coercedCurrent) {
    // Fallback for non-semver versions: return the first fixed found from a non-GIT range.
    for (const affected of vuln.affected ?? []) {
      for (const range of affected.ranges ?? []) {
        if (range.type === 'GIT') continue;
        for (const event of range.events ?? []) {
          if (event.fixed) return event.fixed;
        }
      }
    }
    return null;
  }

  for (const affected of vuln.affected ?? []) {
    for (const range of affected.ranges ?? []) {
      // GIT ranges carry commit SHAs — semver.coerce() on a leading-digit SHA
      // (e.g. "9e08eb8f…") would produce "9.0.0", falsely treating it as a
      // semver fix target. Only SEMVER and ECOSYSTEM ranges are package-installable.
      if (range.type === 'GIT') continue;
      let introduced: string | undefined;
      let fixed: string | undefined;

      for (const event of range.events ?? []) {
        if (event.introduced !== undefined) introduced = event.introduced;
        if (event.fixed !== undefined) fixed = event.fixed;
      }

      if (!fixed) continue; // range without fixed (e.g. last_affected only) — skip

      const coercedIntroduced = introduced ? semver.coerce(introduced) : null;
      const coercedFixed = semver.coerce(fixed);

      if (!coercedFixed) continue;

      // Current version must be >= introduced (or no introduced = since 0) AND < fixed
      const afterIntroduced = !coercedIntroduced || semver.gte(coercedCurrent, coercedIntroduced);
      const beforeFixed = semver.lt(coercedCurrent, coercedFixed);

      if (afterIntroduced && beforeFixed) {
        return fixed;
      }
    }
  }

  return null;
}

// ─── Parse helpers ─────────────────────────────────────────────────────────────

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
        const safeVersion = extractSafeVersionFromVuln(vuln, pkgVersion);

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
          ...(classified.breakingReason !== undefined ? { breakingReason: classified.breakingReason } : {}),
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
 *
 * Runner selection (from config.scanners.osv.runner):
 * - 'local'  — always use the local binary; fail if not installed.
 * - 'docker' — always run via an ephemeral OsvDockerRunner container.
 * - 'auto'   — try local first; fall back to Docker if local is unavailable.
 */
export class OsvScannerEngine implements ScannerEngine {
  readonly id = 'osv';
  readonly name = 'OSV Scanner';

  // ── Availability helpers ─────────────────────────────────────────────────────

  /** Returns true when the local osv-scanner binary responds to --version. */
  private async isLocalAvailable(ctx: ScannerEngineContext): Promise<boolean> {
    try {
      const result = await ctx.runner.run(OSV.checkAvailable, { cwd: ctx.cwd });
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  /** Returns true when the `docker` CLI is accessible (basic smoke test). */
  private async isDockerAvailable(ctx: ScannerEngineContext): Promise<boolean> {
    try {
      const result = await ctx.runner.run('docker --version', { cwd: ctx.cwd });
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  async assertAvailable(ctx: ScannerEngineContext): Promise<void> {
    const runner = ctx.config.scanners?.osv?.runner ?? 'docker';

    if (runner === 'local') {
      const ok = await this.isLocalAvailable(ctx);
      if (!ok) {
        const hint = getPlatformInstallHint('osv-scanner');
        throw new EnvironmentError(`osv-scanner not found (runner: local). ${hint}`);
      }
      return;
    }

    if (runner === 'docker') {
      const ok = await this.isDockerAvailable(ctx);
      if (!ok) {
        throw new EnvironmentError(
          'Docker is not available (runner: docker). Install Docker to use the osv-scanner container.',
        );
      }
      return;
    }

    // 'auto': local is preferred; Docker is the fallback.
    const localOk = await this.isLocalAvailable(ctx);
    if (localOk) return;

    const dockerOk = await this.isDockerAvailable(ctx);
    if (dockerOk) return;

    const hint = getPlatformInstallHint('osv-scanner');
    throw new EnvironmentError(
      `osv-scanner is not available locally and Docker is not available either (runner: auto). ` +
      `${hint} or install Docker to use the container fallback.`,
    );
  }

  // ── Scan ─────────────────────────────────────────────────────────────────────

  async scan(ctx: ScannerEngineContext): Promise<ScanResultJson> {
    const { runner, config, cwd, ecosystemRegistry } = ctx;

    logger.info('Running OSV vulnerability scan...');

    const base: ScanResultJson = {
      $schema: 'osv-scan-result/v1',
      agent: 'osv',
      status: 'success',
      environment: runner.environment,
      ecosystems: {},
      error: null,
      // Stamp branch when available (null omitted by consumers — treated as unknown)
      ...(ctx.branch != null ? { branch: ctx.branch } : {}),
    };

    try {
      await this.assertAvailable(ctx);

      // Ecosystem resolution uses config.ecosystems[] declaratively
      const activePlugins = ecosystemRegistry.getAll().filter((p) =>
        config.ecosystems.some((e) => e.id === p.id),
      );

      const runnerMode = config.scanners?.osv?.runner ?? 'docker';

      // Warn once for deprecated/non-docker runner modes
      if (runnerMode === 'local') {
        logger.warn(
          '[OSV runner] runner=local: using local osv-scanner binary. ' +
          'Docker (runner: docker) is the recommended default for reproducible, ' +
          'platform-independent scans. Set scanners.osv.runner to "docker" in your config.',
        );
      } else if (runnerMode === 'auto') {
        logger.warn(
          '[OSV runner] runner=auto is a deprecated escape hatch. ' +
          'Docker (runner: docker) is now the default. ' +
          'Set scanners.osv.runner explicitly to "docker" or "local" in your config.',
        );
      }

      // Determine effective runner: for 'auto' re-check local to pick path.
      const useDocker = runnerMode === 'docker' ||
        (runnerMode === 'auto' && !(await this.isLocalAvailable(ctx)));

      // ── Resolve scan args (scan.paths takes precedence over plugin defaults) ──
      const scanConfig = config.scan;
      let rawArgs: string[];

      if (scanConfig?.paths && scanConfig.paths.length > 0) {
        for (const p of scanConfig.paths) {
          validateScanPath(p);
        }
        rawArgs = resolveScanPathArgs(scanConfig.paths, scanConfig.exclude ?? []);
        if (rawArgs.length === 0) {
          throw new PhaseError(
            'scan.paths is configured but resolved to zero lockfile args — ' +
            'this would silently report zero vulnerabilities',
            'scanner',
          );
        }
      } else {
        rawArgs = activePlugins.flatMap((p) => p.buildScanArgs());
      }

      if (runner.dryRun) {
        if (useDocker) {
          logger.info(`[DRY-RUN] Would execute osv-scanner via Docker container`);
        } else {
          logger.info(`[DRY-RUN] Would execute: ${buildScanCommand(activePlugins)}`);
        }
        return base;
      }

      let stdout: string;
      let exitCode: number;
      let stderr: string;

      if (useDocker) {
        // ── Docker path ────────────────────────────────────────────────────────
        // Raw args are passed directly — no path translation needed.
        // `OsvDockerRunner` sets `--workdir /project` so relative paths from
        // plugin.buildScanArgs() (or scan.paths entries) resolve correctly inside
        // the container.
        const image = config.scanners?.osv?.image ?? OSV_DEFAULT_IMAGE;

        logger.debug(`Running OSV scan via Docker (image: ${image})`);
        const dockerRunner = new OsvDockerRunner({ projectDir: cwd, image });
        const result = await dockerRunner.run(rawArgs);
        stdout = result.stdout;
        exitCode = result.exitCode;
        stderr = result.stderr;
      } else {
        // ── Local path ─────────────────────────────────────────────────────────
        const args = [...rawArgs, '--format', 'json'];
        const cmd = `osv-scanner ${args.join(' ')}`;
        logger.debug(`Running: ${cmd}`);
        const result = await runner.run(cmd, { cwd });
        stdout = result.stdout;
        exitCode = result.exitCode;
        stderr = result.stderr;
      }

      if (exitCode !== 0 && !stdout) {
        return {
          ...base,
          status: 'error',
          error: `Scan failed (exit ${exitCode}): ${stderr}`,
        };
      }

      const parsed = parseOsvJsonOutput(stdout, config, ecosystemRegistry);
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
