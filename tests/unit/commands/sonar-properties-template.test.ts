/**
 * Unit tests for the sonar-project.properties template generator used by
 * `deep-health init` when the user enables SonarQube and the project has no
 * pre-existing file.
 *
 * The generator must:
 * - Produce a parseable .properties file
 * - Include the essentials (sonar.projectKey, sonar.projectName, sonar.sources)
 * - NEVER emit deprecated or CLI-owned keys (sonar.login, sonar.password,
 *   sonar.token, sonar.host.url are not generator output)
 * - Apply ecosystem-aware exclusion defaults
 * - Be idempotent: skip if the file already exists (never clobber user config)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSonarPropertiesTemplate,
  writeSonarPropertiesTemplateIfMissing,
} from '@app/commands/sonar-properties-template';
import { parsePropertiesFile } from '@modules/scanner/sonar-properties';

describe('buildSonarPropertiesTemplate', () => {
  it('produces a parseable .properties file with projectKey + projectName', () => {
    const content = buildSonarPropertiesTemplate({
      projectName: 'My App',
      ecosystemIds: ['npm'],
    });
    const parsed = parsePropertiesFile(content);
    expect(parsed.get('sonar.projectKey')).toBe('My-App'); // normalized
    expect(parsed.get('sonar.projectName')).toBe('My App');
    expect(parsed.get('sonar.projectVersion')).toBe('1.0.0');
  });

  it('never emits deprecated auth keys (sonar.login / sonar.password)', () => {
    const content = buildSonarPropertiesTemplate({
      projectName: 'test',
      ecosystemIds: ['npm', 'composer'],
    });
    expect(content).not.toMatch(/^sonar\.login=/m);
    expect(content).not.toMatch(/^sonar\.password=/m);
  });

  it('does NOT emit sonar.token (CLI-managed in managed mode, env-var in external mode)', () => {
    const content = buildSonarPropertiesTemplate({ projectName: 'test', ecosystemIds: [] });
    expect(content).not.toMatch(/^sonar\.token=/m);
  });

  it('emits sonar.host.url as a commented-out line (optional, only for external mode)', () => {
    const content = buildSonarPropertiesTemplate({ projectName: 'test', ecosystemIds: [] });
    // Must be commented — active line would break managed-mode users
    expect(content).toMatch(/^#\s*sonar\.host\.url=/m);
    expect(content).not.toMatch(/^sonar\.host\.url=/m);
  });

  it('applies npm ecosystem exclusions (node_modules, dist, build)', () => {
    const content = buildSonarPropertiesTemplate({
      projectName: 'test',
      ecosystemIds: ['npm'],
    });
    const parsed = parsePropertiesFile(content);
    const exclusions = parsed.get('sonar.exclusions') ?? '';
    expect(exclusions).toContain('node_modules/**');
    expect(exclusions).toContain('dist/**');
    expect(exclusions).toContain('build/**');
  });

  it('applies composer ecosystem exclusions (vendor)', () => {
    const content = buildSonarPropertiesTemplate({
      projectName: 'test',
      ecosystemIds: ['composer'],
    });
    const parsed = parsePropertiesFile(content);
    const exclusions = parsed.get('sonar.exclusions') ?? '';
    expect(exclusions).toContain('vendor/**');
  });

  it('applies pip ecosystem exclusions (venv, __pycache__)', () => {
    const content = buildSonarPropertiesTemplate({
      projectName: 'test',
      ecosystemIds: ['pip'],
    });
    const parsed = parsePropertiesFile(content);
    const exclusions = parsed.get('sonar.exclusions') ?? '';
    expect(exclusions).toContain('venv/**');
    expect(exclusions).toContain('__pycache__');
  });

  it('merges ecosystem-specific exclusion lists when multiple are selected', () => {
    const content = buildSonarPropertiesTemplate({
      projectName: 'test',
      ecosystemIds: ['npm', 'composer'],
    });
    const parsed = parsePropertiesFile(content);
    const exclusions = parsed.get('sonar.exclusions') ?? '';
    expect(exclusions).toContain('node_modules/**');
    expect(exclusions).toContain('vendor/**');
  });

  it('deduplicates patterns across ecosystems (tests/** appears once)', () => {
    const content = buildSonarPropertiesTemplate({
      projectName: 'test',
      ecosystemIds: ['npm', 'composer', 'pip'],
    });
    const parsed = parsePropertiesFile(content);
    const exclusions = parsed.get('sonar.exclusions') ?? '';
    const parts = exclusions.split(',');
    // tests/** is in all three lists — must not be duplicated
    const testsMatches = parts.filter((p) => p === 'tests/**');
    expect(testsMatches.length).toBe(1);
  });

  it('falls back to a safe default when no ecosystems are selected', () => {
    const content = buildSonarPropertiesTemplate({ projectName: 'test', ecosystemIds: [] });
    const parsed = parsePropertiesFile(content);
    expect(parsed.get('sonar.exclusions')).toBeDefined();
  });

  it('handles project names with special characters (slugged for projectKey)', () => {
    const content = buildSonarPropertiesTemplate({
      projectName: 'My App (v2)!',
      ecosystemIds: ['npm'],
    });
    const parsed = parsePropertiesFile(content);
    // projectKey is slugged to a safe form; projectName keeps the original
    expect(parsed.get('sonar.projectName')).toBe('My App (v2)!');
    expect(parsed.get('sonar.projectKey')).toMatch(/^[a-zA-Z0-9\-_.:][-a-zA-Z0-9_.:]*$/);
  });
});

describe('writeSonarPropertiesTemplateIfMissing', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'deep-health-init-test-'));
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('creates sonar-project.properties when missing', async () => {
    const status = await writeSonarPropertiesTemplateIfMissing(workDir, {
      projectName: 'test',
      ecosystemIds: ['npm'],
    });
    expect(status).toBe('created');

    const filePath = join(workDir, 'sonar-project.properties');
    const content = await readFile(filePath, 'utf-8');
    expect(content).toContain('sonar.projectKey=test');
  });

  it('does NOT overwrite an existing file (returns skipped-existing)', async () => {
    const filePath = join(workDir, 'sonar-project.properties');
    await writeFile(filePath, '# user-authored\nsonar.projectKey=user-key\n', 'utf-8');

    const status = await writeSonarPropertiesTemplateIfMissing(workDir, {
      projectName: 'test',
      ecosystemIds: ['npm'],
    });
    expect(status).toBe('skipped-existing');

    // Content must be preserved verbatim
    const content = await readFile(filePath, 'utf-8');
    expect(content).toContain('user-authored');
    expect(content).toContain('user-key');
  });

  it('created file is immediately readable by readSonarProperties', async () => {
    await writeSonarPropertiesTemplateIfMissing(workDir, {
      projectName: 'round-trip',
      ecosystemIds: ['composer'],
    });

    // File must be parseable by the helper the engine uses at scan time.
    await access(join(workDir, 'sonar-project.properties'));
    const raw = await readFile(join(workDir, 'sonar-project.properties'), 'utf-8');
    const parsed = parsePropertiesFile(raw);
    expect(parsed.get('sonar.projectKey')).toBe('round-trip');
    expect(parsed.get('sonar.exclusions')).toContain('vendor/**');
  });
});
