import { describe, it, expect } from 'vitest';
import { generateConfigYaml, normalizeSonarProjectKey } from '@infra/config/generator';
import { parse } from 'yaml';
import { ProjectConfigSchema } from '@infra/config/schema';

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

  it('includes empty protected_packages arrays with example comments', () => {
    const yaml = generateConfigYaml();
    const parsed = parse(yaml) as {
      protected_packages: { composer: unknown[]; npm: unknown[]; pip: unknown[] };
    };
    expect(Array.isArray(parsed.protected_packages.composer)).toBe(true);
    expect(Array.isArray(parsed.protected_packages.npm)).toBe(true);
    expect(Array.isArray(parsed.protected_packages.pip)).toBe(true);
    expect(yaml).toContain('# - package:');
  });

  it('includes a header comment', () => {
    const yaml = generateConfigYaml();
    expect(yaml).toContain('# deep-health');
  });

  it('generates valid YAML with custom PHP version reflected in ecosystems via ecosystemConfigs', () => {
    const yaml = generateConfigYaml({
      ecosystemConfigs: [
        {
          id: 'composer',
          validationCommands: [{ name: 'tests', command: 'php artisan test --compact' }],
          advisors: [{ name: 'audit', command: 'composer audit' }],
        },
      ],
    });
    const parsed = parse(yaml) as { ecosystems: Array<{ id: string }> };
    const composer = parsed.ecosystems.find((e) => e.id === 'composer');
    expect(composer).toBeDefined();
  });

  it('includes ecosystems[] with at least one entry by default', () => {
    const yaml = generateConfigYaml();
    const parsed = parse(yaml) as { ecosystems: unknown[] };
    expect(Array.isArray(parsed.ecosystems)).toBe(true);
    expect(parsed.ecosystems.length).toBeGreaterThanOrEqual(1);
  });

  it('defaults npm fixer to "osv" in generated config', () => {
    const yaml = generateConfigYaml();
    const parsed = parse(yaml) as { ecosystems: Array<{ id: string; fixer?: string }> };
    const npm = parsed.ecosystems.find((e) => e.id === 'npm');
    expect(npm).toBeDefined();
    expect(npm?.fixer).toBe('osv');
  });

  it('includes both composer and npm ecosystems when both provided via ecosystemConfigs', () => {
    const yaml = generateConfigYaml({
      ecosystemConfigs: [
        {
          id: 'composer',
          validationCommands: [{ name: 'tests', command: 'php artisan test --compact' }],
          advisors: [{ name: 'audit', command: 'composer audit' }],
        },
        {
          id: 'npm',
          fixerStrategy: 'npm-audit',
          validationCommands: [{ name: 'build', command: 'npm run build' }],
          advisors: [{ name: 'audit', command: 'npm audit' }],
        },
      ],
    });
    const parsed = parse(yaml) as { ecosystems: Array<{ id: string }> };
    const ids = parsed.ecosystems.map((e) => e.id);
    expect(ids).toContain('composer');
    expect(ids).toContain('npm');
  });

  it('includes markdown in outputs.formats when enableSonarQube and ecosystemConfigs provided', () => {
    const yaml = generateConfigYaml({
      enableSonarQube: true,
      outputs: { formats: ['markdown'], dir: '.deep-health/reports' },
      ecosystemConfigs: [{ id: 'npm', fixerStrategy: 'npm-audit' }],
    });
    const parsed = parse(yaml) as { outputs?: { formats?: string[] } };
    expect(parsed.outputs?.formats).toContain('markdown');
    // 'sonarqube' is not an output format — it is not a toggle in formats
    expect(parsed.outputs?.formats).not.toContain('sonarqube');
  });

  it('includes pip ecosystem entry when specified in ecosystemConfigs', () => {
    const yaml = generateConfigYaml({
      ecosystemConfigs: [
        {
          id: 'pip',
          validationCommands: [{ name: 'check', command: 'pip check' }],
          advisors: [{ name: 'audit', command: 'pip-audit' }],
        },
      ],
    });
    const parsed = parse(yaml) as { ecosystems: Array<{ id: string }> };
    const pip = parsed.ecosystems.find((e) => e.id === 'pip');
    expect(pip).toBeDefined();
  });

  it('always emits pip: [] in protected_packages even when pip not in ecosystemConfigs', () => {
    const yaml = generateConfigYaml({
      ecosystemConfigs: [{ id: 'npm', fixerStrategy: 'osv' }],
    });
    const parsed = parse(yaml) as { protected_packages: Record<string, unknown[]> };
    expect(Array.isArray(parsed.protected_packages['pip'])).toBe(true);
  });

  it('passes schema validation when pipLanguageVersion provided (no sonarqube)', () => {
    const yaml = generateConfigYaml({
      pipLanguageVersion: '3.11',
      ecosystemConfigs: [{ id: 'pip' }],
    });
    const parsed = parse(yaml);
    const result = ProjectConfigSchema.safeParse(parsed);
    // runners block is no longer generated — per-ecosystem runner config is the new pattern
    expect(result.success).toBe(true);
  });

  it('passes schema validation when both npmLanguageVersion and pipLanguageVersion provided', () => {
    const yaml = generateConfigYaml({
      npmLanguageVersion: '20',
      pipLanguageVersion: '3.11',
      ecosystemConfigs: [{ id: 'npm' }, { id: 'pip' }],
    });
    const parsed = parse(yaml);
    const result = ProjectConfigSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });

  it('passes schema validation when composerLanguageVersion provided (without SonarQube)', () => {
    const yaml = generateConfigYaml({
      composerLanguageVersion: '8.2',
      ecosystemConfigs: [{ id: 'composer' }],
    });
    const parsed = parse(yaml);
    const result = ProjectConfigSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });

  it('passes schema validation when npm + pip + composer languageVersions provided together', () => {
    const yaml = generateConfigYaml({
      npmLanguageVersion: '20',
      pipLanguageVersion: '3.11',
      composerLanguageVersion: '8.3',
      ecosystemConfigs: [{ id: 'npm' }, { id: 'pip' }, { id: 'composer' }],
    });
    const parsed = parse(yaml);
    const result = ProjectConfigSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });
});

