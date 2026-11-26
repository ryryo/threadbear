import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PersonalMemory } from '../../src/bots/ported/personal-memory.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'tb-personal-memory-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('a manual Japanese note retains its id, source and pin after reopening the same Bot memory', (t) => {
  const root = fixture(t);
  const sourceThreadId = 'conversation-a';
  const saved = new PersonalMemory(root).add('見出しは短くする', { sourceThreadId }, '2026-11-27T00:00:00.000Z');
  const restarted = new PersonalMemory(root);
  assert.deepEqual(restarted.list('2026-12-11'), [saved]);
  assert.equal(saved.pinned, true);
  assert.equal(restarted.history()[0].sourceThreadId, sourceThreadId);
  assert.deepEqual(restarted.add('  見出しは短くする  ', {}, '2026-12-11T00:00:00.000Z'), saved);
  assert.equal(restarted.history().length, 1);
});

test('editing keeps the entry id and restoring refuses changed lines', (t) => {
  const memory = new PersonalMemory(fixture(t));
  const entry = memory.add('Keep titles short', {}, '2026-11-27T00:00:00.000Z');
  const original = memory.history()[0];
  const edited = memory.replace(entry.id, 'Keep headings short', '2026-11-27T00:01:00.000Z');
  const edit = memory.history()[0];
  assert.equal(edited.id, entry.id);
  assert.equal(edited.pinned, true);
  assert.throws(() => memory.restore(original.id, '2026-11-27T00:02:00.000Z'), /changed or been removed/i);
  memory.restore(edit.id, '2026-11-27T00:03:00.000Z');
  assert.deepEqual(memory.list('2026-11-27'), [entry]);
  assert.throws(() => memory.restore(edit.id, '2026-11-27T00:04:00.000Z'), /already restored/i);
  memory.remove(entry.id, '2026-11-27T00:05:00.000Z');
  const removed = memory.history()[0];
  assert.deepEqual(memory.list('2026-11-27'), []);
  memory.restore(removed.id, '2026-11-27T00:06:00.000Z');
  assert.deepEqual(memory.list('2026-11-27'), [entry]);
});

test('explicit expiry limits recall and secret text is refused before recording a change', (t) => {
  const memory = new PersonalMemory(fixture(t));
  memory.add('Review these release notes', { until: '2026-11-28' }, '2026-11-27T00:00:00.000Z');
  assert.equal(memory.list('2026-11-28').length, 1);
  assert.deepEqual(memory.list('2026-11-29'), []);
  assert.throws(() => memory.add('password: Example4Secret987', {}, '2026-11-27T00:00:00.000Z'), /secret/i);
  assert.equal(memory.history().length, 1);
});
