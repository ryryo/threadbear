import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

function runPorted(files: string[], count: number): void {
  const tests = files.map(file => fileURLToPath(new URL(`../../ported-dsbot/${file}`, import.meta.url)));
  // This is a separate test runner. Inheriting its parent's context makes
  // node:test skip nested test files and exit successfully without tests.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const report = execFileSync(process.execPath, ['--test', '--test-reporter=tap', ...tests], { encoding: 'utf8', env });
  assert.match(report, new RegExp(`^# tests ${count}\\r?$`, 'm'));
  assert.match(report, new RegExp(`^# pass ${count}\\r?$`, 'm'));
}

test('the ported DS-Bot memory format and recovery tests pass in the Runner', () => {
  runPorted(['memory-entries.test.js', 'memory-journal.test.js', 'personal-memory.test.js', 'memory-erasure.test.js', 'review-lines.test.js', 'tidy-draft.test.js'], 29);
});

test('the ported DS-Bot request and delivery tests pass in the Runner', () => {
  runPorted([
    'request-receipts.test.js', 'request-ledger.test.ts', 'request-dispatch.test.ts', 'request-events.test.ts',
    'request-graph.test.ts', 'request-return.test.ts', 'request-state.test.ts', 'handoff-result.test.ts',
  ], 14);
});

test('the ported DS-Bot Group history search tests pass in the Runner', () => {
  runPorted(['group-search.test.js'], 6);
});

test('the pinned DS-Bot baseline and direct ports match their recorded source', () => {
  const root = new URL('../../../../', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('third_party/dsbot/manifest.json', root), 'utf8')) as {
    files: { baselinePath: string; sha256: string; upstreamBlob: string; portMode: string; portPath?: string }[];
  };
  for (const entry of manifest.files) {
    const baseline = readFileSync(new URL(entry.baselinePath, root));
    assert.equal(createHash('sha256').update(baseline).digest('hex'), entry.sha256, entry.baselinePath);
    assert.equal(createHash('sha1').update(`blob ${baseline.length}\0`).update(baseline).digest('hex'), entry.upstreamBlob, entry.baselinePath);
    if (entry.portMode !== 'A' || entry.portPath === undefined) continue;
    const port = readFileSync(new URL(entry.portPath, root));
    assert.ok(port.subarray(port.indexOf('\n\n') + 2).equals(baseline), entry.portPath);
  }
});

test('the profile cards, CSS and Japanese labels come from the pinned client source', () => {
  const root = new URL('../../../../', import.meta.url);
  const upstream = new URL('third_party/dsbot/baseline/ds-bot/src/client/', root);
  const port = new URL('runner/src/bots/profile-panel/', root);
  const settings = readFileSync(new URL('bot-settings.js', upstream), 'utf8');
  const shared = readFileSync(new URL('styles.js', upstream), 'utf8');
  const cards = readFileSync(new URL('profile-cards.mjs', port), 'utf8');
  const component = (source: string, name: 'Row' | 'Card') => source.match(new RegExp(`^export function ${name}\\(.*?^}\\n`, 'ms'))?.[0];
  for (const name of ['Row', 'Card'] as const) {
    const original = component(settings, name);
    assert.ok(original);
    assert.equal(component(cards, name), original);
  }
  for (const line of cards.split('\n').filter(line => line.startsWith('    h(Card,') || line.includes('h(Row,') && line.includes("t('"))) {
    assert.ok(settings.includes(line), line);
  }
  const rules = readFileSync(new URL('profile-cards.css', port), 'utf8').split('\n').filter(line => line && !line.startsWith('/*'));
  assert.ok(rules.length > 20);
  for (const rule of rules) assert.ok(settings.includes(rule) || shared.includes(rule), rule);
  const originals = readFileSync(new URL('locales/ja.js', upstream), 'utf8');
  const labels = JSON.parse(readFileSync(new URL('profile-ja.json', port), 'utf8')) as Record<string, string>;
  for (const [key, label] of Object.entries(labels)) assert.ok(originals.includes(`${JSON.stringify(key)}: ${JSON.stringify(label)}`), key);
  const extract = (source: string, name: string) => source.match(new RegExp(`^${name}.*?^}\\n`, 'ms'))?.[0];
  const memory = readFileSync(new URL('memory-panel.js', upstream), 'utf8');
  const hook = readFileSync(new URL('memory-count.mjs', port), 'utf8');
  for (const name of ['function noteCount', 'export function useMemoryCount']) {
    assert.ok(extract(memory, name));
    assert.equal(extract(hook, name), extract(memory, name));
  }
  const originalMemoryCard = extract(settings, 'function MemoryCard');
  assert.ok(originalMemoryCard);
  assert.equal(extract(cards, 'function MemoryCard'), originalMemoryCard.replace('{ bot, actions }', '{ bot, actions, t }'));
  const icons = readFileSync(new URL('icons.js', upstream), 'utf8');
  const chevron = /^export const ChevronRightIcon = .*$/m;
  assert.ok(icons.match(chevron));
  assert.equal(cards.match(chevron)?.[0], icons.match(chevron)?.[0]);
});