describe('normalizeSonarProjectKey', () => {
  it('returns already-valid keys unchanged (idempotent)', () => {
    expect(normalizeSonarProjectKey('my-project')).toBe('my-project');
    expect(normalizeSonarProjectKey('org:my-project')).toBe('org:my-project');
    expect(normalizeSonarProjectKey('My_Project.v2')).toBe('My_Project.v2');
    expect(normalizeSonarProjectKey('ACME-CORP_123')).toBe('ACME-CORP_123');
  });

  it('replaces spaces with hyphens', () => {
    expect(normalizeSonarProjectKey('My App')).toBe('My-App');
    expect(normalizeSonarProjectKey('My  App')).toBe('My-App');
  });

  it('replaces invalid characters with hyphens', () => {
    expect(normalizeSonarProjectKey('My App!')).toBe('My-App');
    expect(normalizeSonarProjectKey('hello world@2024')).toBe('hello-world-2024');
  });

  it('collapses consecutive hyphens', () => {
    expect(normalizeSonarProjectKey('a  b  c')).toBe('a-b-c');
    expect(normalizeSonarProjectKey('a--b')).toBe('a-b');
  });

  it('strips leading and trailing hyphens', () => {
    expect(normalizeSonarProjectKey('!My Project!')).toBe('My-Project');
    expect(normalizeSonarProjectKey('-project-')).toBe('project');
  });

  it('falls back to my-project for empty or whitespace-only input', () => {
    expect(normalizeSonarProjectKey('')).toBe('my-project');
    expect(normalizeSonarProjectKey('   ')).toBe('my-project');
    expect(normalizeSonarProjectKey('!!!')).toBe('my-project');
  });

  it('generated config with enableSonarQube=true passes schema validation (no project_key in config anymore)', () => {
    // project_key moved to sonar-project.properties — config.yml only contains
    // CLI-layer fields. Still worth a round-trip check to confirm the template
    // emits valid YAML + a valid sonarqube block when the flag is on.
    const yaml = generateConfigYaml({
      projectName: 'My Project',
      enableSonarQube: true,
      ecosystemConfigs: [{ id: 'npm', fixerStrategy: 'npm-audit' }],
    });
    const parsed = parse(yaml);
    const result = ProjectConfigSchema.safeParse(parsed);
    expect(result.success).toBe(true);

    const sonarBlock = (parsed as { scanners?: { sonarqube?: Record<string, unknown> } })
      .scanners?.sonarqube;
    expect(sonarBlock).toBeDefined();
    expect(sonarBlock).toHaveProperty('enabled', true);
    expect(sonarBlock).toHaveProperty('mode', 'managed');
    // Removed fields must NOT leak into generated config.
    expect(sonarBlock).not.toHaveProperty('project_key');
    expect(sonarBlock).not.toHaveProperty('host_url');
    expect(sonarBlock).not.toHaveProperty('token_env');
    expect(sonarBlock).not.toHaveProperty('exclusions');
  });

  it('project names with special chars still produce valid YAML when enableSonarQube=true', () => {
    const yaml = generateConfigYaml({
      projectName: 'My App (v2)!',
      enableSonarQube: true,
      ecosystemConfigs: [{ id: 'npm' }],
    });
    const parsed = parse(yaml);
    const result = ProjectConfigSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });

  it('defaults sonarQubeMode to managed when enableSonarQube=true and no mode provided', () => {
    const yaml = generateConfigYaml({
      projectName: 'My Project',
      enableSonarQube: true,
      ecosystemConfigs: [{ id: 'npm', fixerStrategy: 'npm-audit' }],
    });
    const parsed = parse(yaml) as { scanners?: { sonarqube?: Record<string, unknown> } };
    expect(parsed.scanners?.sonarqube?.mode).toBe('managed');
  });

  it('emits mode: external when sonarQubeMode is external', () => {
    const yaml = generateConfigYaml({
      projectName: 'External Sonar Project',
      enableSonarQube: true,
      sonarQubeMode: 'external',
      ecosystemConfigs: [{ id: 'npm', fixerStrategy: 'npm-audit' }],
    });
    const parsed = parse(yaml) as { scanners?: { sonarqube?: Record<string, unknown> } };
    expect(parsed.scanners?.sonarqube?.mode).toBe('external');
  });

  it('generated config with sonarQubeMode external passes schema validation', () => {
    const yaml = generateConfigYaml({
      projectName: 'External Sonar Project',
      enableSonarQube: true,
      sonarQubeMode: 'external',
      ecosystemConfigs: [{ id: 'npm' }],
    });
    const parsed = parse(yaml);
    const result = ProjectConfigSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });
});

