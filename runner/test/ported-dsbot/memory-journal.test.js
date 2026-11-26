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
