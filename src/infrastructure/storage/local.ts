import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import type { StorageProvider, UploadResult } from './provider';

export class LocalStorageProvider implements StorageProvider {
  constructor(private readonly outputDir: string) {}

  async upload(filename: string, content: string | Buffer): Promise<UploadResult> {
    const filePath = resolve(this.outputDir, filename);
    await mkdir(dirname(filePath), { recursive: true });
    if (Buffer.isBuffer(content)) {
      await writeFile(filePath, content);
    } else {
      await writeFile(filePath, content, 'utf-8');
    }
    return { url: filePath, id: filename, provider: 'local' };
  }
}
