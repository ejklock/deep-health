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

/** Build a config with the given runners block merged in (npm/pip/composer runner configs) */
function makeRunnerConfig(runners: Record<string, unknown>) {
  return { ...minimalConfig, runners };
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
      makeRunnerConfig({ npm: { image } }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects image with shell metacharacter (semicolon)', () => {
    const result = ProjectConfigSchema.safeParse(
      makeRunnerConfig({ npm: { image: 'node:20 ; rm -rf /' } }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects image with leading space', () => {
    const result = ProjectConfigSchema.safeParse(
      makeRunnerConfig({ npm: { image: ' node:20' } }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects image starting with dash (--privileged)', () => {
    const result = ProjectConfigSchema.safeParse(
      makeRunnerConfig({ npm: { image: '--privileged' } }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects image with uppercase character (Node:20)', () => {
    const result = ProjectConfigSchema.safeParse(
      makeRunnerConfig({ npm: { image: 'Node:20' } }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects image with embedded newline', () => {
    const result = ProjectConfigSchema.safeParse(
      makeRunnerConfig({ npm: { image: 'node:20\nmalicious' } }),
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
      runners: { pip: { image } },
    });
    expect(result.success).toBe(true);
  });

  it('rejects image with shell metacharacter', () => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      ecosystems: [{ id: 'pip' }],
      runners: { pip: { image: 'node:20 ; rm -rf /' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects image with uppercase character', () => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      ecosystems: [{ id: 'pip' }],
      runners: { pip: { image: 'Node:20' } },
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
      runners: { composer: { image } },
    });
    expect(result.success).toBe(true);
  });

  it('rejects image with shell metacharacter', () => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      ecosystems: [{ id: 'composer' }],
      runners: { composer: { image: 'node:20 ; rm -rf /' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects image with uppercase character', () => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      ecosystems: [{ id: 'composer' }],
      runners: { composer: { image: 'Node:20' } },
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
      makeRunnerConfig({
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
      makeRunnerConfig({
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
      makeRunnerConfig({
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
      makeRunnerConfig({
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
      makeRunnerConfig({
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
      makeRunnerConfig({
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
      makeRunnerConfig({
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
    'fix/security-scan-',
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

// ---------------------------------------------------------------------------
// Group E — ValidationCommandConfigSchema command length limit
// ---------------------------------------------------------------------------

const command1000 = 'a'.repeat(1000);
const command1001 = 'a'.repeat(1001);

describe('ValidationCommandConfigSchema — command length limit', () => {
  it('fails when command exceeds 1000 characters', () => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      ecosystems: [{ id: 'npm', validationCommands: [{ name: 'test', command: command1001 }] }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message).join(' ')).toMatch(/1000/);
    }
  });

  it('passes when command is exactly 1000 characters', () => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      ecosystems: [{ id: 'npm', validationCommands: [{ name: 'test', command: command1000 }] }],
    });
    expect(result.success).toBe(true);
  });

  it('passes with a normal short command (regression check)', () => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      ecosystems: [{ id: 'npm', validationCommands: [{ name: 'test', command: 'npm test' }] }],
    });
    expect(result.success).toBe(true);
  });
});

describe('AdvisorConfigSchema — command length limit', () => {
  it('fails when command exceeds 1000 characters', () => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      ecosystems: [{ id: 'npm', advisors: [{ name: 'advisor', command: command1001 }] }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message).join(' ')).toMatch(/1000/);
    }
  });

  it('passes when command is exactly 1000 characters', () => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      ecosystems: [{ id: 'npm', advisors: [{ name: 'advisor', command: command1000 }] }],
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group F — project.name / project.client newline injection prevention
// ---------------------------------------------------------------------------

describe('project.name — newline injection prevention', () => {
  it('rejects name with embedded newline', () => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      project: { name: 'foo\nmalicious_key: value', client: 'Client' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects name with carriage return', () => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      project: { name: 'foo\rbar', client: 'Client' },
    });
    expect(result.success).toBe(false);
  });

  it("accepts name with single quote (O'Brien is a valid project name)", () => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      project: { name: "O'Brien", client: 'Client' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects client with embedded newline', () => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      project: { name: 'My Project', client: "Client\ninjected_key: value" },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Group F-2 — ScanPathsConfig path traversal prevention
// ---------------------------------------------------------------------------

describe('ScanPathsConfig — path traversal prevention', () => {
  function makeScanConfig(scan: Record<string, unknown>) {
    return { ...minimalConfig, scan };
  }

  it('accepts valid relative paths (directory and explicit file)', () => {
    const result = ProjectConfigSchema.safeParse(
      makeScanConfig({ paths: ['app/', 'frontend/package-lock.json'] }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects path containing .. segments', () => {
    const result = ProjectConfigSchema.safeParse(
      makeScanConfig({ paths: ['../escape'] }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message).join(' ')).toMatch(/\.\./);
    }
  });

  it('rejects path with leading / (absolute)', () => {
    const result = ProjectConfigSchema.safeParse(
      makeScanConfig({ paths: ['/etc/passwd'] }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message).join(' ')).toMatch(/leading \//);
    }
  });

  it('rejects glob pattern with *', () => {
    const result = ProjectConfigSchema.safeParse(
      makeScanConfig({ paths: ['services/*/lock.json'] }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message).join(' ')).toMatch(/glob/);
    }
  });

  it('rejects glob pattern with ?', () => {
    const result = ProjectConfigSchema.safeParse(
      makeScanConfig({ paths: ['services/?/lock.json'] }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message).join(' ')).toMatch(/glob/);
    }
  });

  it('accepts empty paths array at schema level', () => {
    const result = ProjectConfigSchema.safeParse(
      makeScanConfig({ paths: [] }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts scan config with auto_discover only (no paths)', () => {
    const result = ProjectConfigSchema.safeParse(
      makeScanConfig({ auto_discover: true }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts scan config when scan key is absent entirely', () => {
    const result = ProjectConfigSchema.safeParse(minimalConfig);
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group G — Removed deprecated composer fields
// ---------------------------------------------------------------------------

describe('ComposerRunnerConfig — removed deprecated fields are rejected', () => {
  it('rejects image_strategy in runners.composer (.strict() enforcement)', () => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      ecosystems: [{ id: 'composer' }],
      runners: {
        composer: {
          image_strategy: 'build',
        },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join(' ');
      expect(messages).toMatch(/image_strategy/);
    }
  });

  it('rejects framework_profile in runners.composer (.strict() enforcement)', () => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      ecosystems: [{ id: 'composer' }],
      runners: {
        composer: {
          framework_profile: 'laravel',
        },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join(' ');
      expect(messages).toMatch(/framework_profile/);
    }
  });

  it('rejects both image_strategy and framework_profile together', () => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      ecosystems: [{ id: 'composer' }],
      runners: {
        composer: {
          image_strategy: 'pull',
          framework_profile: 'symfony',
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('still accepts valid composer config without deprecated fields', () => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      ecosystems: [{ id: 'composer' }],
      runners: {
        composer: {
          language_version: '8.2',
          native_deps: ['git', 'unzip'],
        },
      },
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group H — allow_build_context_escape field accepted in all three runners
// ---------------------------------------------------------------------------

describe('allow_build_context_escape — accepted in all ecosystem runner configs', () => {
  it.each(['npm', 'pip', 'composer'] as const)(
    'accepts allow_build_context_escape: true in runners.%s',
    (ecosystem) => {
      const result = ProjectConfigSchema.safeParse({
        ...minimalConfig,
        ecosystems: [{ id: ecosystem }],
        runners: {
          [ecosystem]: {
            image_source: 'dockerfile',
            dockerfile_path: 'Dockerfile',
            allow_build_context_escape: true,
          },
        },
      });
      expect(result.success).toBe(true);
    },
  );

  it.each(['npm', 'pip', 'composer'] as const)(
    'accepts allow_build_context_escape: false in runners.%s',
    (ecosystem) => {
      const result = ProjectConfigSchema.safeParse({
        ...minimalConfig,
        ecosystems: [{ id: ecosystem }],
        runners: {
          [ecosystem]: {
            image_source: 'dockerfile',
            dockerfile_path: 'Dockerfile',
            allow_build_context_escape: false,
          },
        },
      });
      expect(result.success).toBe(true);
    },
  );

  it.each(['npm', 'pip', 'composer'] as const)(
    'accepts omitted allow_build_context_escape (field is optional) in runners.%s',
    (ecosystem) => {
      const result = ProjectConfigSchema.safeParse({
        ...minimalConfig,
        ecosystems: [{ id: ecosystem }],
        runners: {
          [ecosystem]: {
            image_source: 'dockerfile',
            dockerfile_path: 'Dockerfile',
            // allow_build_context_escape deliberately omitted
          },
        },
      });
      expect(result.success).toBe(true);
    },
  );

  it.each(['npm', 'pip', 'composer'] as const)(
    'rejects non-boolean allow_build_context_escape in runners.%s',
    (ecosystem) => {
      const result = ProjectConfigSchema.safeParse({
        ...minimalConfig,
        ecosystems: [{ id: ecosystem }],
        runners: {
          [ecosystem]: {
            image_source: 'dockerfile',
            dockerfile_path: 'Dockerfile',
            allow_build_context_escape: 'yes',
          },
        },
      });
      expect(result.success).toBe(false);
    },
  );
});
