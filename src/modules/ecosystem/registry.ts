import type { EcosystemPlugin } from './types';

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
