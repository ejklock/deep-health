import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function backupFiles(
  files: string[],
  cwd: string,
): Promise<Map<string, string>> {
  const backups = new Map<string, string>();
  for (const file of files) {
    try {
      const content = await readFile(resolve(cwd, file), 'utf-8');
      backups.set(file, content);
    } catch {
      // file doesn't exist — nothing to back up
    }
  }
  return backups;
}

export async function restoreFiles(
  backups: Map<string, string>,
  cwd: string,
): Promise<void> {
  for (const [file, content] of backups) {
    await writeFile(resolve(cwd, file), content, 'utf-8');
  }
}
