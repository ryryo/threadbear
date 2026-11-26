// Like T3 Code's CI check, compare the committed source catalog to a fresh
// extraction and require matching keys for every supported translation.
import { catalog, extractRust, glossary, slots, type Catalog } from "./i18n-extract-rust.ts";

export function problems(source: Catalog, english: Catalog, japanese: Catalog, terms: Catalog): string[] {
  const errors: string[] = [];
  for (const [key, message] of Object.entries(source)) {
    const name = JSON.stringify(key);
    if (english[key] !== message) errors.push(`en.json: missing or changed key ${name}`);
    const translation = japanese[key];
    if (!Object.hasOwn(japanese, key) || !translation.trim()) {
      errors.push(`ja.json: missing translation for ${name}`);
      continue;
    }
    if (slots(message) !== slots(translation)) errors.push(`ja.json: substitutions differ for ${name}`);
    if (Object.hasOwn(terms, key) && translation !== terms[key]) {
      errors.push(`ja.json: use glossary translation for ${name}`);
    }
    if (translation.includes("ブラウザー")) errors.push(`ja.json: use ブラウザ in ${name}`);
  }
  for (const [file, entries] of [["en.json", english], ["ja.json", japanese]] as const) {
    for (const key of Object.keys(entries)) {
      if (!Object.hasOwn(source, key)) errors.push(`${file}: stale key ${JSON.stringify(key)}`);
    }
  }
  return errors;
}

if (import.meta.main) {
  const errors = problems(extractRust(), catalog("en"), catalog("ja"), glossary());
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Desktop translation catalogs match their source.");
  }
}
