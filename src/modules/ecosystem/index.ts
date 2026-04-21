// Public API for the ecosystem abstraction layer
export { EcosystemRegistry, defaultRegistry } from './registry';
export type { EcosystemPlugin, EcosystemUpdaterContext } from './types';
export { npmPlugin } from './plugins/npm';
export { composerPlugin } from './plugins/composer';
export { pipPlugin } from './plugins/pip';

import { defaultRegistry } from './registry';
import { npmPlugin } from './plugins/npm';
import { composerPlugin } from './plugins/composer';
import { pipPlugin } from './plugins/pip';

// Register plugins in order: npm first, then composer, then pip.
// Registration order is preserved (Map insertion order) — npm phase always runs before composer.
defaultRegistry.register(npmPlugin).register(composerPlugin).register(pipPlugin);
