/**
 * Tests for config_version field in ProjectConfigSchema (Task 3.3)
 * and timeout_seconds default in ValidationCommandConfigSchema (Task 3.2).
 *
 * Acceptance criteria:
 *   1. No config_version → passes validation (backward compatible)
 *   2. config_version: '1' → passes validation
 *   3. config_version: '2' → fails with user-friendly message
 *   4. config_version: 'any-other-string' → fails with user-friendly message
 *   5. ValidationCommandConfig parsed without timeout_seconds has timeout_seconds === 300
 */
import { describe, it, expect } from 'vitest';
import { ProjectConfigSchema } from '@infra/config/schema';
import { z } from 'zod';

// Minimal valid ProjectConfig input that satisfies all required fields.
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

// Pull ValidationCommandConfigSchema from ProjectConfigSchema internals via a
// direct import path so the test is self-contained. Since the schema is not
// separately exported, we define an equivalent inline schema that mirrors the
// production schema's timeout_seconds default.
// Instead, we use ProjectConfigSchema with a validationCommands entry to
// verify that the default is applied end-to-end through the full schema.
const configWithValidationCommand = {
  ...minimalConfig,
  ecosystems: [
    {
      id: 'npm',
      validationCommands: [{ name: 'test', command: 'npm test' }],
    },
  ],
};

describe('ProjectConfigSchema — config_version field', () => {
  it('passes when config_version is absent (backward compatible)', () => {
    const result = ProjectConfigSchema.safeParse(minimalConfig);
    expect(result.success).toBe(true);
  });

  it('passes when config_version is "1"', () => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      config_version: '1',
    });
    expect(result.success).toBe(true);
  });

  it('fails when config_version is "2" with a user-friendly message', () => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      config_version: '2',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues[0].message;
      expect(message).toContain('Unsupported config_version "2"');
      expect(message).toContain('deep-health supports config_version "1"');
      expect(message).toContain('deep-health init --force');
    }
  });

  it('fails when config_version is an arbitrary unsupported string', () => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      config_version: 'any-other-string',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues[0].message;
      expect(message).toContain('Unsupported config_version "any-other-string"');
      expect(message).toContain('deep-health supports config_version "1"');
      expect(message).toContain('deep-health init --force');
    }
  });
});

describe('ValidationCommandConfigSchema — timeout_seconds default', () => {
  it('applies default timeout_seconds of 300 when timeout_seconds is absent', () => {
    const result = ProjectConfigSchema.safeParse(configWithValidationCommand);
    expect(result.success).toBe(true);
    if (result.success) {
      const cmd = result.data.ecosystems[0].validationCommands?.[0];
      expect(cmd).toBeDefined();
      expect(cmd?.timeout_seconds).toBe(300);
    }
  });

  it('preserves explicit timeout_seconds when provided', () => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      ecosystems: [
        {
          id: 'npm',
          validationCommands: [{ name: 'test', command: 'npm test', timeout_seconds: 60 }],
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const cmd = result.data.ecosystems[0].validationCommands?.[0];
      expect(cmd?.timeout_seconds).toBe(60);
    }
  });
});
