import type { EcosystemPlugin, EcosystemUpdaterContext } from '../types.js';
import type { ProjectConfig, ProtectedPackage } from '@core/types/config.js';
import type { UpdateResultJson } from '@core/types/update.js';
import { runNpmUpdater } from './npm-updater.js';

export const npmPlugin: EcosystemPlugin = {
  id: 'npm',
  name: 'npm',
  lockfiles: ['package.json', 'package-lock.json'],
  osvEcosystems: ['npm'],

  /** Label used in executive report evidence tables */
  reportLabel: 'npm',

  /** Label for the validation section in consolidated reports */
  validationLabel: 'npm build',

  /** Name of the primary ValidationEntry emitted by the npm updater */
  validationName: 'build',

  buildScanArgs(): string[] {
    return ['--lockfile', 'package-lock.json'];
  },

  buildFixCommand(): string {
    return 'osv-scanner fix --strategy=in-place -L package-lock.json';
  },

  isActive(config: ProjectConfig): boolean {
    return !!config.runtime.node;
  },

  getProtectedPackages(config: ProjectConfig): ProtectedPackage[] {
    return config.protected_packages['npm'] ?? [];
  },

  async runUpdater(ctx: EcosystemUpdaterContext): Promise<UpdateResultJson> {
    return runNpmUpdater(ctx.runner, ctx.config, ctx.scanResult, ctx.cwd, ctx.authorizeBreaking);
  },
};
