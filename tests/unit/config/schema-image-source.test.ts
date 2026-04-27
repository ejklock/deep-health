/**
 * Tests for image_source / dockerfile_path superRefine validation in
 * NpmRunnerConfigSchema, PipRunnerConfigSchema, and ComposerRunnerConfigSchema.
 *
 * Covers the regression cases flagged by Tester:
 *  - image_source='dockerfile' + image set simultaneously (must fail)
 *  - image_source='dockerfile' without dockerfile_path (must fail)
 *  - image_source='pull' (default) with no dockerfile_path (must pass)
 *  - image_source='dockerfile' with dockerfile_path set (must pass)
 */
import { describe, it, expect } from 'vitest';
import { ProjectConfigSchema } from '@infra/config/schema';

/** Minimal valid project config skeleton — only scanners is overridden per test. */
function makeConfig(scanners: Record<string, unknown>): unknown {
  return {
    config_version: '1',
    project: { name: 'Test', client: 'Test' },
    ecosystems: [{ id: 'npm' }],
    protected_packages: { npm: [] },
    safe_update_policy: {
      allow_patch_and_minor_within_constraints: true,
      require_authorization_for_constraint_change: false,
    },
    conflict_resolution: 'manual',
    scanners,
  };
}

describe('ProjectConfigSchema — image_source superRefine validation', () => {
  // ─── npm ───────────────────────────────────────────────────────────────────

  describe('scanners.npm', () => {
    it('passes when image_source is omitted (defaults to pull)', () => {
      const result = ProjectConfigSchema.safeParse(makeConfig({ npm: {} }));
      expect(result.success).toBe(true);
    });

    it('passes when image_source="pull" with no dockerfile_path', () => {
      const result = ProjectConfigSchema.safeParse(
        makeConfig({ npm: { image_source: 'pull' } }),
      );
      expect(result.success).toBe(true);
    });

    it('passes when image_source="dockerfile" with dockerfile_path set', () => {
      const result = ProjectConfigSchema.safeParse(
        makeConfig({ npm: { image_source: 'dockerfile', dockerfile_path: 'Dockerfile' } }),
      );
      expect(result.success).toBe(true);
    });

    it('fails when image_source="dockerfile" and `image` is also set (mutually exclusive)', () => {
      const result = ProjectConfigSchema.safeParse(
        makeConfig({
          npm: {
            image_source: 'dockerfile',
            dockerfile_path: 'Dockerfile',
            image: 'node:20',
          },
        }),
      );
      expect(result.success).toBe(false);
      const messages = result.error?.issues.map((i) => i.message) ?? [];
      expect(messages.some((m) => m.includes('mutually exclusive'))).toBe(true);
    });

    it('fails when image_source="dockerfile" without dockerfile_path', () => {
      const result = ProjectConfigSchema.safeParse(
        makeConfig({ npm: { image_source: 'dockerfile' } }),
      );
      expect(result.success).toBe(false);
      const messages = result.error?.issues.map((i) => i.message) ?? [];
      expect(messages.some((m) => m.includes('dockerfile_path'))).toBe(true);
    });

    it('error message identifies the ecosystem (scanners.npm)', () => {
      const result = ProjectConfigSchema.safeParse(
        makeConfig({ npm: { image_source: 'dockerfile', image: 'node:20', dockerfile_path: 'Dockerfile' } }),
      );
      expect(result.success).toBe(false);
      const messages = result.error?.issues.map((i) => i.message) ?? [];
      expect(messages.some((m) => m.includes('scanners.npm'))).toBe(true);
    });
  });

  // ─── pip ───────────────────────────────────────────────────────────────────

  describe('scanners.pip', () => {
    it('passes when image_source="dockerfile" with dockerfile_path set', () => {
      const result = ProjectConfigSchema.safeParse(
        makeConfig({ pip: { image_source: 'dockerfile', dockerfile_path: '.docker/pip.Dockerfile' } }),
      );
      expect(result.success).toBe(true);
    });

    it('fails when image_source="dockerfile" and `image` is also set', () => {
      const result = ProjectConfigSchema.safeParse(
        makeConfig({
          pip: {
            image_source: 'dockerfile',
            dockerfile_path: 'Dockerfile',
            image: 'python:3.11-slim',
          },
        }),
      );
      expect(result.success).toBe(false);
      const messages = result.error?.issues.map((i) => i.message) ?? [];
      expect(messages.some((m) => m.includes('mutually exclusive'))).toBe(true);
      expect(messages.some((m) => m.includes('scanners.pip'))).toBe(true);
    });

    it('fails when image_source="dockerfile" without dockerfile_path', () => {
      const result = ProjectConfigSchema.safeParse(
        makeConfig({ pip: { image_source: 'dockerfile' } }),
      );
      expect(result.success).toBe(false);
      const messages = result.error?.issues.map((i) => i.message) ?? [];
      expect(messages.some((m) => m.includes('dockerfile_path'))).toBe(true);
    });
  });

  // ─── composer ──────────────────────────────────────────────────────────────

  describe('scanners.composer', () => {
    it('passes when image_source="dockerfile" with dockerfile_path set', () => {
      const result = ProjectConfigSchema.safeParse(
        makeConfig({ composer: { image_source: 'dockerfile', dockerfile_path: '.docker/php.Dockerfile' } }),
      );
      expect(result.success).toBe(true);
    });

    it('fails when image_source="dockerfile" and `image` is also set', () => {
      const result = ProjectConfigSchema.safeParse(
        makeConfig({
          composer: {
            image_source: 'dockerfile',
            dockerfile_path: 'Dockerfile',
            image: 'php:8.2-cli',
          },
        }),
      );
      expect(result.success).toBe(false);
      const messages = result.error?.issues.map((i) => i.message) ?? [];
      expect(messages.some((m) => m.includes('mutually exclusive'))).toBe(true);
      expect(messages.some((m) => m.includes('scanners.composer'))).toBe(true);
    });

    it('fails when image_source="dockerfile" without dockerfile_path', () => {
      const result = ProjectConfigSchema.safeParse(
        makeConfig({ composer: { image_source: 'dockerfile' } }),
      );
      expect(result.success).toBe(false);
      const messages = result.error?.issues.map((i) => i.message) ?? [];
      expect(messages.some((m) => m.includes('dockerfile_path'))).toBe(true);
    });
  });

  // ─── cross-ecosystem isolation ─────────────────────────────────────────────

  it('npm failure does not affect pip or composer when those are valid', () => {
    const result = ProjectConfigSchema.safeParse(
      makeConfig({
        npm: { image_source: 'dockerfile' }, // missing dockerfile_path — invalid
        pip: { image_source: 'pull' },        // valid
      }),
    );
    expect(result.success).toBe(false);
    const messages = result.error?.issues.map((i) => i.message) ?? [];
    // Only npm should have the error
    expect(messages.some((m) => m.includes('scanners.npm'))).toBe(true);
    expect(messages.some((m) => m.includes('scanners.pip'))).toBe(false);
  });
});
