import type { SupportedLocale, Locale } from './types.js';
import type { RawLocale } from './raw-locale.js';
import { buildLocale } from './loader.js';
import ptBrRaw from './locales/pt-br.json';
import enRaw from './locales/en.json';

const locales: Record<SupportedLocale, Locale> = {
  'pt-br': buildLocale(ptBrRaw as unknown as RawLocale),
  en: buildLocale(enRaw as unknown as RawLocale),
};

export function getLocale(code: SupportedLocale = 'pt-br'): Locale {
  return locales[code];
}

export type { SupportedLocale, Locale };
