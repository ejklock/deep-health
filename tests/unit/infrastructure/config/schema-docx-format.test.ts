/**
 * Tests that OutputFormatSchema accepts 'docx' as a valid enum value.
 * AC1: OutputFormat type includes 'docx'; OutputFormatSchema validates 'docx'.
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

describe('OutputFormatSchema accepts docx', () => {
  it('accepts markdown as a valid format', () => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      outputs: { formats: ['markdown'] },
    });
    expect(result.success).toBe(true);
  });

  it('accepts docx as a valid format', () => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      outputs: { formats: ['docx'] },
    });
    expect(result.success).toBe(true);
  });

  it('accepts both markdown and docx simultaneously', () => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      outputs: { formats: ['markdown', 'docx'] },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown format', () => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      outputs: { formats: ['pdf'] },
    });
    expect(result.success).toBe(false);
  });

  it('accepts an empty formats array', () => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      outputs: { formats: [] },
    });
    expect(result.success).toBe(true);
  });

  it('accepts outputs block with only docx and a dir', () => {
    const result = ProjectConfigSchema.safeParse({
      ...minimalConfig,
      outputs: { formats: ['docx'], dir: 'reports' },
    });
    expect(result.success).toBe(true);
  });
});
