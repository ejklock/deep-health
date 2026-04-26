import type { CommandRunner } from '@core/types/common';
import type { ProjectConfig, ProtectedPackage, FixerStrategyId, ValidationCommandConfig, AdvisorConfig } from '@core/types/config';
import type { ScanResultJson } from '@core/types/scan';
import type { UpdateResultJson } from '@core/types/update';
import type { EcosystemRuntimeSpec } from '@infra/ecosystem-runtime/types';

export interface EcosystemUpdaterContext {
  runner: CommandRunner;
  config: ProjectConfig;
  scanResult: ScanResultJson;
  cwd: string;
  authorizeBreaking: boolean;
  /** Validation commands from ecosystems[] config entry (overrides plugin defaults) */
  validationCommands?: ValidationCommandConfig[];
  /** Fixer strategy from ecosystems[] config entry (overrides plugin default) */
  fixerStrategy?: FixerStrategyId;
  /**
   * Pre-fix file backups taken by the orchestrator before running any fixer
   * (e.g. before osv-scanner fix mutates package-lock.json).
   * When provided, the updater must use these backups for rollback instead of
   * taking its own backup (which would be too late for the osv strategy).
   */
  preFixBackups?: Map<string, string>;
  /**
   * Populated by the orchestrator when fixerStrategy='osv' and the staging-apply
   * flow completed (not dry-run). Contains evidence of what was actually applied to disk.
   */
  osvFixOutcome?: {
    applied: boolean;
    packagesUpdated: Array<{ name: string; versionFrom: string; versionTo: string }>;
  };
  /**
   * Pre-run snapshots of key project files (package.json, package-lock.json) taken
   * at the very start of the orchestrator run, before any mutations.
   * Used for dirty-tree detection after revert: if the on-disk state after revert differs
   * from these snapshots, external changes during the run may have been lost.
   */
  preRunSnapshots?: Map<string, string>;
}

export interface EcosystemPlugin {
  /** Canonical ID: 'npm', 'composer', 'pip', 'cargo' */
  readonly id: string;

  /** Human-readable name for logs and reports */
  readonly name: string;

  /** Lock/manifest files to copy before updating */
  readonly lockfiles: string[];

  /**
   * Ecosystem strings returned by OSV in the JSON output,
   * mapped to this plugin.
   * Ex: ['packagist', 'composer'] for the composer plugin
   */
  readonly osvEcosystems: string[];

  /**
   * Human-readable label used in executive report evidence tables.
   * Ex: 'PHP/Composer', 'npm'
   */
  readonly reportLabel: string;

  /**
   * Fixer strategy ids this plugin supports.
   * The first entry is the default strategy for this plugin.
   */
  readonly supportedFixers: FixerStrategyId[];

  /**
   * Default validation commands for this plugin.
   * These are used when no validationCommands are specified in the
   * project config ecosystems[] entry.
   */
  readonly defaultValidationCommands: ValidationCommandConfig[];

  /**
   * Default advisor commands for this plugin.
   * These are used when no advisors are specified in the
   * project config ecosystems[] entry.
   */
  readonly defaultAdvisors: AdvisorConfig[];

  /** Additional args for `osv-scanner` (ex: ['--lockfile', 'composer.lock']) */
  buildScanArgs(): string[];

  /** Protected packages for this ecosystem in the project config */
  getProtectedPackages(config: ProjectConfig): ProtectedPackage[];

  /** Runs the update phase for this ecosystem */
  runUpdater(ctx: EcosystemUpdaterContext): Promise<UpdateResultJson>;

  /**
   * Declarative tag indicating the container runtime this ecosystem needs.
   * The orchestrator uses this to resolve an effective CommandRunner.
   * Undefined means no special runtime wrapping — use the base runner.
   */
  readonly runtimeContainer?: 'npm-docker' | 'pip-docker' | 'composer-docker';

  /**
   * Declarative spec for the Ecosystem Runtime Container module.
   * When present, the orchestrator uses it to resolve a containerized CommandRunner;
   * when absent, the plugin runs on the host.
   */
  readonly runtimeSpec?: EcosystemRuntimeSpec;

  /**
   * Declarative spec for the OSV in-place fix pre-phase.
   * Undefined means no OSV fix preparation is needed for this ecosystem.
   */
  readonly osvFixSpec?: {
    readonly fixLockfile: string;
    readonly backupFiles: readonly string[];
  };

  /**
   * Policy for post-update OSV residual verification.
   * Required — every plugin must declare explicitly.
   */
  readonly postUpdateOsvVerify: 'always' | 'osv-strategy-only' | 'never';

  /**
   * Optional hook: install authorized breaking-change packages after the
   * non-breaking updater phase. Called only when authorizeBreaking=true.
   * Undefined means the plugin handles breaking internally (e.g. composer-updater).
   */
  installBreakingPackages?(args: {
    runner: CommandRunner;
    cwd: string;
    scanResult: ScanResultJson;
    dryRun: boolean;
    fixerStrategy: string;
  }): Promise<{ status: 'success' | 'error'; error?: string } | null>;

  /**
   * Optional file-based runtime version inference for this ecosystem.
   *
   * Reads project files in `cwd` to infer a reasonable runtime version hint
   * (e.g. "20" for Node.js, "8.2" for PHP).
   *
   * Rules:
   * - Must never throw.
   * - Returns `undefined` when no usable version can be inferred.
   * - Async to allow file I/O.
   */
  inferVersion?(cwd: string): Promise<string | undefined>;
}
