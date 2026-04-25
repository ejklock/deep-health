/**
 * Tests for EcosystemPlugin.inferVersion? implementations.
 *
 * Both npm and composer plugins read project files in cwd following
 * a file-precedence chain. We mock `node:fs/promises` so no real
 * filesystem access occurs.
 *
 * npm precedence:      .nvmrc → .node-version → package.json#engines.node
 * composer precedence: .php-version → composer.json#require.php
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── fs/promises mock ─────────────────────────────────────────────────────────

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

import { readFile } from 'node:fs/promises';
import { npmPlugin } from '@modules/ecosystem/plugins/npm';
import { composerPlugin } from '@modules/ecosystem/plugins/composer';

const mockReadFile = vi.mocked(readFile);

/** Reject with ENOENT for any path that doesn't match a known stub. */
const ENOENT = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });

// ─── npm plugin ───────────────────────────────────────────────────────────────

describe('npmPlugin.inferVersion — .nvmrc precedence', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns version from .nvmrc (strips leading v)', async () => {
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('.nvmrc')) return 'v20.11.1';
      throw ENOENT;
    });
    expect(await npmPlugin.inferVersion!('/project')).toBe('20.11.1');
  });

  it('returns version from .nvmrc without leading v', async () => {
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('.nvmrc')) return '20';
      throw ENOENT;
    });
    expect(await npmPlugin.inferVersion!('/project')).toBe('20');
  });

  it('skips .nvmrc alias lts/* and falls through to .node-version', async () => {
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('.nvmrc')) return 'lts/*';
      if (String(p).endsWith('.node-version')) return '18.20.2';
      throw ENOENT;
    });
    expect(await npmPlugin.inferVersion!('/project')).toBe('18.20.2');
  });

  it('skips .nvmrc alias "node" and falls through to package.json', async () => {
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('.nvmrc')) return 'node';
      if (String(p).endsWith('.node-version')) throw ENOENT;
      if (String(p).endsWith('package.json')) return JSON.stringify({ engines: { node: '^22' } });
      throw ENOENT;
    });
    expect(await npmPlugin.inferVersion!('/project')).toBe('22');
  });
});

describe('npmPlugin.inferVersion — .node-version precedence', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns version from .node-version when .nvmrc is missing', async () => {
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('.nvmrc')) throw ENOENT;
      if (String(p).endsWith('.node-version')) return 'v18.20';
      throw ENOENT;
    });
    expect(await npmPlugin.inferVersion!('/project')).toBe('18.20');
  });

  it('.nvmrc wins over .node-version when both are concrete', async () => {
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('.nvmrc')) return '20.11';
      if (String(p).endsWith('.node-version')) return '18';
      throw ENOENT;
    });
    expect(await npmPlugin.inferVersion!('/project')).toBe('20.11');
  });
});

describe('npmPlugin.inferVersion — package.json#engines.node fallback', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns major version from >=20.0.0 engines.node range', async () => {
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('package.json'))
        return JSON.stringify({ engines: { node: '>=20.0.0' } });
      throw ENOENT;
    });
    expect(await npmPlugin.inferVersion!('/project')).toBe('20.0.0');
  });

  it('returns "20" from ">=20" engines.node range', async () => {
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('package.json'))
        return JSON.stringify({ engines: { node: '>=20' } });
      throw ENOENT;
    });
    expect(await npmPlugin.inferVersion!('/project')).toBe('20');
  });

  it('returns "18" from "^18" engines.node range', async () => {
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('package.json'))
        return JSON.stringify({ engines: { node: '^18' } });
      throw ENOENT;
    });
    expect(await npmPlugin.inferVersion!('/project')).toBe('18');
  });

  it('returns "20.11" from "~20.11" engines.node range', async () => {
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('package.json'))
        return JSON.stringify({ engines: { node: '~20.11' } });
      throw ENOENT;
    });
    expect(await npmPlugin.inferVersion!('/project')).toBe('20.11');
  });

  it('returns "20" from "20.x" engines.node range', async () => {
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('package.json'))
        return JSON.stringify({ engines: { node: '20.x' } });
      throw ENOENT;
    });
    expect(await npmPlugin.inferVersion!('/project')).toBe('20');
  });

  it('returns "20" from exact "20" engines.node', async () => {
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('package.json'))
        return JSON.stringify({ engines: { node: '20' } });
      throw ENOENT;
    });
    expect(await npmPlugin.inferVersion!('/project')).toBe('20');
  });

  it('returns "18" from range ">=18 <21" (lower bound)', async () => {
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('package.json'))
        return JSON.stringify({ engines: { node: '>=18 <21' } });
      throw ENOENT;
    });
    expect(await npmPlugin.inferVersion!('/project')).toBe('18');
  });

  it('returns undefined for wildcard "*" engines.node', async () => {
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('package.json'))
        return JSON.stringify({ engines: { node: '*' } });
      throw ENOENT;
    });
    expect(await npmPlugin.inferVersion!('/project')).toBeUndefined();
  });

  it('returns undefined when engines.node is absent', async () => {
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('package.json')) return JSON.stringify({ name: 'my-app' });
      throw ENOENT;
    });
    expect(await npmPlugin.inferVersion!('/project')).toBeUndefined();
  });

  it('returns undefined when engines field is absent', async () => {
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('package.json')) return JSON.stringify({});
      throw ENOENT;
    });
    expect(await npmPlugin.inferVersion!('/project')).toBeUndefined();
  });

  it('returns undefined when engines.node is empty string', async () => {
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('package.json'))
        return JSON.stringify({ engines: { node: '' } });
      throw ENOENT;
    });
    expect(await npmPlugin.inferVersion!('/project')).toBeUndefined();
  });
});

