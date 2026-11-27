// Derived from Fei-Craft/DS-Bot, d104d9ca18d69a35460f14e15dff4d553181433a,
// ds-bot/test/memory-pending.test.js. Copyright 2026 Fei2411 and the DS Bot contributors.
// SPDX-License-Identifier: Apache-2.0
// Modified for Threadbear: replace the DSH host fixture with the ported storage boundary.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MemoryJournal } from '../../src/bots/ported/memory-journal.js';
import { pendingPath, record } from '../../src/bots/ported/memory-pending.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'tb-bot-memory-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const scope = 'bot:b2';
const bytes = '# Memory\n\n- Trip to Kyoto\n';
const step = { action: 'write', path: 'bots/b2/MEMORY.md', text: bytes };
const row = { scope, op: 'add', file: 'MEMORY.md' };
const change = record({ id: 'change-1', time: '2026-10-23T10:00:00.000Z', op: row.op, scope, steps: [step], row });

test('a change that cannot be accepted leaves the memory as it was', (t) => {
  const root = fixture(t);
  mkdirSync(pendingPath(root));
  assert.throws(() => new MemoryJournal(root).publish(change), { code: 'memory/pending' });
  assert.equal(existsSync(join(root, step.path)), false);
  assert.equal(existsSync(join(root, 'journal.jsonl')), false);
});

test('a change that cannot be published stays pending and finishes on recovery', (t) => {
  const root = fixture(t);
  const log = join(root, 'journal.jsonl');
  mkdirSync(log);
  assert.throws(() => new MemoryJournal(root).publish(change));
  assert.match(readFileSync(join(root, step.path), 'utf8'), /Trip to Kyoto/);
  assert.ok(existsSync(pendingPath(root)));
  rmSync(log, { recursive: true });
  const restarted = new MemoryJournal(root);
  restarted.recoverPending();
  restarted.recoverPending();
  assert.ok(!existsSync(pendingPath(root)));
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)), [change.row]);
});

test('a change that was already finished does not get a second row', (t) => {
  const root = fixture(t);
  const log = join(root, 'journal.jsonl');
  writeFileSync(log, JSON.stringify(change.row) + '\n');
  writeFileSync(pendingPath(root), JSON.stringify(change));
  new MemoryJournal(root).recoverPending();
  assert.equal(readFileSync(log, 'utf8'), JSON.stringify(change.row) + '\n');
  assert.ok(!existsSync(pendingPath(root)));
});

test('an interrupted journal row is preserved and replaced by one whole row', (t) => {
  const root = fixture(t);
  const log = join(root, 'journal.jsonl');
  const first = JSON.stringify({ id: 'earlier', after: '旅行' });
  writeFileSync(log, first + '\n{"id":"change-');
  writeFileSync(pendingPath(root), JSON.stringify(change));
  new MemoryJournal(root).recoverPending();
  assert.equal(readFileSync(log, 'utf8'), first + '\n' + JSON.stringify(change.row) + '\n');
  assert.equal(readFileSync(join(root, 'journal-torn.jsonl'), 'utf8'), '{"id":"change-\n');
});

test('a pending change with a path outside the memory root stops before writing', (t) => {
  const root = fixture(t);
  writeFileSync(pendingPath(root), JSON.stringify({ ...change, steps: [step, { ...step, path: '../outside.md' }] }));
  assert.throws(() => new MemoryJournal(root).recoverPending(), /outside the memory folder/);
  assert.ok(existsSync(pendingPath(root)));
  assert.equal(existsSync(join(root, step.path)), false);
});

function erasureFixture(t) {
  const root = fixture(t);
  const journal = new MemoryJournal(root);
  const previous = { id: 'old', scope, op: 'add', after: '選んだ合成覚書。' };
  writeFileSync(journal.journal, JSON.stringify(previous) + '\n');
  writeFileSync(join(root, 'MEMORY.md'), previous.after);
  const erase = record({
    id: 'erase-1', time: '2026-10-23T10:00:00.000Z', op: 'erase', scope,
    steps: [{ action: 'write', path: 'MEMORY.md', text: '' }],
    row: { scope, op: 'erase', file: 'MEMORY.md', entryId: 'note-a' },
  });
  const sanitized = [
    { ...previous, after: undefined, erased: ['note-a'], transaction: { operationId: 'accepted', hash: 'a'.repeat(64) } },
    erase.row,
  ].map(row => JSON.stringify(row)).join('\n') + '\n';
  return { root, journal, previous, erase, sanitized };
}

test('erasure is recovered before or after installing the sanitized journal', t => {
  for (const installBeforeCrash of [false, true]) {
    const f = erasureFixture(t);
    const install = f.journal.installRewrite.bind(f.journal);
    t.mock.method(f.journal, 'installRewrite', (...args) => {
      if (installBeforeCrash) install(...args);
      throw new Error('isolated interruption');
    });
    assert.throws(() => f.journal.erase(f.erase, f.sanitized), /isolated interruption/);
    const pending = readFileSync(pendingPath(f.root), 'utf8');
    assert.doesNotMatch(pending, /選んだ合成覚書/);
    const next = new MemoryJournal(f.root);
    next.recoverPending();
    next.recoverPending();
    assert.equal(readFileSync(next.journal, 'utf8'), f.sanitized);
    assert.equal(readFileSync(join(f.root, 'MEMORY.md'), 'utf8'), '');
    assert.equal(existsSync(pendingPath(f.root)), false);
  }
});

test('erasure stops before publishing another step if the staged journal fails its checksum', t => {
  const f = erasureFixture(t);
  t.mock.method(f.journal, 'finish', () => { throw new Error('isolated interruption'); });
  assert.throws(() => f.journal.erase(f.erase, f.sanitized), /isolated interruption/);
  writeFileSync(join(f.root, 'journal-erasure.jsonl'), 'changed');
  assert.throws(() => new MemoryJournal(f.root).recoverPending(), /erasure.*checksum/i);
  assert.equal(readFileSync(join(f.root, 'MEMORY.md'), 'utf8'), f.previous.after);
  assert.equal(existsSync(pendingPath(f.root)), true);
});

test('erasure keeps a replacement journal above the pending record limit out of the bounded pending record', t => {
  const f = erasureFixture(t);
  const retained = JSON.stringify({ id: 'unrelated', body: 'x'.repeat(1_100_000) }) + '\n';
  t.mock.method(f.journal, 'finish', () => { throw new Error('isolated interruption'); });
  assert.throws(() => f.journal.erase(f.erase, retained + f.sanitized), /isolated interruption/);
  assert.ok(readFileSync(pendingPath(f.root), 'utf8').length < 1024);
  new MemoryJournal(f.root).recoverPending();
  assert.equal(readFileSync(f.journal.journal, 'utf8'), retained + f.sanitized);
});
