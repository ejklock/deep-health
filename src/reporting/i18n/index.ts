import type { SupportedLocale, Locale } from './types';
import type { RawLocale } from './raw-locale';
import { buildLocale } from './loader';
import { resolveDefaultLocale } from '@core/locale-detect';
import ptBrRaw from './locales/pt-br.json';
import enRaw from './locales/en.json';

const locales: Record<SupportedLocale, Locale> = {
  'pt-br': buildLocale(ptBrRaw as unknown as RawLocale),
  en: buildLocale(enRaw as unknown as RawLocale),
};

export function getLocale(code: SupportedLocale = resolveDefaultLocale()): Locale {
  return locales[code];
}

export type { SupportedLocale, Locale };
