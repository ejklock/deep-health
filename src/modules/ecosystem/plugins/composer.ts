import type { EcosystemPlugin, EcosystemUpdaterContext } from '../types';
import type { ProjectConfig, ProtectedPackage } from '@core/types/config';
import type { UpdateResultJson } from '@core/types/update';
import { runComposerUpdater } from './composer-updater';

export const composerPlugin: EcosystemPlugin = {
  id: 'composer',
  name: 'Composer',
  lockfiles: ['composer.json', 'composer.lock'],
  // OSV returns 'packagist' for PHP packages; include 'composer' as fallback
  osvEcosystems: ['packagist', 'composer'],

  /** Label used in executive report evidence tables */
  reportLabel: 'PHP/Composer',

  /** Composer does not support osv-scanner fix; osv fixer used as best-effort only */
  supportedFixers: [],

  defaultValidationCommands: [
    { name: 'tests', command: 'php artisan test --compact' },
  ],

  defaultAdvisors: [
    { name: 'audit', command: 'composer audit' },
  ],

  buildScanArgs(): string[] {
    return ['--lockfile', 'composer.lock'];
  },

  getProtectedPackages(config: ProjectConfig): ProtectedPackage[] {
    return config.protected_packages['composer'] ?? [];
  },

  async runUpdater(ctx: EcosystemUpdaterContext): Promise<UpdateResultJson> {
    return runComposerUpdater(
      ctx.runner,
      ctx.config,
      ctx.scanResult,
      ctx.cwd,
      ctx.authorizeBreaking,
      ctx.validationCommands ?? [],
    );
  },
};
