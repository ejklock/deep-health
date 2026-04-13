// Public API for the ecosystem abstraction layer
export { EcosystemRegistry, defaultRegistry } from './registry.js';
export type { EcosystemPlugin, EcosystemUpdaterContext } from './types.js';
export { npmPlugin } from './plugins/npm.js';
export { composerPlugin } from './plugins/composer.js';

import { defaultRegistry } from './registry.js';
import { npmPlugin } from './plugins/npm.js';
import { composerPlugin } from './plugins/composer.js';

// Register plugins in order: npm first, then composer.
// Registration order is preserved (Map insertion order) — npm phase always runs before composer.
defaultRegistry.register(npmPlugin).register(composerPlugin);
