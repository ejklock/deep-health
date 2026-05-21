/**
 * Tests that LocalStorageProvider writes Buffer content without utf-8 encoding.
 * AC2: LocalStorageProvider.upload() accepts string | Buffer.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm, readFile } from 'node:fs/promises';

import { LocalStorageProvider } from '@infra/storage/local';

describe('LocalStorageProvider — Buffer content', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `osv-buffer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a Buffer without corrupting binary content', async () => {
    const provider = new LocalStorageProvider(dir);
    // A small buffer with bytes that are invalid UTF-8
    const original = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0xfe]);
    await provider.upload('test.docx', original);

    const written = await readFile(join(dir, 'test.docx'));
    expect(written).toEqual(original);
  });

  it('returns correct metadata when uploading a Buffer', async () => {
    const provider = new LocalStorageProvider(dir);
    const buf = Buffer.from('hello buffer');
    const result = await provider.upload('doc.docx', buf);

    expect(result.provider).toBe('local');
    expect(result.id).toBe('doc.docx');
    expect(result.url).toContain('doc.docx');
  });

  it('still writes string content correctly after the Buffer-support change', async () => {
    const provider = new LocalStorageProvider(dir);
    await provider.upload('text.md', '# Hello');

    const content = await readFile(join(dir, 'text.md'), 'utf-8');
    expect(content).toBe('# Hello');
  });

  it('creates nested directories for Buffer uploads', async () => {
    const provider = new LocalStorageProvider(dir);
    const buf = Buffer.from([0x01, 0x02, 0x03]);
    const result = await provider.upload('reports/sub/file.docx', buf);
    expect(result.url).toContain('file.docx');

    const written = await readFile(join(dir, 'reports', 'sub', 'file.docx'));
    expect(written).toEqual(buf);
  });
});