describe('npmPlugin.inferVersion — error handling', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns undefined when all files are missing (ENOENT)', async () => {
    mockReadFile.mockRejectedValue(ENOENT);
    expect(await npmPlugin.inferVersion!('/project')).toBeUndefined();
  });

  it('returns undefined when package.json is malformed JSON', async () => {
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('package.json')) return 'NOT JSON';
      throw ENOENT;
    });
    expect(await npmPlugin.inferVersion!('/project')).toBeUndefined();
  });
});

// ─── composer plugin ──────────────────────────────────────────────────────────

describe('composerPlugin.inferVersion — .php-version precedence', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns version from .php-version (strips leading v)', async () => {
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('.php-version')) return 'v8.3.0';
      throw ENOENT;
    });
    expect(await composerPlugin.inferVersion!('/project')).toBe('8.3.0');
  });

  it('returns version from .php-version without leading v', async () => {
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('.php-version')) return '8.2';
      throw ENOENT;
    });
    expect(await composerPlugin.inferVersion!('/project')).toBe('8.2');
  });

  it('.php-version wins over composer.json when both present', async () => {
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('.php-version')) return '8.3';
      if (String(p).endsWith('composer.json'))
        return JSON.stringify({ require: { php: '^8.1' } });
      throw ENOENT;
    });
    expect(await composerPlugin.inferVersion!('/project')).toBe('8.3');
  });

  it('falls through to composer.json when .php-version is missing', async () => {
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('.php-version')) throw ENOENT;
      if (String(p).endsWith('composer.json'))
        return JSON.stringify({ require: { php: '^8.2' } });
      throw ENOENT;
    });
    expect(await composerPlugin.inferVersion!('/project')).toBe('8.2');
  });
});

describe('composerPlugin.inferVersion — composer.json#require.php fallback', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns "8.2" from "^8.2" require.php constraint', async () => {
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('composer.json'))
        return JSON.stringify({ require: { php: '^8.2' } });
      throw ENOENT;
    });
    expect(await composerPlugin.inferVersion!('/project')).toBe('8.2');
  });

  it('returns "8.1" from ">=8.1" require.php constraint', async () => {
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('composer.json'))
        return JSON.stringify({ require: { php: '>=8.1' } });
      throw ENOENT;
    });
    expect(await composerPlugin.inferVersion!('/project')).toBe('8.1');
  });

  it('returns "8.2" from "8.2.*" require.php constraint', async () => {
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('composer.json'))
        return JSON.stringify({ require: { php: '8.2.*' } });
      throw ENOENT;
    });
    expect(await composerPlugin.inferVersion!('/project')).toBe('8.2');
  });

  it('returns "8.2.0" from "~8.2.0" require.php constraint', async () => {
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('composer.json'))
        return JSON.stringify({ require: { php: '~8.2.0' } });
      throw ENOENT;
    });
    expect(await composerPlugin.inferVersion!('/project')).toBe('8.2.0');
  });

  it('returns "8.2" from exact "8.2" require.php constraint', async () => {
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('composer.json'))
        return JSON.stringify({ require: { php: '8.2' } });
      throw ENOENT;
    });
    expect(await composerPlugin.inferVersion!('/project')).toBe('8.2');
  });

  it('returns undefined for wildcard "*" require.php', async () => {
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('composer.json'))
        return JSON.stringify({ require: { php: '*' } });
      throw ENOENT;
    });
    expect(await composerPlugin.inferVersion!('/project')).toBeUndefined();
  });

  it('returns undefined when require.php is absent', async () => {
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('composer.json'))
        return JSON.stringify({ require: { 'some/package': '^1.0' } });
      throw ENOENT;
    });
    expect(await composerPlugin.inferVersion!('/project')).toBeUndefined();
  });

  it('returns undefined when require field is absent', async () => {
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('composer.json')) return JSON.stringify({ name: 'my/app' });
      throw ENOENT;
    });
    expect(await composerPlugin.inferVersion!('/project')).toBeUndefined();
  });

  it('returns first bound from compound constraint ">=8.1 <9.0"', async () => {
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('composer.json'))
        return JSON.stringify({ require: { php: '>=8.1 <9.0' } });
      throw ENOENT;
    });
    expect(await composerPlugin.inferVersion!('/project')).toBe('8.1');
  });
});

