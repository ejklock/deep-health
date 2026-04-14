import type { CommandRunner } from '@core/types/common';
import type { ProjectConfig, ProtectedPackage, FixerStrategyId, ValidationCommandConfig, AdvisorConfig } from '@core/types/config';
import type { ScanResultJson } from '@core/types/scan';
import type { UpdateResultJson } from '@core/types/update';

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
}
