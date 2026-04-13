import type { CommandRunner } from '@core/types/common';
import type { ProjectConfig, ProtectedPackage } from '@core/types/config';
import type { ScanResultJson } from '@core/types/scan';
import type { UpdateResultJson } from '@core/types/update';

export interface EcosystemUpdaterContext {
  runner: CommandRunner;
  config: ProjectConfig;
  scanResult: ScanResultJson;
  cwd: string;
  authorizeBreaking: boolean;
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
   * Human-readable label for the validation section in consolidated reports.
   * Ex: 'PHP test suite', 'npm build'
   */
  readonly validationLabel: string;

  /**
   * The `name` value of the primary ValidationEntry in UpdateResultJson.validations[]
   * that this plugin emits. Used by reports to locate the relevant validation entry.
   * Ex: 'tests' for composer, 'build' for npm.
   */
  readonly validationName: string;

  /** Additional args for `osv-scanner` (ex: ['--lockfile', 'composer.lock']) */
  buildScanArgs(): string[];

  /**
   * Auto-fix command (osv-scanner fix), if supported.
   * Returns null if the ecosystem has no automatic fix.
   */
  buildFixCommand(): string | null;

  /** Whether this plugin is active for the given project config */
  isActive(config: ProjectConfig): boolean;

  /** Protected packages for this ecosystem in the project config */
  getProtectedPackages(config: ProjectConfig): ProtectedPackage[];

  /** Runs the update phase for this ecosystem */
  runUpdater(ctx: EcosystemUpdaterContext): Promise<UpdateResultJson>;
}
