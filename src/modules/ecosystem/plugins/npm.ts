import type { EcosystemPlugin, EcosystemUpdaterContext } from '../types';
import type { ProjectConfig, ProtectedPackage } from '@core/types/config';
import type { UpdateResultJson } from '@core/types/update';
import { runNpmUpdater } from './npm-updater';

export const npmPlugin: EcosystemPlugin = {
  id: 'npm',
  name: 'npm',
  lockfiles: ['package.json', 'package-lock.json'],
  osvEcosystems: ['npm'],

  /** Label used in executive report evidence tables */
  reportLabel: 'npm',

  supportedFixers: ['osv', 'npm-audit'],

  defaultValidationCommands: [
    { name: 'build', command: 'npm run build' },
  ],

  defaultAdvisors: [
    { name: 'audit', command: 'npm audit' },
  ],

  buildScanArgs(): string[] {
    return ['--lockfile', 'package-lock.json'];
  },

  getProtectedPackages(config: ProjectConfig): ProtectedPackage[] {
    return config.protected_packages['npm'] ?? [];
  },

  async runUpdater(ctx: EcosystemUpdaterContext): Promise<UpdateResultJson> {
    return runNpmUpdater(
      ctx.runner,
      ctx.config,
      ctx.scanResult,
      ctx.cwd,
      ctx.authorizeBreaking,
      ctx.validationCommands ?? [],
      ctx.fixerStrategy ?? 'osv',
    );
  },
};
