import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { catalog, extractRust } from "./i18n-extract-rust.ts";

const japanese = catalog("ja");
const missing = Object.keys(extractRust()).filter((key) => !Object.hasOwn(japanese, key) || !japanese[key].trim());
console.log(`Desktop: ${missing.length} marked messages missing Japanese translations`);
for (const key of missing) console.log(JSON.stringify(key));

// These call sites often draw visible copy. IDs, brand names and test fixtures
// can also match, so report candidates for review without treating them as keys.
const desktop = join(import.meta.dirname, "../desktop/gpui/src");
const uiLiteral = /(?:\.(?:child|tip|tooltip|label|placeholder|title)\(\s*|\bTopMenu::new\(\s*)("[A-Z](?:[^"\\\n]|\\.)+")/g;
const candidates = [];
for (const file of readdirSync(desktop, { recursive: true, withFileTypes: true })) {
  if (!file.isFile() || !file.name.endsWith(".rs") || file.name === "automation.rs") continue;
  const path = join(file.parentPath, file.name);
  const source = readFileSync(path, "utf8");
  for (const match of source.matchAll(uiLiteral)) {
    const line = source.slice(0, match.index).split("\n");
    if (line.at(-1)?.trimStart().startsWith("//")) continue;
    candidates.push(`${relative(desktop, path)}:${line.length}: ${match[1]}`);
  }
}
console.log(`Desktop: ${candidates.length} literal UI candidates to review`);
for (const candidate of candidates.sort()) console.log(candidate);
