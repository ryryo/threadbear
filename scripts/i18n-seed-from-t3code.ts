// Run with a checkout or a directory containing the catalog paths in the manifest.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { catalog, glossary, readCatalog, slots, writeCatalog } from "./i18n-extract-rust.ts";
import { androidCatalogPath, androidString, androidStrings } from "./i18n-check-web-android.ts";
import manifest from "../third_party/t3code/manifest.json" with { type: "json" };

const upstream = process.argv[2];
const surface = process.argv[3] ?? "desktop";
if (!upstream || !["desktop", "web", "android"].includes(surface)) {
  throw new Error("Usage: node scripts/i18n-seed-from-t3code.ts <pinned T3 Code directory> [desktop|web|android]");
}

function readPinned(path: string): Record<string, unknown> {
  const bytes = readFileSync(join(upstream, path));
  const expected = manifest.sources.find((entry) => entry.path === path)?.blob;
  const actual = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  if (expected !== actual) throw new Error(`${path}: Git blob does not match ${manifest.commit}`);
  return JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
}

const candidates = new Map<string, Map<string, string>>();
for (const app of ["desktop", "web", "mobile"]) {
  const dir = `apps/${app}/src/i18n/translations`;
  if (!existsSync(join(upstream, dir, "en.json")) && !existsSync(join(upstream, dir, "ja.json"))) continue;
  const english = readPinned(`${dir}/en.json`);
  const japanese = readPinned(`${dir}/ja.json`);
  for (const [key, source] of Object.entries(english)) {
    const target = japanese[key];
    if (typeof source !== "string" || typeof target !== "string" || !target.trim()) continue;
    const message = source.replaceAll("T3 Code", "Threadbear");
    const translation = target.replaceAll("T3 Code", "Threadbear").replaceAll("ブラウザー", "ブラウザ");
    if (slots(message) !== slots(translation)) continue;
    const matches = candidates.get(message) ?? new Map<string, string>();
    matches.set(translation, `${dir}/ja.json#${key}`);
    candidates.set(message, matches);
  }
}
if (!candidates.size) throw new Error("No pinned T3 Code message pairs found");

const terms = glossary();
function seed(key: string, message: string): string | undefined {
  if (Object.hasOwn(terms, key)) {
    console.log(`${JSON.stringify(key)}: glossary`);
    return terms[key];
  }
  // An explicit context requires human review before reusing a bare label.
  const matches = candidates.get(message);
  if (key !== message || matches?.size !== 1) return;
  for (const [translation, source] of matches) {
    console.log(`${JSON.stringify(key)}: ${source}`);
    return translation;
  }
}

function seedAndroid(): void {
  const source = androidStrings("values");
  const path = androidCatalogPath("values-ja");
  const xml = readFileSync(path, "utf8");
  const japanese = androidStrings("values-ja");
  const additions = Object.create(null) as Record<string, string>;
  for (const [key, message] of Object.entries(source)) {
    // Named T3 Code arguments do not map directly to Android positional ones.
    if (japanese[key]?.trim() || message.includes("%") || message.includes("&") || message.includes("<")) continue;
    const text = message.replaceAll("\\'", "'");
    const translation = seed(text, text);
    if (!translation) continue;
    additions[key] = translation.replaceAll("\\", "\\\\").replaceAll("'", "\\'").replaceAll('"', '\\"')
      .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  }
  if (!Object.keys(additions).length) return;
  const updated = xml.replace(androidString, (entry, key: string) => {
    if (!Object.hasOwn(additions, key)) return entry;
    const value = additions[key];
    delete additions[key];
    return `<string name="${key}">${value}</string>`;
  });
  const added = Object.entries(additions).map(([key, value]) => `    <string name="${key}">${value}</string>\n`).join("");
  writeFileSync(path, updated.replace("</resources>", () => added + "</resources>"));
}

if (surface === "android") {
  seedAndroid();
} else {
  const web = join(import.meta.dirname, "../web/src/i18n/translations");
  const english = surface === "desktop" ? catalog("en") : readCatalog(join(web, "en.json"));
  const japanese = surface === "desktop" ? catalog("ja") : readCatalog(join(web, "ja.json"));
  for (const [key, message] of Object.entries(english)) {
    if (Object.hasOwn(japanese, key) && japanese[key].trim() && !(surface === "web" && japanese[key] === message)) continue;
    const translation = seed(surface === "web" ? message : key, message);
    if (translation) japanese[key] = translation;
  }
  if (surface === "desktop") writeCatalog("ja", japanese);
  else writeFileSync(join(web, "ja.json"), JSON.stringify(japanese, null, 2) + "\n");
}
