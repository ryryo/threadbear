import type { Language } from '../language.ts';

export const DEFAULT_LOCALE = 'en';
export const SUPPORTED_LOCALES = [DEFAULT_LOCALE, 'ja'] as const;
export type CatalogLocale = (typeof SUPPORTED_LOCALES)[number];

export function resolveWebLocale(language: Language, browserLocales: readonly string[]): CatalogLocale {
  if (language !== 'system') return language;
  for (const tag of browserLocales) {
    const locale = tag.trim().toLowerCase().split(/[-_]/)[0];
    if (locale === 'en' || locale === 'ja') return locale;
  }
  return DEFAULT_LOCALE;
}
