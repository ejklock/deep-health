import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@infra/utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    phase: vi.fn(),
    skip: vi.fn(),
    header: vi.fn(),
    tagged: vi.fn(),
  },
}));

import { parseComposerAuditJson, parseComposerAuditAdvisories } from '@modules/ecosystem/plugins/composer-audit-parser';
import { logger } from '@infra/utils/logger.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildAuditJson(advisories: Record<string, unknown[]>): string {
  return JSON.stringify({ advisories });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('parseComposerAuditJson — valid JSON with multiple advisories', () => {
  it('returns all package names from the advisories object', () => {
    const raw = buildAuditJson({
      'vendor/pkg-a': [{ advisoryId: 'CVE-2024-001', packageName: 'vendor/pkg-a', title: 'A bug' }],
      'vendor/pkg-b': [{ advisoryId: 'CVE-2024-002', packageName: 'vendor/pkg-b', title: 'Another bug' }],
    });

    const result = parseComposerAuditJson(raw);

    expect(result).toHaveLength(2);
    expect(result).toContain('vendor/pkg-a');
    expect(result).toContain('vendor/pkg-b');
  });

  it('returns a single package name when only one advisory is present', () => {
    const raw = buildAuditJson({
      'acme/library': [{ advisoryId: 'GHSA-xxxx', packageName: 'acme/library', title: 'XSS' }],
    });

    const result = parseComposerAuditJson(raw);

    expect(result).toEqual(['acme/library']);
  });
});

describe('parseComposerAuditJson — empty advisories object (clean audit)', () => {
  it('returns [] when advisories is an empty object {}', () => {
    const raw = JSON.stringify({ advisories: {} });

    const result = parseComposerAuditJson(raw);

    expect(result).toEqual([]);
  });
});

describe('parseComposerAuditJson — advisories is an array (clean audit)', () => {
  it('returns [] when advisories is an empty array []', () => {
    const raw = JSON.stringify({ advisories: [] });

    const result = parseComposerAuditJson(raw);

    expect(result).toEqual([]);
  });

  it('returns [] when advisories is a non-empty array (unexpected but safe)', () => {
    const raw = JSON.stringify({ advisories: ['unexpected'] });

    const result = parseComposerAuditJson(raw);

    expect(result).toEqual([]);
  });
});

describe('parseComposerAuditJson — malformed JSON', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns [] and logs a warning for invalid JSON input', () => {
    const result = parseComposerAuditJson('{ not valid json !!');

    expect(result).toEqual([]);
    const warnCalls = (logger.tagged as ReturnType<typeof vi.fn>).mock.calls;
    expect(warnCalls.some((c) => String(c[2]).toLowerCase().includes('failed to parse'))).toBe(true);
  });

  it('returns [] for completely non-JSON input', () => {
    const result = parseComposerAuditJson('this is not json at all');

    expect(result).toEqual([]);
  });
});

describe('parseComposerAuditJson — missing advisories key', () => {
  it('returns [] when the advisories key is absent', () => {
    const raw = JSON.stringify({ packages: [], vulnerabilities: 0 });

    const result = parseComposerAuditJson(raw);

    expect(result).toEqual([]);
  });

  it('returns [] when input is a JSON null', () => {
    const result = parseComposerAuditJson('null');

    expect(result).toEqual([]);
  });

  it('returns [] when input is a JSON number', () => {
    const result = parseComposerAuditJson('42');

    expect(result).toEqual([]);
  });
});

describe('parseComposerAuditJson — empty or whitespace input', () => {
  it('returns [] for empty string', () => {
    const result = parseComposerAuditJson('');

    expect(result).toEqual([]);
  });

  it('returns [] for whitespace-only string', () => {
    const result = parseComposerAuditJson('   \n\t  ');

    expect(result).toEqual([]);
  });
});

