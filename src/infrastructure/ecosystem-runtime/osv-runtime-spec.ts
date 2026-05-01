import { OSV_DEFAULT_IMAGE } from '../utils/osv-commands';
import type { EcosystemRuntimeSpec } from './types';

/**
 * EcosystemRuntimeSpec for osv-scanner.
 *
 * Runs osv-scanner in an ephemeral container with the project directory
 * mounted read-only. Used by resolveOsvEcosystemRunner() for residual
 * vulnerability verification.
 */
export const osvRuntimeSpec: EcosystemRuntimeSpec = {
  defaultImage: OSV_DEFAULT_IMAGE,
  resolveImage: (_version) => OSV_DEFAULT_IMAGE,
  containerBinaries: ['osv-scanner'],
  mountReadonly: true,
  runMode: {
    kind: 'direct-exec',
    binary: 'osv-scanner',
  },
};
