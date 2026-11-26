import assert from "node:assert/strict";
import { test } from "node:test";
import { problems } from "./i18n-check.ts";
import { extractMessages } from "./i18n-extract-rust.ts";

test("extracts contextual labels and both plural forms, ignoring comments and strings", () => {
  const rust = [
    "/* /* tr!(\"Ignored\") */ tr!(\"Ignored\") */",
    'let sample = r#"tr!("Ignored")"#;',
    '// tr!("Ignored")',
    'tr![context "button", "Open"];',
    'trn!("{count} thread", "{count} threads", count);',
    'trf!{"PID {pid}", pid = id};',
  ].join("\n");
  assert.deepEqual({ ...extractMessages(rust, "example.rs") }, {
    "button\u0004Open": "Open",
    "{count} thread": "{count} thread",
    "{count} threads": "{count} threads",
    "PID {pid}": "PID {pid}",
  });
  assert.throws(() => extractMessages("tr!(label)", "example.rs"), /string literals/);
});

test("rejects missing, stale, and incompatible translations", () => {
  const source = { "PID {pid}": "PID {pid}", Inbox: "Inbox" };
  const terms = { Inbox: "受信トレイ" };
  assert.deepEqual(problems({}, {}, {}, {}), []);
  assert.deepEqual(problems(source, source, { Inbox: "受信トレイ", "PID {pid}": "{pid} の PID" }, terms), []);
  assert.match(problems(source, source, { "PID {pid}": "PID", Old: "過去" }, terms).join("\n"),
    /substitutions differ[\s\S]*missing translation[\s\S]*stale key/);
  assert.match(problems(source, {}, { Inbox: "受信箱" }, terms).join("\n"),
    /en.json: missing[\s\S]*glossary/);
});