describe('generateConfigYaml — dockerfile image_source options', () => {
  it('generated config with npmImageSource="dockerfile" passes schema validation', () => {
    const yaml = generateConfigYaml({
      npmLanguageVersion: '20',
      npmImageSource: 'dockerfile',
      npmDockerfilePath: 'Dockerfile',
      ecosystemConfigs: [{ id: 'npm' }],
    });
    const parsed = parse(yaml);
    const result = ProjectConfigSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });

  it('generated config with npmImageSource absent passes schema validation', () => {
    const yaml = generateConfigYaml({
      npmLanguageVersion: '20',
      ecosystemConfigs: [{ id: 'npm' }],
    });
    const parsed = parse(yaml);
    const result = ProjectConfigSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });

  it('generated config with pipImageSource="dockerfile" passes schema validation', () => {
    const yaml = generateConfigYaml({
      pipLanguageVersion: '3.11',
      pipImageSource: 'dockerfile',
      pipDockerfilePath: 'Dockerfile',
      ecosystemConfigs: [{ id: 'pip' }],
    });
    const parsed = parse(yaml);
    const result = ProjectConfigSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });

  it('generated config with composerImageSource="dockerfile" passes schema validation', () => {
    const yaml = generateConfigYaml({
      composerLanguageVersion: '8.2',
      composerImageSource: 'dockerfile',
      composerDockerfilePath: '.docker/php.Dockerfile',
      ecosystemConfigs: [{ id: 'composer' }],
    });
    const parsed = parse(yaml);
    const result = ProjectConfigSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });

  it('generated config with build_context and build_args passes schema validation', () => {
    const yaml = generateConfigYaml({
      npmLanguageVersion: '20',
      npmImageSource: 'dockerfile',
      npmDockerfilePath: 'Dockerfile',
      npmBuildContext: '.',
      npmBuildArgs: { NODE_ENV: 'test' },
      ecosystemConfigs: [{ id: 'npm' }],
    });
    const parsed = parse(yaml);
    const result = ProjectConfigSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });

  it('generated config with pip build_context and build_args passes schema validation', () => {
    const yaml = generateConfigYaml({
      pipLanguageVersion: '3.11',
      pipImageSource: 'dockerfile',
      pipDockerfilePath: 'Dockerfile',
      pipBuildContext: '.',
      pipBuildArgs: { PYTHON_VERSION: '3.11' },
      ecosystemConfigs: [{ id: 'pip' }],
    });
    const parsed = parse(yaml);
    const result = ProjectConfigSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });

  it('generated config with composer build_context and build_args passes schema validation', () => {
    const yaml = generateConfigYaml({
      composerLanguageVersion: '8.2',
      composerImageSource: 'dockerfile',
      composerDockerfilePath: '.docker/php.Dockerfile',
      composerBuildContext: '.docker/',
      composerBuildArgs: { PHP_VERSION: '8.2' },
      ecosystemConfigs: [{ id: 'composer' }],
    });
    const parsed = parse(yaml);
    const result = ProjectConfigSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });
});

