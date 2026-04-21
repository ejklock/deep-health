/**
 * Tests for pipPlugin.inferVersion implementation.
 *
 * pip precedence: .python-version → .tool-versions → pyproject.toml → setup.cfg → runtime.txt
 *
 * Version output is always at most major.minor (e.g. "3.11.2" → "3.11").
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── fs/promises mock ─────────────────────────────────────────────────────────

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

import { readFile } from 'node:fs/promises';
import { pipPlugin } from '@modules/ecosystem/plugins/pip';

const mockReadFile = vi.mocked(readFile);

/** Reject with ENOENT for any path that doesn't match a known stub. */
const ENOENT = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });

// ─── .python-version ─────────────────────────────────────────────────────────

describe('pipPlugin.inferVersion — .python-version precedence', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns "3.11" from .python-version with value "3.11"', async () => {
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('.python-version')) return '3.11';
      throw ENOENT;
    });
    expect(await pipPlugin.inferVersion!('/project')).toBe('3.11');
  });

  it('returns "3.11" from .python-version with value "3.11.2" (truncates to major.minor)', async () => {
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('.python-version')) return '3.11.2';
      throw ENOENT;
    });
    expect(await pipPlugin.inferVersion!('/project')).toBe('3.11');
  });

  it('strips leading "v" and returns "3.10" from "v3.10"', async () => {
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('.python-version')) return 'v3.10';
      throw ENOENT;
    });
    expect(await pipPlugin.inferVersion!('/project')).toBe('3.10');
  });

  it('returns "3" from bare major version "3"', async () => {
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('.python-version')) return '3';
      throw ENOENT;
    });
    expect(await pipPlugin.inferVersion!('/project')).toBe('3');
  });

  it('.python-version wins over pyproject.toml when both present', async () => {
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('.python-version')) return '3.11';
      if (String(p).endsWith('pyproject.toml')) return `[project]\nrequires-python = ">=3.9"`;
      throw ENOENT;
    });
    expect(await pipPlugin.inferVersion!('/project')).toBe('3.11');
  });
});

// ─── .tool-versions ──────────────────────────────────────────────────────────

describe('pipPlugin.inferVersion — .tool-versions (asdf/mise format)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('parses python line from .tool-versions with other tools present', async () => {
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('.python-version')) throw ENOENT;
      if (String(p).endsWith('.tool-versions')) return 'python 3.12.0\nnodejs 20';
      throw ENOENT;
    });
    expect(await pipPlugin.inferVersion!('/project')).toBe('3.12');
  });

  it('returns undefined when .tool-versions has no python line', async () => {
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('.python-version')) throw ENOENT;
      if (String(p).endsWith('.tool-versions')) return 'nodejs 20\nruby 3.2';
      throw ENOENT;
    });
    // Falls through to pyproject.toml etc., all missing
    expect(await pipPlugin.inferVersion!('/project')).toBeUndefined();
  });
});

// ─── pyproject.toml ──────────────────────────────────────────────────────────

describe('pipPlugin.inferVersion — pyproject.toml requires-python', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns "3.10" from requires-python = ">=3.10"', async () => {
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('.python-version')) throw ENOENT;
      if (String(p).endsWith('.tool-versions')) throw ENOENT;
      if (String(p).endsWith('pyproject.toml')) return `[project]\nrequires-python = ">=3.10"`;
      throw ENOENT;
    });
    expect(await pipPlugin.inferVersion!('/project')).toBe('3.10');
  });

  it('returns "3.11" from requires-python = "^3.11"', async () => {
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('.python-version')) throw ENOENT;
      if (String(p).endsWith('.tool-versions')) throw ENOENT;
      if (String(p).endsWith('pyproject.toml')) return `[project]\nrequires-python = "^3.11"`;
      throw ENOENT;
    });
    expect(await pipPlugin.inferVersion!('/project')).toBe('3.11');
  });

  it('returns "3.9" from requires-python = "~=3.9.2" (major.minor only)', async () => {
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('.python-version')) throw ENOENT;
      if (String(p).endsWith('.tool-versions')) throw ENOENT;
      if (String(p).endsWith('pyproject.toml')) return `[project]\nrequires-python = "~=3.9.2"`;
      throw ENOENT;
    });
    expect(await pipPlugin.inferVersion!('/project')).toBe('3.9');
  });
});

// ─── setup.cfg ───────────────────────────────────────────────────────────────

describe('pipPlugin.inferVersion — setup.cfg python_requires', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns "3.9" from python_requires = >=3.9', async () => {
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('.python-version')) throw ENOENT;
      if (String(p).endsWith('.tool-versions')) throw ENOENT;
      if (String(p).endsWith('pyproject.toml')) throw ENOENT;
      if (String(p).endsWith('setup.cfg')) return '[options]\npython_requires = >=3.9';
      throw ENOENT;
    });
    expect(await pipPlugin.inferVersion!('/project')).toBe('3.9');
  });
});

// ─── runtime.txt ─────────────────────────────────────────────────────────────

describe('pipPlugin.inferVersion — runtime.txt (Heroku format)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns "3.11" from "python-3.11.4" in runtime.txt', async () => {
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('.python-version')) throw ENOENT;
      if (String(p).endsWith('.tool-versions')) throw ENOENT;
      if (String(p).endsWith('pyproject.toml')) throw ENOENT;
      if (String(p).endsWith('setup.cfg')) throw ENOENT;
      if (String(p).endsWith('runtime.txt')) return 'python-3.11.4';
      throw ENOENT;
    });
    expect(await pipPlugin.inferVersion!('/project')).toBe('3.11');
  });
});

// ─── Error handling ───────────────────────────────────────────────────────────

describe('pipPlugin.inferVersion — error handling', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns undefined when all files are missing (ENOENT)', async () => {
    mockReadFile.mockRejectedValue(ENOENT);
    expect(await pipPlugin.inferVersion!('/project')).toBeUndefined();
  });

  it('returns undefined for missing/malformed files (never throws)', async () => {
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('pyproject.toml')) return 'NOT TOML AT ALL >>>>';
      throw ENOENT;
    });
    await expect(pipPlugin.inferVersion!('/project')).resolves.toBeUndefined();
  });
});

// ─── Plugin shape assertions ──────────────────────────────────────────────────

describe('pipPlugin shape', () => {
  it('has correct id, name, osvEcosystems', () => {
    expect(pipPlugin.id).toBe('pip');
    expect(pipPlugin.name).toBe('pip');
    expect(pipPlugin.osvEcosystems).toContain('PyPI');
  });

  it('has runtimeContainer pip-docker', () => {
    expect(pipPlugin.runtimeContainer).toBe('pip-docker');
  });

  it('has postUpdateOsvVerify always', () => {
    expect(pipPlugin.postUpdateOsvVerify).toBe('always');
  });

  it('has lockfiles requirements.txt', () => {
    expect(pipPlugin.lockfiles).toContain('requirements.txt');
  });

  it('has defaultAdvisors including pip-audit', () => {
    expect(pipPlugin.defaultAdvisors.some((a) => a.command === 'pip-audit')).toBe(true);
  });

  it('has defaultValidationCommands including pip check', () => {
    expect(pipPlugin.defaultValidationCommands.some((v) => v.command === 'pip check')).toBe(true);
  });

  it('buildScanArgs returns lockfile flag', () => {
    expect(pipPlugin.buildScanArgs()).toEqual(['--lockfile', 'requirements.txt']);
  });
});