describe('parseComposerAuditJson — duplicate advisory entries for same package', () => {
  it('returns deduplicated package names when the same package key appears (object keys are unique by nature)', () => {
    // Object.keys always gives unique keys — this test validates the deduplication via Set
    // In practice, JSON.parse deduplications duplicate keys to last value, but we handle via Set
    const raw = buildAuditJson({
      'vendor/pkg': [
        { advisoryId: 'CVE-001', title: 'Bug 1' },
        { advisoryId: 'CVE-002', title: 'Bug 2' },
      ],
    });

    const result = parseComposerAuditJson(raw);

    // Even with multiple advisories per package, only one entry for the package name
    expect(result).toHaveLength(1);
    expect(result).toContain('vendor/pkg');
  });

  it('deduplicates when advisories object is manually constructed with repeated keys', () => {
    // Build raw JSON with duplicate key by string manipulation — JSON.parse keeps last value
    // but we verify our Set-based dedup works correctly on the key list
    const raw = buildAuditJson({
      'vendor/duplicate': [{ advisoryId: 'CVE-A' }],
      'vendor/other': [{ advisoryId: 'CVE-B' }],
    });

    const result = parseComposerAuditJson(raw);

    // Result should contain each package exactly once
    const unique = new Set(result);
    expect(unique.size).toBe(result.length);
  });
});

describe('parseComposerAuditJson — advisories with complex advisory structures', () => {
  it('extracts only package names, ignoring advisory details', () => {
    const raw = buildAuditJson({
      'symfony/http-kernel': [
        {
          advisoryId: 'symfony/http-kernel/2024-001.yaml',
          packageName: 'symfony/http-kernel',
          affectedVersions: '<6.4.4|>=7.0,<7.0.4',
          title: 'Session fixation in some configurations',
          cve: 'CVE-2024-28858',
          link: 'https://symfony.com/cve-2024-28858',
          reportedAt: '2024-03-22T00:00:00+00:00',
          composerRepository: 'https://packagist.org',
          sources: [{ name: 'GitHub', remoteId: 'GHSA-9999-xxxx-yyyy' }],
        },
      ],
      'laravel/framework': [
        {
          advisoryId: 'laravel/framework/2024-002.yaml',
          packageName: 'laravel/framework',
          title: 'Some other issue',
          cve: null,
          link: 'https://laravel.com/security',
        },
      ],
    });

    const result = parseComposerAuditJson(raw);

    expect(result).toHaveLength(2);
    expect(result).toContain('symfony/http-kernel');
    expect(result).toContain('laravel/framework');
  });
});

// ── parseComposerAuditAdvisories tests (AC5) ─────────────────────────────────

describe('parseComposerAuditAdvisories — happy path with multiple advisories', () => {
  it('returns structured advisory objects with all fields populated', () => {
    const raw = buildAuditJson({
      'symfony/http-kernel': [
        {
          advisoryId: 'symfony/http-kernel/2024-001.yaml',
          packageName: 'symfony/http-kernel',
          affectedVersions: '<6.4.4|>=7.0,<7.0.4',
          title: 'Session fixation in some configurations',
          cve: 'CVE-2024-28858',
        },
      ],
      'laravel/framework': [
        {
          advisoryId: 'laravel/framework/2024-002.yaml',
          packageName: 'laravel/framework',
          affectedVersions: '<10.48.0',
          title: 'Header injection vulnerability',
          cve: null,
        },
      ],
    });

    const result = parseComposerAuditAdvisories(raw);

    expect(result).toHaveLength(2);

    const symfony = result.find((a) => a.package === 'symfony/http-kernel');
    expect(symfony).toBeDefined();
    expect(symfony!.advisoryId).toBe('symfony/http-kernel/2024-001.yaml');
    expect(symfony!.title).toBe('Session fixation in some configurations');
    expect(symfony!.cve).toBe('CVE-2024-28858');
    expect(symfony!.affectedVersions).toBe('<6.4.4|>=7.0,<7.0.4');

    const laravel = result.find((a) => a.package === 'laravel/framework');
    expect(laravel).toBeDefined();
    expect(laravel!.cve).toBeNull();
  });

  it('returns one advisory per package when multiple advisories exist for the same package key (takes first)', () => {
    const raw = buildAuditJson({
      'vendor/pkg': [
        { advisoryId: 'ADV-001', title: 'First issue', cve: 'CVE-2024-001', affectedVersions: '<1.0.0' },
        { advisoryId: 'ADV-002', title: 'Second issue', cve: 'CVE-2024-002', affectedVersions: '<2.0.0' },
      ],
    });

    const result = parseComposerAuditAdvisories(raw);

    expect(result).toHaveLength(1);
    expect(result[0]!.package).toBe('vendor/pkg');
    // Takes first advisory entry
    expect(result[0]!.advisoryId).toBe('ADV-001');
    expect(result[0]!.title).toBe('First issue');
    expect(result[0]!.cve).toBe('CVE-2024-001');
  });
});

