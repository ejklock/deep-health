/**
 * Tests for src/infrastructure/utils/ui.ts
 * Pure string-builder module — no I/O side effects.
 */
import { describe, it, expect } from 'vitest';
import { SCANNER_COLORS, badge, divider, tag } from '@infra/utils/ui';

// Strips SGR ANSI escape sequences so we can assert on plain text.
function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

// ─── SCANNER_COLORS ───────────────────────────────────────────────────────────

describe('SCANNER_COLORS', () => {
  it.each(['osv', 'sonarqube', 'npm', 'composer', 'pip'])(
    'has a color entry for scanner "%s"',
    (id) => {
      expect(SCANNER_COLORS.has(id)).toBe(true);
    },
  );

  it('contains exactly five scanner entries', () => {
    expect(SCANNER_COLORS.size).toBe(5);
  });
});

// ─── badge() ──────────────────────────────────────────────────────────────────

describe('badge()', () => {
  it('uppercases the scanner id inside brackets', () => {
    expect(stripAnsi(badge('osv'))).toBe('[OSV]');
  });

  it('works for every registered scanner', () => {
    for (const id of ['osv', 'sonarqube', 'npm', 'composer', 'pip']) {
      expect(stripAnsi(badge(id))).toBe(`[${id.toUpperCase()}]`);
    }
  });

  it('falls back gracefully for an unknown scanner id', () => {
    const result = badge('unknown-engine');
    expect(typeof result).toBe('string');
    expect(stripAnsi(result)).toBe('[UNKNOWN-ENGINE]');
  });

  it('always returns a non-empty string', () => {
    expect(badge('osv').length).toBeGreaterThan(0);
  });
});

// ─── divider() ────────────────────────────────────────────────────────────────

describe('divider()', () => {
  it('returns exactly 60 characters when called with no label', () => {
    expect(stripAnsi(divider())).toHaveLength(60);
  });

  it('returns exactly 60 characters when label is an empty string', () => {
    expect(stripAnsi(divider(''))).toHaveLength(60);
  });

  it('returns exactly 60 characters when a label is provided', () => {
    expect(stripAnsi(divider('scan'))).toHaveLength(60);
  });

  it('contains the uppercased label text', () => {
    expect(stripAnsi(divider('npm'))).toContain('NPM');
  });

  it('pads symmetrically around the label', () => {
    const raw = stripAnsi(divider('x'));
    // Both halves should be filled with the divider character '─'
    expect(raw).toMatch(/^─+\s.*\s─+$/);
  });

  it('uses the divider character for a label-less line', () => {
    const raw = stripAnsi(divider());
    expect(raw).toMatch(/^─+$/);
  });
});

// ─── tag() ────────────────────────────────────────────────────────────────────

describe('tag()', () => {
  it('contains the literal bracket label substring for a known id', () => {
    const result = tag('osv', 'OSV verify');
    expect(stripAnsi(result)).toContain('[OSV verify]');
  });

  it('prepends a badge before the bracket label', () => {
    const result = stripAnsi(tag('npm', 'npm-audit fix'));
    expect(result).toMatch(/^\[NPM\] \[npm-audit fix\]$/);
  });

  it('falls back gracefully for an unknown id', () => {
    const result = tag('unknown-xyz', 'My Label');
    const plain = stripAnsi(result);
    expect(plain).toContain('[My Label]');
    expect(plain).toContain('[UNKNOWN-XYZ]');
  });

  it('preserves the label verbatim (no uppercasing of label)', () => {
    const result = stripAnsi(tag('osv', 'OSV fix'));
    expect(result).toContain('[OSV fix]');
  });
});
