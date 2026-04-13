import type { ScannerEngine } from './types';

/**
 * Registry for ScannerEngine implementations.
 *
 * Engines are registered in priority order (first-registered = first-executed).
 * Additional engines can be registered without modifying existing code.
 */
export class ScannerEngineRegistry {
  private engines: Map<string, ScannerEngine> = new Map();
  private order: string[] = [];

  /**
   * Register a scanner engine.
   * If an engine with the same id is already registered, it is replaced in-place.
   */
  register(engine: ScannerEngine): void {
    if (!this.engines.has(engine.id)) {
      this.order.push(engine.id);
    }
    this.engines.set(engine.id, engine);
  }

  /**
   * Return all registered engines in registration order.
   */
  getAll(): ScannerEngine[] {
    return this.order.map((id) => this.engines.get(id)!);
  }

  /**
   * Return a single engine by id, or undefined if not found.
   */
  get(id: string): ScannerEngine | undefined {
    return this.engines.get(id);
  }

  /**
   * Return true if an engine with this id is registered.
   */
  has(id: string): boolean {
    return this.engines.has(id);
  }
}

/**
 * Shared default scanner registry.
 * Engines are registered via side-effects in src/modules/scanner/index.ts.
 */
export const defaultScannerRegistry = new ScannerEngineRegistry();