describe('generateConfigYaml — empty validationCommands', () => {
  it('emits validationCommands: [] and keeps advisors on its own line when validationCommands is empty', () => {
    const yaml = generateConfigYaml({
      ecosystemConfigs: [
        {
          id: 'composer',
          validationCommands: [],
          advisors: [{ name: 'audit', command: 'composer audit' }],
        },
      ],
    });

    // (a) YAML must parse successfully
    const parsed = parse(yaml) as { ecosystems: Array<{ id: string; validationCommands?: unknown[]; advisors?: Array<{ name: string; command: string }> }> };

    // (b) validationCommands must be an empty array
    const composer = parsed.ecosystems.find((e) => e.id === 'composer');
    expect(composer).toBeDefined();
    expect(Array.isArray(composer?.validationCommands)).toBe(true);
    expect(composer?.validationCommands).toHaveLength(0);

    // (c) advisors must be present with the audit entry
    expect(Array.isArray(composer?.advisors)).toBe(true);
    expect(composer?.advisors).toHaveLength(1);
    expect(composer?.advisors?.[0]).toEqual({ name: 'audit', command: 'composer audit' });
  });

  it('emits validationCommands: [] for npm with empty validationCommands and advisors present', () => {
    const yaml = generateConfigYaml({
      ecosystemConfigs: [
        {
          id: 'npm',
          validationCommands: [],
          advisors: [{ name: 'audit', command: 'npm audit' }],
        },
      ],
    });

    const parsed = parse(yaml) as { ecosystems: Array<{ id: string; validationCommands?: unknown[]; advisors?: unknown[] }> };
    const npm = parsed.ecosystems.find((e) => e.id === 'npm');
    expect(npm?.validationCommands).toEqual([]);
    expect(npm?.advisors).toHaveLength(1);
  });

  it('generated YAML with empty validationCommands passes schema validation', () => {
    const yaml = generateConfigYaml({
      ecosystemConfigs: [
        {
          id: 'composer',
          validationCommands: [],
          advisors: [{ name: 'audit', command: 'composer audit' }],
        },
      ],
    });
    const parsed = parse(yaml);
    const result = ProjectConfigSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });
});

describe('generateConfigYaml — single-quote YAML injection prevention', () => {
  it("escapes single quotes in project name (O'Brien → O''Brien in YAML)", () => {
    const yaml = generateConfigYaml({ projectName: "O'Brien", client: 'Client' });
    const parsed = parse(yaml) as { project: { name: string } };
    expect(parsed.project.name).toBe("O'Brien");
  });

  it("escapes single quotes in client name (Client's Co. → remains valid YAML)", () => {
    const yaml = generateConfigYaml({ projectName: 'My App', client: "Client's Co." });
    const parsed = parse(yaml) as { project: { client: string } };
    expect(parsed.project.client).toBe("Client's Co.");
  });

  it("generated YAML with single-quoted project name passes schema validation", () => {
    const yaml = generateConfigYaml({ projectName: "It's a Project", client: 'ACME' });
    const parsed = parse(yaml);
    const result = ProjectConfigSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });
});
