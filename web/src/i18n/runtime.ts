import { getTranslationsSnapshot } from 'gt-react';
import { readLanguage, setLanguage, subscribeLanguage } from '../language';
import { initializeI18n } from './initializeI18n';
import { DEFAULT_LOCALE, resolveWebLocale, type CatalogLocale } from './locales';
import { setActiveLocale } from './messages';

type LocaleTranslations = Awaited<ReturnType<typeof getTranslationsSnapshot>>;
const listeners = new Set<() => void>();
const loaded: LocaleTranslations = { en: {} };
let loadJapanese: Promise<void> | undefined;
let requested: CatalogLocale = DEFAULT_LOCALE;
let snapshot: { locale: CatalogLocale; translations: LocaleTranslations } = {
  locale: DEFAULT_LOCALE, translations: { ...loaded },
};

function activate(locale: CatalogLocale): void {
  if (requested !== locale) return;
  if (locale === 'ja' && !loaded.ja) {
    // If the Japanese bundle fails to load, keep English and allow a retry.
    locale = 'en';
  }
  document.documentElement.lang = locale;
  if (snapshot.locale === locale) return;
  snapshot = { locale, translations: { ...loaded } };
  setActiveLocale(locale);
  for (const listener of listeners) listener();
}

function applyLanguage(): void {
  const locale = resolveWebLocale(readLanguage(), navigator.languages);
  requested = locale;
  if (locale === 'en' || loaded.ja) {
    activate(locale);
    return;
  }
  loadJapanese ??= getTranslationsSnapshot(locale).then((result) => {
    if (result.ja && Object.keys(result.ja).length) loaded.ja = result.ja;
  }).catch(() => undefined).finally(() => { loadJapanese = undefined; });
  void loadJapanese.then(() => activate(locale));
}

export function persistGTLocale(locale: string): void {
  if (locale === 'en' || locale === 'ja') setLanguage(locale);
}

export function startI18n(): void {
  initializeI18n(persistGTLocale);
  subscribeLanguage(applyLanguage);
  applyLanguage();
}

export function subscribeI18n(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getI18nSnapshot() {
  return snapshot;
}
