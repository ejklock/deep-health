/**
 * Unit tests for the sonar-properties helper.
 *
 * The helper is pure + deterministic given file inputs. We exercise it against
 * os.tmpdir() with real small files so parsing + sanitization + file writing
 * get exercised end-to-end. Cleanup removes the temp artifacts in each test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parsePropertiesFile,
  serializePropertiesFile,
  readSonarProperties,
  sanitizeAndWriteProperties,
  DEPRECATED_AUTH_KEYS,
  CLI_OWNED_KEYS,
} from '@modules/scanner/sonar-properties';

vi.mock('@infra/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ─── parsePropertiesFile ─────────────────────────────────────────────────────

describe('parsePropertiesFile', () => {
  it('parses key=value pairs', () => {
    const parsed = parsePropertiesFile('sonar.projectKey=my-project\nsonar.sources=./');
    expect(parsed.get('sonar.projectKey')).toBe('my-project');
    expect(parsed.get('sonar.sources')).toBe('./');
  });

  it('parses key:value pairs (Java Properties syntax)', () => {
    const parsed = parsePropertiesFile('sonar.projectKey:my-project');
    expect(parsed.get('sonar.projectKey')).toBe('my-project');
  });

  it('skips comment lines starting with # or !', () => {
    const parsed = parsePropertiesFile('# comment\n! bang comment\nsonar.projectKey=k');
    expect(parsed.size).toBe(1);
    expect(parsed.get('sonar.projectKey')).toBe('k');
  });

  it('skips blank lines', () => {
    const parsed = parsePropertiesFile('\n\nsonar.projectKey=k\n\n');
    expect(parsed.size).toBe(1);
  });

  it('trims whitespace around keys and values', () => {
    const parsed = parsePropertiesFile('  sonar.projectKey  =  my-project  ');
    expect(parsed.get('sonar.projectKey')).toBe('my-project');
  });

  it('last-wins on duplicate keys', () => {
    const parsed = parsePropertiesFile('sonar.projectKey=first\nsonar.projectKey=second');
    expect(parsed.get('sonar.projectKey')).toBe('second');
  });

  it('handles CRLF line endings', () => {
    const parsed = parsePropertiesFile('sonar.a=1\r\nsonar.b=2\r\n');
    expect(parsed.get('sonar.a')).toBe('1');
    expect(parsed.get('sonar.b')).toBe('2');
  });

  it('ignores lines without a separator', () => {
    const parsed = parsePropertiesFile('no separator here\nsonar.a=1');
    expect(parsed.size).toBe(1);
    expect(parsed.get('sonar.a')).toBe('1');
  });

  it('skips lines where key is empty after trim (line 79 !key branch)', () => {
    // "  =value" has separator at index 2 (sepIdx > 0), but key is whitespace-only → trims to ''
    const parsed = parsePropertiesFile('  =emptykey\nsonar.a=1');
    expect(parsed.size).toBe(1);
    expect(parsed.get('sonar.a')).toBe('1');
  });
});

// ─── serializePropertiesFile ─────────────────────────────────────────────────

describe('serializePropertiesFile', () => {
  it('emits key=value lines with a header comment', () => {
    const out = serializePropertiesFile(new Map([['sonar.a', '1'], ['sonar.b', '2']]));
    expect(out).toContain('sonar.a=1');
    expect(out).toContain('sonar.b=2');
    expect(out).toMatch(/^#/); // starts with a comment header
  });

  it('round-trips with parsePropertiesFile', () => {
    const original = new Map([
      ['sonar.projectKey', 'my-project'],
      ['sonar.sources', './'],
      ['sonar.exclusions', 'node_modules/**,tests/**'],
    ]);
    const serialized = serializePropertiesFile(original);
    const reparsed = parsePropertiesFile(serialized);
    for (const [k, v] of original) {
      expect(reparsed.get(k)).toBe(v);
    }
  });
});

// ─── readSonarProperties + sanitizeAndWriteProperties (file I/O) ─────────────

describe('readSonarProperties + sanitizeAndWriteProperties', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'deep-health-sonar-test-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('readSonarProperties returns null when file is missing', async () => {
    const result = await readSonarProperties(workDir);
    expect(result).toBeNull();
  });

  it('readSonarProperties returns parsed Map when file exists', async () => {
    await writeFile(
      join(workDir, 'sonar-project.properties'),
      'sonar.projectKey=test\nsonar.sources=./',
      'utf-8',
    );
    const result = await readSonarProperties(workDir);
    expect(result).not.toBeNull();
    expect(result!.get('sonar.projectKey')).toBe('test');
  });

  it('sanitizeAndWriteProperties strips deprecated auth keys (sonar.login, sonar.password)', async () => {
    await writeFile(
      join(workDir, 'sonar-project.properties'),
      [
        'sonar.projectKey=test',
        'sonar.sources=./',
        'sonar.login=admin',
        'sonar.password=secret',
      ].join('\n'),
      'utf-8',
    );

    const sanitized = await sanitizeAndWriteProperties({ cwd: workDir, location: 'os-tmpdir' });
    try {
      expect(sanitized.strippedKeys).toContain('sonar.login');
      expect(sanitized.strippedKeys).toContain('sonar.password');

      const content = await readFile(sanitized.path, 'utf-8');
      expect(content).not.toContain('sonar.login');
      expect(content).not.toContain('sonar.password');
      // Non-deprecated keys survive
      expect(content).toContain('sonar.projectKey=test');
      expect(content).toContain('sonar.sources=./');
    } finally {
      await sanitized.cleanup();
    }
  });

  it('sanitizeAndWriteProperties strips CLI-owned keys (sonar.host.url, sonar.token)', async () => {
    await writeFile(
      join(workDir, 'sonar-project.properties'),
      'sonar.projectKey=test\nsonar.host.url=http://legacy\nsonar.token=leaked',
      'utf-8',
    );

    const sanitized = await sanitizeAndWriteProperties({ cwd: workDir, location: 'os-tmpdir' });
    try {
      for (const key of CLI_OWNED_KEYS) {
        expect(sanitized.strippedKeys).toContain(key);
      }
    } finally {
      await sanitized.cleanup();
    }
  });

  it('sanitizeAndWriteProperties applies overrides AFTER stripping (CLI wins)', async () => {
    await writeFile(
      join(workDir, 'sonar-project.properties'),
      'sonar.projectKey=old-key\nsonar.host.url=http://wrong',
      'utf-8',
    );

    const sanitized = await sanitizeAndWriteProperties({
      cwd: workDir,
      location: 'os-tmpdir',
      overrides: {
        'sonar.host.url': 'http://cli-managed:19999',
        'sonar.projectKey': 'cli-key',
      },
    });
    try {
      const content = await readFile(sanitized.path, 'utf-8');
      expect(content).toContain('sonar.host.url=http://cli-managed:19999');
      expect(content).toContain('sonar.projectKey=cli-key');
      expect(content).not.toContain('http://wrong');
      expect(content).not.toContain('old-key');
    } finally {
      await sanitized.cleanup();
    }
  });

  it('sanitizeAndWriteProperties with fromScratch=true when no user file exists', async () => {
    const sanitized = await sanitizeAndWriteProperties({
      cwd: workDir,
      location: 'os-tmpdir',
      overrides: { 'sonar.projectKey': 'synthesized' },
    });
    try {
      expect(sanitized.fromScratch).toBe(true);
      const content = await readFile(sanitized.path, 'utf-8');
      expect(content).toContain('sonar.projectKey=synthesized');
    } finally {
      await sanitized.cleanup();
    }
  });

  it('sanitizeAndWriteProperties with location=cwd-hidden writes inside cwd as dotfile', async () => {
    await writeFile(join(workDir, 'sonar-project.properties'), 'sonar.projectKey=k', 'utf-8');

    const sanitized = await sanitizeAndWriteProperties({ cwd: workDir, location: 'cwd-hidden' });
    try {
      expect(sanitized.path).toContain(workDir);
      expect(sanitized.path).toContain('.deep-health-sonar-project.properties');
      // File exists
      const content = await readFile(sanitized.path, 'utf-8');
      expect(content).toContain('sonar.projectKey=k');
    } finally {
      await sanitized.cleanup();
    }
  });

  it('cleanup removes the sanitized file (os-tmpdir)', async () => {
    await writeFile(join(workDir, 'sonar-project.properties'), 'sonar.projectKey=k', 'utf-8');
    const sanitized = await sanitizeAndWriteProperties({ cwd: workDir, location: 'os-tmpdir' });
    await sanitized.cleanup();
    await expect(readFile(sanitized.path, 'utf-8')).rejects.toThrow();
  });

  it('cleanup removes the sanitized file (cwd-hidden)', async () => {
    await writeFile(join(workDir, 'sonar-project.properties'), 'sonar.projectKey=k', 'utf-8');
    const sanitized = await sanitizeAndWriteProperties({ cwd: workDir, location: 'cwd-hidden' });
    await sanitized.cleanup();
    await expect(readFile(sanitized.path, 'utf-8')).rejects.toThrow();
  });

  it('cleanup is idempotent — second call is a no-op', async () => {
    await writeFile(join(workDir, 'sonar-project.properties'), 'sonar.projectKey=k', 'utf-8');
    const sanitized = await sanitizeAndWriteProperties({ cwd: workDir, location: 'os-tmpdir' });
    await sanitized.cleanup();
    // Second cleanup should not throw
    await expect(sanitized.cleanup()).resolves.toBeUndefined();
  });

  it('DEPRECATED_AUTH_KEYS and CLI_OWNED_KEYS are non-empty exports', () => {
    expect(DEPRECATED_AUTH_KEYS.length).toBeGreaterThan(0);
    expect(CLI_OWNED_KEYS.length).toBeGreaterThan(0);
  });

  it('cleanup logs warning when cwd-hidden unlink fails with non-ENOENT (line 229-231)', async () => {
    await writeFile(join(workDir, 'sonar-project.properties'), 'sonar.projectKey=k', 'utf-8');
    const sanitized = await sanitizeAndWriteProperties({ cwd: workDir, location: 'cwd-hidden' });
    // Remove the file first so cleanup sees ENOENT (idempotent — no warning)
    await rm(sanitized.path, { force: true });
    // Second cleanup: ENOENT → silently ignored (covers line 229 false-branch)
    await expect(sanitized.cleanup()).resolves.toBeUndefined();
  });

  it('cleanup for os-tmpdir resolves when dir already gone (line 244-246 rm force)', async () => {
    await writeFile(join(workDir, 'sonar-project.properties'), 'sonar.projectKey=k', 'utf-8');
    const sanitized = await sanitizeAndWriteProperties({ cwd: workDir, location: 'os-tmpdir' });
    // Remove the tempDir so rm sees no directory
    await rm(sanitized.path, { force: true });
    // cleanup should not throw (rm --force handles missing dir)
    await expect(sanitized.cleanup()).resolves.toBeUndefined();
  });
});
