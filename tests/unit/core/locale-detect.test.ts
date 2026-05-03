/**
 * Tests for src/core/locale-detect.ts
 * Covers: env var priority, encoding stripping, Intl fallback, empty-string fallback,
 * and resolveDefaultLocale mapping.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { detectSystemLocale, resolveDefaultLocale } from '@core/locale-detect';

// Helper: clear all POSIX locale env vars
function clearLocaleEnv() {
  delete process.env['LANGUAGE'];
  delete process.env['LC_ALL'];
  delete process.env['LC_MESSAGES'];
  delete process.env['LANG'];
}

afterEach(() => {
  vi.restoreAllMocks();
  clearLocaleEnv();
});

describe('detectSystemLocale()', () => {
  it('returns empty string when no env var is set and Intl is unavailable', () => {
    clearLocaleEnv();
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(
      () => { throw new Error('Intl unavailable'); },
    );
    expect(detectSystemLocale()).toBe('');
  });

  it('uses LANGUAGE (first entry) when set', () => {
    clearLocaleEnv();
    process.env['LANGUAGE'] = 'pt_BR.UTF-8:en_US';
    expect(detectSystemLocale()).toBe('pt-br');
  });

  it('uses LC_ALL when LANGUAGE is not set', () => {
    clearLocaleEnv();
    process.env['LC_ALL'] = 'en_US.UTF-8';
    expect(detectSystemLocale()).toBe('en-us');
  });

  it('uses LC_MESSAGES when LANGUAGE and LC_ALL are not set', () => {
    clearLocaleEnv();
    process.env['LC_MESSAGES'] = 'fr_FR.UTF-8';
    expect(detectSystemLocale()).toBe('fr-fr');
  });

  it('uses LANG when LANGUAGE, LC_ALL, and LC_MESSAGES are not set', () => {
    clearLocaleEnv();
    process.env['LANG'] = 'de_DE.UTF-8';
    expect(detectSystemLocale()).toBe('de-de');
  });

  it('LANGUAGE has higher priority than LC_ALL', () => {
    clearLocaleEnv();
    process.env['LANGUAGE'] = 'pt_BR';
    process.env['LC_ALL'] = 'en_US.UTF-8';
    expect(detectSystemLocale()).toBe('pt-br');
  });

  it('LC_ALL has higher priority than LC_MESSAGES', () => {
    clearLocaleEnv();
    process.env['LC_ALL'] = 'en_US.UTF-8';
    process.env['LC_MESSAGES'] = 'fr_FR.UTF-8';
    expect(detectSystemLocale()).toBe('en-us');
  });

  it('LC_MESSAGES has higher priority than LANG', () => {
    clearLocaleEnv();
    process.env['LC_MESSAGES'] = 'es_ES.UTF-8';
    process.env['LANG'] = 'de_DE.UTF-8';
    expect(detectSystemLocale()).toBe('es-es');
  });

  it('strips encoding suffix (pt_BR.UTF-8 → pt-br)', () => {
    clearLocaleEnv();
    process.env['LANG'] = 'pt_BR.UTF-8';
    expect(detectSystemLocale()).toBe('pt-br');
  });

  it('normalizes underscores to hyphens and lowercases', () => {
    clearLocaleEnv();
    process.env['LANG'] = 'zh_CN';
    expect(detectSystemLocale()).toBe('zh-cn');
  });

  it('uses Intl fallback when no env var is set', () => {
    clearLocaleEnv();
    vi.spyOn(Intl, 'DateTimeFormat').mockReturnValue({
      resolvedOptions: () => ({ locale: 'pt-BR' } as Intl.ResolvedDateTimeFormatOptions),
    } as Intl.DateTimeFormat);
    // Intl returns 'pt-BR', normalized → 'pt-br'
    expect(detectSystemLocale()).toBe('pt-br');
  });

  it('returns empty string when Intl.locale is empty', () => {
    clearLocaleEnv();
    vi.spyOn(Intl, 'DateTimeFormat').mockReturnValue({
      resolvedOptions: () => ({ locale: '' } as Intl.ResolvedDateTimeFormatOptions),
    } as Intl.DateTimeFormat);
    expect(detectSystemLocale()).toBe('');
  });
});

describe('resolveDefaultLocale()', () => {
  it('returns pt-br for pt_BR locale', () => {
    clearLocaleEnv();
    process.env['LANG'] = 'pt_BR.UTF-8';
    expect(resolveDefaultLocale()).toBe('pt-br');
  });

  it('returns pt-br for pt locale (no region)', () => {
    clearLocaleEnv();
    process.env['LANG'] = 'pt';
    expect(resolveDefaultLocale()).toBe('pt-br');
  });

  it('returns en for en_US locale', () => {
    clearLocaleEnv();
    process.env['LANG'] = 'en_US.UTF-8';
    expect(resolveDefaultLocale()).toBe('en');
  });

  it('returns en for en locale (no region)', () => {
    clearLocaleEnv();
    process.env['LANG'] = 'en';
    expect(resolveDefaultLocale()).toBe('en');
  });

  it('returns en (fallback) for unknown locale (fr)', () => {
    clearLocaleEnv();
    process.env['LANG'] = 'fr_FR.UTF-8';
    expect(resolveDefaultLocale()).toBe('en');
  });

  it('returns en (fallback) when no env var is set and Intl is unavailable', () => {
    clearLocaleEnv();
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(
      () => { throw new Error('Intl unavailable'); },
    );
    expect(resolveDefaultLocale()).toBe('en');
  });
});
