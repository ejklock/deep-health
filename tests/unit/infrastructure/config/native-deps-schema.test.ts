/**
 * Tests for native_deps field in NpmRunnerConfigSchema, PipRunnerConfigSchema,
 * and ComposerRunnerConfigSchema — part of PR 2 (native OS deps support).
 *
 * Verifies:
 *   - Valid Debian package names are accepted
 *   - Package names with shell metacharacters are rejected
 *   - native_deps is optional (omitting it keeps existing behavior)
 *   - All three ecosystems (npm, pip, composer) accept the field
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

describe('native_deps schema — NpmRunnerConfig', () => {
  it('accepts valid Debian package names', () => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      runners: {
        npm: { native_deps: ['libvips-dev', 'build-essential', 'python3'] },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts package names with dots and plus signs', () => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      runners: {
        npm: { native_deps: ['ca-certificates', 'libssl1.0-dev', 'g++'] },
      },
    });
    expect(result.success).toBe(true);
  });

  it('is optional — absent native_deps does not break parsing', () => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      runners: { npm: { language_version: '14' } },
    });
    expect(result.success).toBe(true);
  });

  it('rejects package names with semicolons (shell injection vector)', () => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      runners: {
        npm: { native_deps: ['libvips-dev; rm -rf /'] },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects package names with dollar signs', () => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      runners: { npm: { native_deps: ['$HOME'] } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects package names with backticks', () => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      runners: { npm: { native_deps: ['`cmd`'] } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects uppercase package names (Debian convention)', () => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      runners: { npm: { native_deps: ['LibVips-Dev'] } },
    });
    expect(result.success).toBe(false);
  });
});

describe('native_deps schema — PipRunnerConfig', () => {
  it('accepts valid Debian package names for pip', () => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      ecosystems: [{ id: 'pip' }],
      runners: {
        pip: { native_deps: ['libjpeg-dev', 'libpq-dev'] },
      },
    });
    expect(result.success).toBe(true);
  });
});

describe('native_deps schema — ComposerRunnerConfig', () => {
  it('accepts valid Debian package names for composer', () => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      ecosystems: [{ id: 'composer' }],
      runners: {
        composer: { native_deps: ['imagemagick', 'libmagickwand-dev'] },
      },
    });
    expect(result.success).toBe(true);
  });
});
