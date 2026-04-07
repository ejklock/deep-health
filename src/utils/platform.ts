import os from 'node:os';

/**
 * Returns the current operating system platform string.
 * Wraps os.platform() for testability.
 */
export function getPlatform(): NodeJS.Platform {
  return os.platform();
}

/**
 * Returns a human-readable OS category for display purposes.
 */
export function getPlatformLabel(): string {
  const platform = getPlatform();
  if (platform === 'darwin') return 'macOS';
  if (platform === 'win32') return 'Windows';
  return 'Linux';
}

/**
 * Known tools with platform-specific install hints.
 * Add entries here as new scanner engines are introduced.
 */
const installHints: Record<string, Partial<Record<NodeJS.Platform | 'default', string>>> = {
  'osv-scanner': {
    darwin: 'Install with: brew install osv-scanner',
    linux: 'Download from: https://github.com/google/osv-scanner/releases',
    win32: 'Download from: https://github.com/google/osv-scanner/releases',
    default: 'See: https://github.com/google/osv-scanner',
  },
};

/**
 * Returns a platform-appropriate install hint for the given tool.
 * Falls back to the 'default' hint if no platform-specific hint exists.
 * Returns an empty string if no hint is registered for the tool.
 */
export function getPlatformInstallHint(toolId: string): string {
  const hints = installHints[toolId];
  if (!hints) return '';
  const platform = getPlatform();
  return hints[platform] ?? hints['default'] ?? '';
}
