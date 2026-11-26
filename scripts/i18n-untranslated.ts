import { catalog, extractRust } from "./i18n-extract-rust.ts";

const japanese = catalog("ja");
const missing = Object.keys(extractRust()).filter((key) => !Object.hasOwn(japanese, key) || !japanese[key].trim());
console.log(`Desktop: ${missing.length} marked messages missing Japanese translations`);
for (const key of missing) console.log(JSON.stringify(key));
