import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { formatEntry } from '../../src/bots/ported/memory-entries.js';
import { PersonalMemory } from '../../src/bots/ported/personal-memory.js';

const at = '2026-11-27T00:00:00.000Z';
const today = '2026-11-27';
const original = '合成覚書の旧版。玄関の目印は緑の箱。';
const edited = '合成覚書の新版。玄関の目印は青い箱。';
const retained = '別の合成覚書。見出しは短くする。';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'tb-note-erasure-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'own');
  return { root, memory: new PersonalMemory(root), team: new PersonalMemory(join(dir, 'team'), { scope: 'team' }) };
}

test('erasing a forgotten note strips its edits, receipt text and undo while keeping deduplication and other scopes', t => {
  const { root, memory, team } = fixture(t);
  const picked = { op: 'add', text: original };
  const added = memory.change(picked, 'old-add', 'empty', at);
  const edit = { op: 'edit', entryId: added.note.id, text: edited };
  const changed = memory.change(edit, 'old-edit', added.revision, at);
  memory.change({ op: 'remove', entryId: added.note.id }, 'old-remove', changed.revision, at);
  const kept = memory.change({ op: 'add', text: retained }, 'keep', memory.revision(), at);
  team.change(picked, 'team-add', 'empty', at);
  const journal = join(root, 'journal.jsonl');
  const source = readFileSync(journal, 'utf8');
  assert.throws(() => memory.erase(added.note.id, 'erase-first', changed.revision, at, () => {}), /changed/);
  assert.equal(readFileSync(journal, 'utf8'), source);

  const abandonedWrite = join(root, '.MEMORY.md.2147483647.12345678.tmp');
  writeFileSync(abandonedWrite, original);
  const result = memory.erase(added.note.id, 'erase-first', kept.revision, at, () => {});
  assert.equal(existsSync(abandonedWrite), false);
  const reopened = new PersonalMemory(root);
  assert.deepEqual(reopened.list(today), [kept.note]);
  assert.equal(team.list(today)[0].text, original);
  assert.doesNotMatch(readFileSync(journal, 'utf8'), /玄関の目印/);
  assert.deepEqual(reopened.erase(added.note.id, 'erase-first', kept.revision, at, () => {}), result);
  assert.deepEqual(reopened.change(picked, 'old-add', 'empty', at), { revision: added.revision });
  assert.deepEqual(reopened.change(edit, 'old-edit', added.revision, at), { revision: changed.revision });
  assert.throws(() => reopened.change({ ...picked, text: retained }, 'old-add', 'empty', at), /different change/);
  assert.throws(() => reopened.restore(changed.revision, at), /erased/i);
  assert.equal(reopened.history().find(row => row.id === kept.revision).after.includes(retained), true);
});

test('erasure sanitizes tidy snapshots and keeps the undo of a different note', t => {
  const { root, memory } = fixture(t);
  const selected = memory.add(original, { pin: false }, at);
  const other = memory.add(retained, { pin: false }, at);
  const input = memory.tidyInput(today);
  const otherIndex = input.numbered.findIndex(note => note.text === retained) + 1;
  const tidy = memory.tidy(input, JSON.stringify({ changes: [{ op: 'move', entry: otherIndex, topic: 'editing' }] }), 'move-other', at);
  assert.equal(memory.list(today).find(note => note.id === other.id).topic, 'editing');
  memory.erase(selected.id, 'erase-picked', tidy.revision, at, () => {});
  assert.doesNotMatch(readFileSync(join(root, 'journal.jsonl'), 'utf8'), /玄関の目印/);
  memory.restore(tidy.revision, at);
  assert.deepEqual(memory.list(today).map(note => note.text), [retained]);
  assert.equal(memory.list(today)[0].topic, undefined);
});

test('erasure refuses an ambiguous reused identity and a note that contributed to a merge', t => {
  const { root, memory } = fixture(t);
  const selected = memory.add(original, {}, at);
  const journal = join(root, 'journal.jsonl');
  const before = readFileSync(journal, 'utf8');
  const legacy = { ...JSON.parse(before.trim()), id: 'legacy-add', after: formatEntry(retained, { id: selected.id }) };
  writeFileSync(journal, before + JSON.stringify(legacy) + '\n');
  assert.throws(() => memory.erase(selected.id, 'ambiguous', legacy.id, at, () => {}), /multiple notes/);
  assert.equal(memory.list(today)[0].text, original);

  const merged = { ...legacy, id: 'merged', op: 'tidy', after: undefined, tidy: {
    files: [], retired: [{ file: 'MEMORY.md', line: formatEntry(original, { id: selected.id }), into: 'another-note' }],
  } };
  writeFileSync(journal, before + JSON.stringify(merged) + '\n');
  assert.throws(() => memory.erase(selected.id, 'ambiguous', merged.id, at, () => {}), /merged/);
  assert.equal(memory.list(today)[0].text, original);
});

test('erasure clears a retired note while preserving an unrelated retirement', t => {
  const { root, memory } = fixture(t);
  const selected = memory.add(original, { pin: false }, at);
  const other = memory.add(retained, { pin: false }, at);
  for (const [entry, operation] of [[selected, 'retire-picked'], [other, 'retire-other']]) {
    const input = memory.tidyInput(today);
    const numbered = input.numbered.findIndex(note => note.text === entry.text) + 1;
    memory.tidy(input, JSON.stringify({ changes: [{ op: 'retire', entry: numbered }] }), operation, at);
    // Tidy waits for a memory change before it will offer another batch.
    if (operation === 'retire-picked') memory.add('別の合成覚書。句読点を確認する。', {}, at);
  }
  memory.erase(selected.id, 'erase-retired', memory.revision(), at, () => {});
  const journal = readFileSync(join(root, 'journal.jsonl'), 'utf8');
  assert.doesNotMatch(journal, /玄関の目印/);
  assert.match(journal, /見出しは短くする/);
  const retired = memory.history().filter(row => row.tidy?.retired?.length);
  assert.equal(retired.length, 1);
  assert.match(retired[0].tidy.retired[0].line, /見出しは短くする/);
});

test('erasure drops the review receipt text and rejects approval replay', t => {
  const { root, memory } = fixture(t);
  const proposal = { op: 'add', text: original };
  const receipt = { reportId: 'report', index: 0, operationId: 'accept-review', acceptedText: edited, threadId: 'conversation' };
  memory.approveReview(proposal, receipt, at, text => text);
  const [{ id }] = memory.list(today);
  memory.erase(id, 'erase-reviewed', memory.revision(), at, () => {});
  assert.doesNotMatch(readFileSync(join(root, 'journal.jsonl'), 'utf8'), /玄関の目印/);
  assert.throws(() => memory.approveReview(proposal, receipt, at, text => text), /permanently erased/);
  assert.deepEqual(memory.list(today), []);
});
