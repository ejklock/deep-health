import type { ProjectConfig } from '@core/types/config.js';
import type { EcosystemPlugin } from './types.js';

export class EcosystemRegistry {
  private readonly plugins = new Map<string, EcosystemPlugin>();

  register(plugin: EcosystemPlugin): this {
    this.plugins.set(plugin.id, plugin);
    return this;
  }

  get(id: string): EcosystemPlugin | undefined {
    return this.plugins.get(id);
  }

  getAll(): EcosystemPlugin[] {
    return [...this.plugins.values()];
  }

  /** Returns only the plugins active for the given project config */
  getActive(config: ProjectConfig): EcosystemPlugin[] {
    return this.getAll().filter((p) => p.isActive(config));
  }

  /**
   * Given an ecosystem string from the OSV JSON output (ex: 'packagist'),
   * returns the matching plugin.
   */
  findByOsvEcosystem(osvEcosystem: string): EcosystemPlugin | undefined {
    const lower = osvEcosystem.toLowerCase();
    return this.getAll().find((p) =>
      p.osvEcosystems.some((e) => e.toLowerCase() === lower),
    );
  }
}

export const defaultRegistry = new EcosystemRegistry();
