import type { SupportedLocale } from './types/locale';

/**
 * Reads POSIX locale env vars in priority order and returns a normalized
 * BCP-47-ish tag (e.g. 'pt_BR.UTF-8' → 'pt-br').
 *
 * Priority: LANGUAGE (first entry) > LC_ALL > LC_MESSAGES > LANG
 * Falls back to Intl.DateTimeFormat().resolvedOptions().locale.
 * Returns empty string when all methods fail.
 */
export function detectSystemLocale(): string {
  const candidates: (string | undefined)[] = [
    // LANGUAGE may hold a colon-separated list; take the first entry
    process.env['LANGUAGE']?.split(':')[0],
    process.env['LC_ALL'],
    process.env['LC_MESSAGES'],
    process.env['LANG'],
  ];

  for (const raw of candidates) {
    if (raw && raw.trim() !== '') {
      return normalizeTag(raw);
    }
  }

  // Intl fallback
  try {
    const tag = new Intl.DateTimeFormat().resolvedOptions().locale;
    if (tag && tag.trim() !== '') {
      return normalizeTag(tag);
    }
  } catch {
    // Intl unavailable — return empty string
  }

  return '';
}

/**
 * Strips encoding suffix and normalizes underscores to hyphens + lowercase.
 * 'pt_BR.UTF-8' → 'pt-br'
 * 'en_US'       → 'en-us'
 */
function normalizeTag(raw: string): string {
  return raw
    .split('.')[0]   // strip encoding suffix (.UTF-8, .utf8, etc.)
    .replace(/_/g, '-')
    .toLowerCase();
}

/**
 * Maps a detected locale tag to a SupportedLocale.
 * - starts with 'pt' → 'pt-br'
 * - starts with 'en' → 'en'
 * - anything else    → 'en' (English fallback)
 */
export function resolveDefaultLocale(): SupportedLocale {
  const tag = detectSystemLocale();

  if (tag.startsWith('pt')) return 'pt-br';
  if (tag.startsWith('en')) return 'en';

  return 'en';
}
