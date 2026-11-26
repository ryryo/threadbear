// The Rust catalogs use English source keys, prefixed by context and U+0004
// when two identical English labels have different meanings.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Catalog = Record<string, string>;

const root = join(import.meta.dirname, "..");
const catalogDir = join(root, "desktop/core/i18n");
const crates = ["core", "gpui", "dock", "web"];
const markers = new Set(["tr", "trf", "trn"]);
const delimiters = new Set(["(", "[", "{"]);
const separator = "\u0004";

export function readCatalog(path: string): Catalog {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.values(value).some((entry) => typeof entry !== "string")) {
    throw new Error(`${path}: expected a JSON object of message strings`);
  }
  return Object.assign(Object.create(null) as Catalog, value);
}

export function catalog(language: "en" | "ja"): Catalog {
  return readCatalog(join(catalogDir, `${language}.json`));
}

export function writeCatalog(language: "en" | "ja", entries: Catalog) {
  writeFileSync(join(catalogDir, `${language}.json`), JSON.stringify(entries, null, 2) + "\n");
}

export function glossary(): Catalog {
  return readCatalog(join(root, "shared/i18n/glossary.ja.json"));
}

export function slots(message: string): string {
  return [...new Set(message.match(/\{[A-Za-z_][A-Za-z0-9_]*\}/g))].sort().join(" ");
}

// Skip strings and comments as whole tokens, including nested block comments.
export function extractMessages(source: string, path: string): Catalog {
  const tokens: string[] = [];
  const pattern = /\/\*|\/\/[^\n]*|(?:br|r)(#*)"[\s\S]*?"\1|(?:b|c)?"(?:\\[\s\S]|[^"\\])*"|(?:b)?'(?:\\.|[^'\\\n])'|[a-zA-Z_][a-zA-Z0-9_]*|[^\s]/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const token = match[0];
    if (token === "/*") {
      let depth = 1;
      const boundary = /\/\*|\*\//g;
      boundary.lastIndex = pattern.lastIndex;
      for (let end = boundary.exec(source); end; end = boundary.exec(source)) {
        depth += end[0] === "/*" ? 1 : -1;
        if (depth === 0) break;
      }
      pattern.lastIndex = depth === 0 ? boundary.lastIndex : source.length;
    } else if (!token.startsWith("//")) {
      tokens.push(token);
    }
  }
  const entries: Catalog = Object.create(null) as Catalog;
  function readMessage(index: number): string {
    const token = tokens[index];
    if (!token?.startsWith('"')) {
      throw new Error(`${path}: translation markers require ordinary string literals`);
    }
    const value = JSON.parse(token) as string;
    if (!value || value.includes(separator)) {
      throw new Error(`${path}: invalid translation literal ${token}`);
    }
    return value;
  }
  for (let index = 0; index < tokens.length; index++) {
    const marker = tokens[index];
    if (!markers.has(marker) || tokens[index + 1] !== "!" || !delimiters.has(tokens[index + 2])) continue;
    let arg = index + 3;
    let prefix = "";
    if (tokens[arg] === "context") {
      prefix = readMessage(arg + 1) + separator;
      if (tokens[arg + 2] !== ",") throw new Error(`${path}: expected comma after context`);
      arg += 3;
    }
    const source = readMessage(arg);
    entries[prefix + source] = source;
    if (marker === "trn") {
      if (tokens[arg + 1] !== ",") throw new Error(`${path}: expected plural message`);
      const plural = readMessage(arg + 2);
      entries[prefix + plural] = plural;
    }
  }
  return entries;
}

export function extractRust(): Catalog {
  const entries: Catalog = Object.create(null) as Catalog;
  for (const crate of crates) {
    const dir = join(root, "desktop", crate, "src");
    for (const file of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(".rs")) continue;
      const path = join(file.parentPath, file.name);
      Object.assign(entries, extractMessages(readFileSync(path, "utf8"), path));
    }
  }
  return Object.fromEntries(Object.keys(entries).sort().map((key) => [key, entries[key]]));
}

if (import.meta.main) {
  const source = extractRust();
  const current = catalog("ja");
  writeCatalog("en", source);
  writeCatalog("ja", Object.fromEntries(Object.keys(source).map((key) => [key, current[key] ?? ""])));
}
