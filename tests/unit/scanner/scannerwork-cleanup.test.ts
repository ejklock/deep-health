import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// We mock the logger before importing the module so the import picks up the mock.
vi.mock('@infra/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Also mock the sonar-properties module to avoid side-effects from the engine module.
vi.mock('@modules/scanner/sonar-properties', () => ({
  readSonarProperties: vi.fn(async () => new Map()),
  sanitizeAndWriteProperties: vi.fn(async () => ({
    path: '/tmp/fake.properties',
    cleanup: async () => undefined,
    strippedKeys: [],
    fromScratch: false,
  })),
  DEPRECATED_AUTH_KEYS: [],
  CLI_OWNED_KEYS: [],
}));

vi.mock('@infra/provisioner/docker-sonarqube.js', () => ({
  DockerSonarQubeProvisioner: vi.fn(),
}));

vi.mock('@infra/provisioner/docker-sonar-scanner.js', () => ({
  DockerSonarScannerRunner: vi.fn(),
}));

import { cleanupScannerWorkDir } from '@modules/scanner/sonarqube-engine';
import { logger } from '@infra/utils/logger';

describe('cleanupScannerWorkDir', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'scannerwork-test-'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Safety cleanup in case a test left the dir behind
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('removes an existing .scannerwork directory', async () => {
    const scannerWorkPath = join(tmpDir, '.scannerwork');
    await mkdir(scannerWorkPath);
    await writeFile(join(scannerWorkPath, 'report-task.txt'), 'ceTaskId=abc123\n');

    expect(existsSync(scannerWorkPath)).toBe(true);

    await cleanupScannerWorkDir(tmpDir);

    expect(existsSync(scannerWorkPath)).toBe(false);
  });

  it('does not throw when .scannerwork does not exist', async () => {
    const scannerWorkPath = join(tmpDir, '.scannerwork');
    expect(existsSync(scannerWorkPath)).toBe(false);

    await expect(cleanupScannerWorkDir(tmpDir)).resolves.toBeUndefined();
  });

  it('logs a debug message on success', async () => {
    const scannerWorkPath = join(tmpDir, '.scannerwork');
    await mkdir(scannerWorkPath);

    await cleanupScannerWorkDir(tmpDir);

    expect(logger.debug).toHaveBeenCalledWith('SonarQube: cleaned up .scannerwork/');
  });
});
