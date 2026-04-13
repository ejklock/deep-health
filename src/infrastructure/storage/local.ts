import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import type { StorageProvider, UploadResult } from './provider.js';

export class LocalStorageProvider implements StorageProvider {
  constructor(private readonly outputDir: string) {}

  async upload(filename: string, content: string): Promise<UploadResult> {
    const filePath = resolve(this.outputDir, filename);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf-8');
    return { url: filePath, id: filename, provider: 'local' };
  }
}
