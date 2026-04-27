/**
 * Security-focused schema validation tests covering:
 *   - DockerImageRefSchema: injection-safe image references across scanners
 *   - BuildArgsSchema: key/value constraints for docker build arguments
 *   - branch_prefix: valid prefix patterns, no dash-leading values
 *   - folder_id: minimum length and character set
 */
import { describe, it, expect } from 'vitest';
import { ProjectConfigSchema } from '@infra/config/schema';

const minimalConfig = {
  project: { name: 'Test Project', client: 'Test Client' },
  ecosystems: [{ id: 'npm' }],
  protected_packages: {},
  safe_update_policy: {
    allow_patch_and_minor_within_constraints: true,
    require_authorization_for_constraint_change: false,
  },
  conflict_resolution: 'manual',
};

/** Build a config with the given scanners block merged in */
function makeConfig(scanners: Record<string, unknown>) {
  return { ...minimalConfig, scanners };
}

// ---------------------------------------------------------------------------
// Group A — DockerImageRefSchema
// ---------------------------------------------------------------------------

describe('DockerImageRefSchema — scanners.npm.image', () => {
  it.each([
    'node:20',
    'python:3.11-slim',
    'ghcr.io/google/osv-scanner:latest',
    'registry.example.com/org/app:v1.2.3',
    'image@sha256:abc123def456',
  ])('accepts valid image reference: %s', (image) => {
    const result = ProjectConfigSchema.safeParse(
      makeConfig({ npm: { image } }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects image with shell metacharacter (semicolon)', () => {
    const result = ProjectConfigSchema.safeParse(
      makeConfig({ npm: { image: 'node:20 ; rm -rf /' } }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects image with leading space', () => {
    const result = ProjectConfigSchema.safeParse(
      makeConfig({ npm: { image: ' node:20' } }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects image starting with dash (--privileged)', () => {
    const result = ProjectConfigSchema.safeParse(
      makeConfig({ npm: { image: '--privileged' } }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects image with uppercase character (Node:20)', () => {
    const result = ProjectConfigSchema.safeParse(
      makeConfig({ npm: { image: 'Node:20' } }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects image with embedded newline', () => {
    const result = ProjectConfigSchema.safeParse(
      makeConfig({ npm: { image: 'node:20\nmalicious' } }),
    );
    expect(result.success).toBe(false);
  });
});

describe('DockerImageRefSchema — scanners.pip.image', () => {
  it.each([
    'node:20',
    'python:3.11-slim',
    'ghcr.io/google/osv-scanner:latest',
    'registry.example.com/org/app:v1.2.3',
    'image@sha256:abc123def456',
  ])('accepts valid image reference: %s', (image) => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      ecosystems: [{ id: 'pip' }],
      scanners: { pip: { image } },
    });
    expect(result.success).toBe(true);
  });

  it('rejects image with shell metacharacter', () => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      ecosystems: [{ id: 'pip' }],
      scanners: { pip: { image: 'node:20 ; rm -rf /' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects image with uppercase character', () => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      ecosystems: [{ id: 'pip' }],
      scanners: { pip: { image: 'Node:20' } },
    });
    expect(result.success).toBe(false);
  });
});

describe('DockerImageRefSchema — scanners.composer.image', () => {
  it.each([
    'node:20',
    'python:3.11-slim',
    'ghcr.io/google/osv-scanner:latest',
    'registry.example.com/org/app:v1.2.3',
    'image@sha256:abc123def456',
  ])('accepts valid image reference: %s', (image) => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      ecosystems: [{ id: 'composer' }],
      scanners: { composer: { image } },
    });
    expect(result.success).toBe(true);
  });

  it('rejects image with shell metacharacter', () => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      ecosystems: [{ id: 'composer' }],
      scanners: { composer: { image: 'node:20 ; rm -rf /' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects image with uppercase character', () => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      ecosystems: [{ id: 'composer' }],
      scanners: { composer: { image: 'Node:20' } },
    });
    expect(result.success).toBe(false);
  });
});

describe('DockerImageRefSchema — scanners.sonarqube.scanner_image', () => {
  it.each([
    'node:20',
    'python:3.11-slim',
    'ghcr.io/google/osv-scanner:latest',
    'registry.example.com/org/app:v1.2.3',
    'image@sha256:abc123def456',
  ])('accepts valid scanner_image: %s', (scanner_image) => {
    const result = ProjectConfigSchema.safeParse(
      makeConfig({ sonarqube: { scanner_image } }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects scanner_image with shell metacharacter', () => {
    const result = ProjectConfigSchema.safeParse(
      makeConfig({ sonarqube: { scanner_image: 'node:20 ; rm -rf /' } }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects scanner_image starting with dash', () => {
    const result = ProjectConfigSchema.safeParse(
      makeConfig({ sonarqube: { scanner_image: '--privileged' } }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects scanner_image with uppercase character', () => {
    const result = ProjectConfigSchema.safeParse(
      makeConfig({ sonarqube: { scanner_image: 'Node:20' } }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects scanner_image with embedded newline', () => {
    const result = ProjectConfigSchema.safeParse(
      makeConfig({ sonarqube: { scanner_image: 'node:20\nmalicious' } }),
    );
    expect(result.success).toBe(false);
  });
});

describe('DockerImageRefSchema — scanners.osv.image', () => {
  it.each([
    'node:20',
    'python:3.11-slim',
    'ghcr.io/google/osv-scanner:latest',
    'registry.example.com/org/app:v1.2.3',
    'image@sha256:abc123def456',
  ])('accepts valid image reference: %s', (image) => {
    const result = ProjectConfigSchema.safeParse(
      makeConfig({ osv: { image } }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects image with shell metacharacter', () => {
    const result = ProjectConfigSchema.safeParse(
      makeConfig({ osv: { image: 'node:20 ; rm -rf /' } }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects image with leading space', () => {
    const result = ProjectConfigSchema.safeParse(
      makeConfig({ osv: { image: ' node:20' } }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects image starting with dash', () => {
    const result = ProjectConfigSchema.safeParse(
      makeConfig({ osv: { image: '--privileged' } }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects image with uppercase character', () => {
    const result = ProjectConfigSchema.safeParse(
      makeConfig({ osv: { image: 'Node:20' } }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects image with embedded newline', () => {
    const result = ProjectConfigSchema.safeParse(
      makeConfig({ osv: { image: 'node:20\nmalicious' } }),
    );
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Group B — build_args validation
// ---------------------------------------------------------------------------

describe('build_args — valid key/value pairs', () => {
  it('accepts uppercase keys with alphanumeric values', () => {
    const result = ProjectConfigSchema.safeParse(
      makeConfig({
        npm: {
          image_source: 'dockerfile',
          dockerfile_path: 'Dockerfile',
          build_args: { NODE_VERSION: '20', APP_ENV: 'production' },
        },
      }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts keys starting with underscore', () => {
    const result = ProjectConfigSchema.safeParse(
      makeConfig({
        npm: {
          image_source: 'dockerfile',
          dockerfile_path: 'Dockerfile',
          build_args: { _PRIVATE: 'value' },
        },
      }),
    );
    expect(result.success).toBe(true);
  });
});

describe('build_args — invalid keys', () => {
  it('rejects lowercase key', () => {
    const result = ProjectConfigSchema.safeParse(
      makeConfig({
        npm: {
          image_source: 'dockerfile',
          dockerfile_path: 'Dockerfile',
          build_args: { lower_key: 'val' },
        },
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects key with space', () => {
    const result = ProjectConfigSchema.safeParse(
      makeConfig({
        npm: {
          image_source: 'dockerfile',
          dockerfile_path: 'Dockerfile',
          build_args: { 'KEY SPACE': 'val' },
        },
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects key starting with digit', () => {
    const result = ProjectConfigSchema.safeParse(
      makeConfig({
        npm: {
          image_source: 'dockerfile',
          dockerfile_path: 'Dockerfile',
          build_args: { '123KEY': 'val' },
        },
      }),
    );
    expect(result.success).toBe(false);
  });
});

describe('build_args — invalid values', () => {
  it('rejects value containing newline', () => {
    const result = ProjectConfigSchema.safeParse(
      makeConfig({
        npm: {
          image_source: 'dockerfile',
          dockerfile_path: 'Dockerfile',
          build_args: { KEY: 'val\ninjected' },
        },
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects value containing carriage return', () => {
    const result = ProjectConfigSchema.safeParse(
      makeConfig({
        npm: {
          image_source: 'dockerfile',
          dockerfile_path: 'Dockerfile',
          build_args: { KEY: 'val\rinjected' },
        },
      }),
    );
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Group C — branch_prefix validation
// ---------------------------------------------------------------------------

describe('branch_prefix validation', () => {
  it.each([
    'fix/deep-health-',
    'feat/',
    'my-prefix/',
  ])('accepts valid branch_prefix: %s', (branch_prefix) => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      workflow: { branch_prefix },
    });
    expect(result.success).toBe(true);
  });

  it('rejects branch_prefix starting with a dash (-fix/)', () => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      workflow: { branch_prefix: '-fix/' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects branch_prefix starting with double-dash (--option)', () => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      workflow: { branch_prefix: '--option' },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Group D — folder_id validation
// ---------------------------------------------------------------------------

describe('folder_id validation', () => {
  it.each([
    'AbCdEfGhIjKl',
    'folder-id_1234567890',
  ])('accepts valid folder_id: %s', (folder_id) => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      cloud_storage: { provider: 'google_drive', folder_id },
    });
    expect(result.success).toBe(true);
  });

  it('rejects folder_id shorter than 10 characters', () => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      cloud_storage: { provider: 'google_drive', folder_id: 'short' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects folder_id containing a space', () => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      cloud_storage: { provider: 'google_drive', folder_id: 'has space123' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects folder_id containing an at-sign', () => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      cloud_storage: { provider: 'google_drive', folder_id: 'has@symbol12' },
    });
    expect(result.success).toBe(false);
  });
});