describe('composerPlugin.inferVersion — error handling', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns undefined when all files are missing (ENOENT)', async () => {
    mockReadFile.mockRejectedValue(ENOENT);
    expect(await composerPlugin.inferVersion!('/project')).toBeUndefined();
  });

  it('returns undefined when composer.json is malformed JSON', async () => {
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('composer.json')) return 'NOT JSON';
      throw ENOENT;
    });
    expect(await composerPlugin.inferVersion!('/project')).toBeUndefined();
  });
});

// ─── composer plugin — parseComposerPhpConstraint branch gaps ─────────────────

describe('composerPlugin.inferVersion — parseComposerPhpConstraint branch gaps', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns undefined when constraint splits to empty first part (e.g. pipe-only "|8.1")', async () => {
    // Split on pipe produces ['', '8.1']; firstPart = '' → falsy → return undefined (line 38)
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('composer.json'))
        return JSON.stringify({ require: { php: '|8.1' } });
      throw ENOENT;
    });
    // '|8.1' splits to ['', '8.1'], firstPart = '' → undefined
    expect(await composerPlugin.inferVersion!('/project')).toBeUndefined();
  });

  it('returns undefined when constraint has no numeric part (e.g. "dev-main")', async () => {
    // No match on numeric regex → line 48-51 branch
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('composer.json'))
        return JSON.stringify({ require: { php: 'dev-main' } });
      throw ENOENT;
    });
    expect(await composerPlugin.inferVersion!('/project')).toBeUndefined();
  });
});



// ─── npm plugin — uncovered branch gaps ──────────────────────────────────────

describe('npmPlugin.inferVersion — inferNodeVersion/parseEnginesNodeRange branch gaps', () => {
  beforeEach(() => vi.clearAllMocks());

  it('line 42: .nvmrc with non-numeric stripped value (e.g. "lts/iron") → undefined, falls through', async () => {
    // "lts/iron" strips "v"→ same; /^\d[\d.]*$/ fails → return undefined
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('.nvmrc')) return 'lts/iron';
      if (String(p).endsWith('.node-version')) throw ENOENT;
      if (String(p).endsWith('package.json')) return JSON.stringify({ engines: { node: '>=20' } });
      throw ENOENT;
    });
    // falls through to package.json engines
    expect(await npmPlugin.inferVersion!('/project')).toBe('20');
  });

  it('line 77: parseEnginesNodeRange returns undefined when no digit in range (e.g. "latest")', async () => {
    // 'latest' has no digit → match is null → return undefined
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('package.json')) return JSON.stringify({ engines: { node: 'latest' } });
      throw ENOENT;
    });
    expect(await npmPlugin.inferVersion!('/project')).toBeUndefined();
  });

  it('line 84: parseEnginesNodeRange returns undefined when normalized version has non-numeric chars', async () => {
    // '>=20x' → match[1]='20x', no .x suffix to strip, fails /^\d[\d.]*$/ → undefined
    mockReadFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('package.json')) return JSON.stringify({ engines: { node: '>=20x' } });
      throw ENOENT;
    });
    expect(await npmPlugin.inferVersion!('/project')).toBeUndefined();
  });
});
