/**
 * Branch coverage top-up for src/infrastructure/config/generator.ts
 * Targets:
 *   lines 176-179: unknown ecosystem id → falls into ECOSYSTEM_EXAMPLES[id] ?? fallback object
 *   line 203: composerFrameworkProfile === 'none' → undefined (no profile written)
 */
import { describe, it, expect } from 'vitest';
import { generateConfigYaml } from '@infra/config/generator';

describe('generateConfigYaml() — unknown ecosystem fallback (lines 176-179)', () => {
  it('uses generic fallback examples when ecosystem id is not in ECOSYSTEM_EXAMPLES', () => {
    const yaml = generateConfigYaml({
      projectName: 'Test',
      client: 'Acme',
      ecosystemConfigs: [
        { id: 'ruby', fixerStrategy: 'bundler' }, // 'ruby' is not in ECOSYSTEM_EXAMPLES
      ],
    });
    expect(typeof yaml).toBe('string');
    // The fallback example package should appear
    expect(yaml).toContain('example/package');
  });
});

describe('generateConfigYaml() — framework_profile removed (ADR-0004)', () => {
  it('never writes framework_profile to generated YAML (field removed in ADR-0004)', () => {
    const yaml = generateConfigYaml({
      projectName: 'Test',
      client: 'Acme',
    });
    expect(typeof yaml).toBe('string');
    expect(yaml).not.toContain('framework_profile');
    expect(yaml).not.toContain('image_strategy');
  });
});
