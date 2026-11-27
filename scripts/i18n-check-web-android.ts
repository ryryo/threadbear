// Like T3 Code's CI check, compare the committed source catalog to a fresh
// extraction and require matching keys for every supported translation.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCatalog, slots, type Catalog } from "./i18n-extract-rust.ts";
import webConfig from "../web/gt.config.json" with { type: "json" };

const root = join(import.meta.dirname, "..");

function stringFormat(copy: string): string {
  return [...copy.matchAll(/%%|%(?:\d+\$)?[sd]/g)].filter(([slot]) => slot !== "%%")
    .map(([slot]) => slot).sort().join(" ");
}

function pairedCatalogProblems(surface: string, source: Catalog, japanese: Catalog): string[] {
  const errors: string[] = [];
  for (const [key, message] of Object.entries(source)) {
    const translation = japanese[key];
    if (!translation?.trim()) errors.push(`${surface}: missing Japanese translation for ${JSON.stringify(key)}`);
    else if (slots(message) !== slots(translation) || stringFormat(message) !== stringFormat(translation)) {
      errors.push(`${surface}: substitutions differ for ${JSON.stringify(key)}`);
    }
  }
  for (const key of Object.keys(japanese)) {
    if (!Object.hasOwn(source, key)) errors.push(`${surface}: stale key ${JSON.stringify(key)}`);
  }
  return errors;
}

export function androidCatalogPath(locale: string): string {
  return join(root, "android-native/app/src/main/res", locale, "strings.xml");
}

export const androidString = /<string\s+name="([a-z0-9_]+)">([\s\S]*?)<\/string>/g;

export function androidStrings(locale: string): Catalog {
  const path = androidCatalogPath(locale);
  const xml = readFileSync(path, "utf8").replace(/<!--[\s\S]*?-->/g, "");
  const strings = Object.create(null) as Catalog;
  for (const [, key, value] of xml.matchAll(androidString)) {
    if (Object.hasOwn(strings, key)) throw new Error(`${path}: duplicate resource ${key}`);
    strings[key] = value;
  }
  if (!Object.keys(strings).length || Object.keys(strings).length !== (xml.match(/<string\s/g) ?? []).length) {
    throw new Error(`${path}: expected a simple Android string resource catalog`);
  }
  return strings;
}

function webSourceProblems(english: Catalog): string[] {
  const temp = mkdtempSync(join(tmpdir(), "threadbear-web-i18n-"));
  try {
    const output = join(temp, "[locale].json");
    const config = join(temp, "gt.config.json");
    writeFileSync(config, JSON.stringify({ ...webConfig, files: { gt: { output } } }));
    // GT's generate command extracts source locally. Its alternate output
    // keeps validation from rewriting either of the app's catalogs.
    execFileSync(process.execPath, [
      join(root, "node_modules/gt/bin/main.js"),
      "generate", "--config", config, "--omit-config-ids",
    ], { cwd: root, timeout: 30_000 });
    const fresh = readCatalog(join(temp, "en.json"));
    const keys = new Set([...Object.keys(english), ...Object.keys(fresh)]);
    const changed = [...keys].filter((key) => fresh[key] !== english[key]);
    return changed.map((key) => `Web: stale source key ${key}. Run npm run web:i18n:generate.`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const web = join(root, "web/src/i18n/translations");
  const webEnglish = readCatalog(join(web, "en.json"));
  const errors = [
    ...webSourceProblems(webEnglish),
    ...pairedCatalogProblems("Web", webEnglish, readCatalog(join(web, "ja.json"))),
    ...pairedCatalogProblems("Android", androidStrings("values"), androidStrings("values-ja")),
  ];
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Web and Android translation catalogs passed their checks.");
  }
}
