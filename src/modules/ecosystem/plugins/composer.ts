import type { EcosystemPlugin, EcosystemUpdaterContext } from '../types.js';
import type { ProjectConfig, ProtectedPackage } from '@core/types/config.js';
import type { UpdateResultJson } from '@core/types/update.js';
import { runComposerUpdater } from './composer-updater.js';

export const composerPlugin: EcosystemPlugin = {
  id: 'composer',
  name: 'Composer',
  lockfiles: ['composer.json', 'composer.lock'],
  // OSV returns 'packagist' for PHP packages; include 'composer' as fallback
  osvEcosystems: ['packagist', 'composer'],

  /** Label used in executive report evidence tables */
  reportLabel: 'PHP/Composer',

  /** Label for the validation section in consolidated reports */
  validationLabel: 'PHP test suite',

  /** Name of the primary ValidationEntry emitted by the composer updater */
  validationName: 'tests',

  buildScanArgs(): string[] {
    return ['--lockfile', 'composer.lock'];
  },

  buildFixCommand(): null {
    // osv-scanner fix does not support Composer
    return null;
  },

  isActive(config: ProjectConfig): boolean {
    return !!config.runtime.php;
  },

  getProtectedPackages(config: ProjectConfig): ProtectedPackage[] {
    return config.protected_packages['composer'] ?? [];
  },

  async runUpdater(ctx: EcosystemUpdaterContext): Promise<UpdateResultJson> {
    return runComposerUpdater(ctx.runner, ctx.config, ctx.scanResult, ctx.cwd, ctx.authorizeBreaking);
  },
};
