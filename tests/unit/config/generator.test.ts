import { describe, it, expect } from 'vitest';
import { generateConfigYaml } from '@infra/config/generator.js';
import { parse } from 'yaml';
import { ProjectConfigSchema } from '@infra/config/schema.js';

describe('generateConfigYaml', () => {
  it('generates valid YAML that passes schema validation', () => {
    const yaml = generateConfigYaml();
    const parsed = parse(yaml);
    const result = ProjectConfigSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });

  it('uses provided project name and client', () => {
    const yaml = generateConfigYaml({ projectName: 'My App', client: 'ACME Corp' });
    const parsed = parse(yaml) as { project: { name: string; client: string } };
    expect(parsed.project.name).toBe('My App');
    expect(parsed.project.client).toBe('ACME Corp');
  });

  it('uses provided execution mode', () => {
    const yaml = generateConfigYaml({ execution: 'local' });
    const parsed = parse(yaml) as { runtime: { execution: string } };
    expect(parsed.runtime.execution).toBe('local');
  });

  it('uses provided docker service name', () => {
    const yaml = generateConfigYaml({ dockerService: 'web' });
    const parsed = parse(yaml) as { runtime: { docker_service: string } };
    expect(parsed.runtime.docker_service).toBe('web');
  });

  it('includes empty protected_packages arrays with example comments', () => {
    const yaml = generateConfigYaml();
    const parsed = parse(yaml) as {
      protected_packages: { composer: unknown[]; npm: unknown[] };
    };
    expect(Array.isArray(parsed.protected_packages.composer)).toBe(true);
    expect(Array.isArray(parsed.protected_packages.npm)).toBe(true);
    expect(yaml).toContain('# - package:');
  });

  it('includes a header comment', () => {
    const yaml = generateConfigYaml();
    expect(yaml).toContain('# deep-health');
  });

  it('generates valid YAML with custom PHP version', () => {
    const yaml = generateConfigYaml({ phpVersion: '8.3' });
    const parsed = parse(yaml) as { runtime: { php: string } };
    expect(parsed.runtime.php).toBe('8.3');
  });
});
