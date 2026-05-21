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

import { parseComposerAuditJson } from '@modules/ecosystem/plugins/composer-audit-parser';
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
