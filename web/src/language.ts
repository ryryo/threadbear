// Keep the browser's language independent of its sign-in and appearance.
export type Language = 'system' | 'en' | 'ja';

const key = 'threadbear.language';
const listeners = new Set<() => void>();

export function readLanguage(): Language {
  const saved = localStorage.getItem(key);
  return saved === 'en' || saved === 'ja' ? saved : 'system';
}

export function setLanguage(language: Language): void {
  if (language === 'system') localStorage.removeItem(key);
  else localStorage.setItem(key, language);
  changed();
}

function changed(): void {
  for (const listener of listeners) listener();
}

function storageChanged(event: StorageEvent): void {
  if (event.key === key || event.key === null) changed();
}

export function subscribeLanguage(listener: () => void): () => void {
  if (!listeners.size) {
    window.addEventListener('languagechange', changed);
    window.addEventListener('storage', storageChanged);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      window.removeEventListener('languagechange', changed);
      window.removeEventListener('storage', storageChanged);
    }
  };
}