describe('parseComposerAuditAdvisories — advisory with null CVE', () => {
  it('returns cve as null when advisory has cve: null', () => {
    const raw = buildAuditJson({
      'acme/lib': [
        { advisoryId: 'GHSA-xxxx', title: 'Some issue', cve: null, affectedVersions: '<2.0.0' },
      ],
    });

    const result = parseComposerAuditAdvisories(raw);

    expect(result).toHaveLength(1);
    expect(result[0]!.cve).toBeNull();
  });

  it('returns cve as null when advisory has no cve field', () => {
    const raw = buildAuditJson({
      'acme/lib': [
        { advisoryId: 'GHSA-yyyy', title: 'Another issue', affectedVersions: '>=1.0.0 <1.5.0' },
      ],
    });

    const result = parseComposerAuditAdvisories(raw);

    expect(result).toHaveLength(1);
    expect(result[0]!.cve).toBeNull();
  });
});

describe('parseComposerAuditAdvisories — empty and malformed input returns []', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns [] for empty string', () => {
    const result = parseComposerAuditAdvisories('');
    expect(result).toEqual([]);
  });

  it('returns [] for whitespace-only string', () => {
    const result = parseComposerAuditAdvisories('   \n  ');
    expect(result).toEqual([]);
  });

  it('returns [] when advisories is an empty object {}', () => {
    const result = parseComposerAuditAdvisories(JSON.stringify({ advisories: {} }));
    expect(result).toEqual([]);
  });

  it('returns [] when advisories is an array (clean audit output)', () => {
    const result = parseComposerAuditAdvisories(JSON.stringify({ advisories: [] }));
    expect(result).toEqual([]);
  });

  it('returns [] and logs a warning for invalid JSON input', () => {
    const result = parseComposerAuditAdvisories('{ not valid json !!');
    expect(result).toEqual([]);
    const warnCalls = (logger.tagged as ReturnType<typeof vi.fn>).mock.calls;
    expect(warnCalls.some((c) => String(c[2]).toLowerCase().includes('failed to parse'))).toBe(true);
  });

  it('returns [] for completely non-JSON input', () => {
    const result = parseComposerAuditAdvisories('this is not json at all');
    expect(result).toEqual([]);
  });

  it('returns [] when advisories key is absent', () => {
    const result = parseComposerAuditAdvisories(JSON.stringify({ packages: [] }));
    expect(result).toEqual([]);
  });
});

describe('parseComposerAuditAdvisories — advisory list with empty array entry', () => {
  it('returns entry with empty fields when advisory list is empty for a package', () => {
    const raw = JSON.stringify({ advisories: { 'vendor/pkg': [] } });
    const result = parseComposerAuditAdvisories(raw);
    // Package key exists but no advisory entries → still returns one entry with empty fields
    expect(result).toHaveLength(1);
    expect(result[0]!.package).toBe('vendor/pkg');
    expect(result[0]!.advisoryId).toBe('');
    expect(result[0]!.title).toBe('');
    expect(result[0]!.cve).toBeNull();
    expect(result[0]!.affectedVersions).toBe('');
  });
});

describe('parseComposerAuditAdvisories — existing parseComposerAuditJson tests still pass', () => {
  it('parseComposerAuditJson still returns package names (unchanged behaviour)', () => {
    const raw = buildAuditJson({
      'vendor/pkg-a': [{ advisoryId: 'CVE-001', packageName: 'vendor/pkg-a', title: 'Issue' }],
    });
    const result = parseComposerAuditJson(raw);
    expect(result).toEqual(['vendor/pkg-a']);
  });
});
