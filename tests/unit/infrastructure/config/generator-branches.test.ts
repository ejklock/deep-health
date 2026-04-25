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

describe('generateConfigYaml() — composerFrameworkProfile=none → undefined (line 203)', () => {
  it('does not write composerFrameworkProfile when value is "none"', () => {
    const yaml = generateConfigYaml({
      projectName: 'Test',
      client: 'Acme',
      composerFrameworkProfile: 'none',
    });
    expect(typeof yaml).toBe('string');
    // profile 'none' should result in no framework_profile in output (undefined passed to template)
    expect(yaml).not.toContain('framework_profile: none');
  });

  it('writes composerFrameworkProfile when value is a real profile', () => {
    const yaml = generateConfigYaml({
      projectName: 'Test',
      client: 'Acme',
      composerFrameworkProfile: 'laravel',
    });
    expect(typeof yaml).toBe('string');
    expect(yaml).toContain('laravel');
  });
});
