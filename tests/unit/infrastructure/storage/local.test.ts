/**
 * Tests for src/infrastructure/storage/local.ts — LocalStorageProvider
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';

// Use real fs for these tests — tmpdir cleanup ensures no side effects
import { LocalStorageProvider } from '@infra/storage/local';

describe('LocalStorageProvider', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `osv-local-storage-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates the output directory and writes the file', async () => {
    const provider = new LocalStorageProvider(dir);
    const result = await provider.upload('report.md', '# Report');
    expect(result.provider).toBe('local');
    expect(result.id).toBe('report.md');
    expect(result.url).toContain('report.md');
  });

  it('returns url as the resolved absolute path to the file', async () => {
    const provider = new LocalStorageProvider(dir);
    const result = await provider.upload('sub/file.md', 'content');
    expect(result.url).toContain('sub');
    expect(result.url).toContain('file.md');
  });

  it('writes the correct content to the file', async () => {
    const { readFile } = await import('node:fs/promises');
    const provider = new LocalStorageProvider(dir);
    await provider.upload('test.md', 'hello world');
    const content = await readFile(join(dir, 'test.md'), 'utf-8');
    expect(content).toBe('hello world');
  });

  it('creates nested subdirectories as needed', async () => {
    const provider = new LocalStorageProvider(dir);
    const result = await provider.upload('a/b/c/file.md', 'nested');
    expect(result.url).toContain('file.md');
  });
});
