// Run with a checkout or a directory containing the catalog paths in the manifest.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { catalog, glossary, slots, writeCatalog } from "./i18n-extract-rust.ts";
import manifest from "../third_party/t3code/manifest.json" with { type: "json" };

const upstream = process.argv[2];
if (!upstream) throw new Error("Usage: node scripts/i18n-seed-from-t3code.ts <pinned T3 Code directory>");

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
const japanese = catalog("ja");
for (const [key, message] of Object.entries(catalog("en"))) {
  if (Object.hasOwn(japanese, key) && japanese[key].trim()) continue;
  if (Object.hasOwn(terms, key)) {
    japanese[key] = terms[key];
    console.log(`${JSON.stringify(key)}: glossary`);
    continue;
  }
  // An explicit context requires human review before reusing a bare label.
  const matches = candidates.get(message);
  if (key !== message || matches?.size !== 1) continue;
  for (const [translation, source] of matches) {
    japanese[key] = translation;
    console.log(`${JSON.stringify(key)}: ${source}`);
  }
}
writeCatalog("ja", japanese);
