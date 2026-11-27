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

test('ported rankings match Japanese queries and filter expired notes', t => {
  const memory = new PersonalMemory(fixture(t));
  const now = '2026-11-27T00:00:00.000Z';
  const current = memory.add('見出しは短くする', {}, now);
  memory.add('見出しの色は青', { until: '2026-11-27' }, now);
  memory.add('本文に日付を入れる', {}, now);
  assert.deepEqual(memory.search('見出し', '2026-11-28'), [current]);
});

test('a managed backup restores only the selected note and resumes an interrupted write with one receipt', t => {
  const path = fixture(t);
  const memory = new PersonalMemory(path);
  const time = '2026-11-27T00:00:00.000Z';
  const kept = memory.add('別の覚書は元のまま', {}, time);
  const source = memory.change({ op: 'add', text: 'バックアップから戻す覚書' }, 'source', memory.revision(), time);
  const archivedRow = memory.history()[0];
  memory.remove(source.note.id, time);
  const revision = memory.revision();
  const selected = { entryId: source.note.id, file: archivedRow.file, line: archivedRow.after, checksum: 'd'.repeat(64) };
  assert.throws(() => memory.restoreBackupNote(selected, 'stale', 'obsolete', time, () => {}), /notes changed/i);
  assert.throws(() => memory.restoreBackupNote(selected, 'denied', revision, time, () => { throw new Error('format unavailable'); }), /format unavailable/);
  assert.deepEqual(memory.list('2026-11-27'), [kept]);
  const finish = memory.storage.finish.bind(memory.storage);
  t.mock.method(memory.storage, 'finish', () => { throw new Error('interrupted after saving intent'); });
  assert.throws(() => memory.restoreBackupNote(selected, 'restore', revision, time, () => {}), /interrupted/);
  t.mock.method(memory.storage, 'finish', finish);
  const restarted = new PersonalMemory(path);
  const receipt = restarted.restoreBackupNote(selected, 'restore', revision, time, () => assert.fail('the receipt already exists'));
  assert.deepEqual(restarted.list('2026-11-27').map(note => note.id).sort(), [kept.id, source.note.id].sort());
  assert.equal(restarted.history().filter(row => row.transaction?.operationId === 'restore').length, 1);
  assert.equal(restarted.change({ op: 'add', text: 'バックアップから戻す覚書' }, 'source', 'unused', time).revision, source.revision);
  assert.equal(restarted.restoreBackupNote(selected, 'restore', 'obsolete', time, () => {}).revision, receipt.revision);
  restarted.erase(source.note.id, 'erased', receipt.revision, time, () => {});
  assert.throws(() => restarted.restoreBackupNote(selected, 'restore-again', restarted.revision(), time, () => {}), /permanently erased/i);
});

test('restoration rechecks the active secret policy and never overwrites a live note', t => {
  const path = fixture(t);
  const time = '2026-11-27T00:00:00.000Z';
  const memory = new PersonalMemory(path);
  const saved = memory.add('以前は扱えた機密表現', {}, time);
  const first = memory.history()[0];
  const backup = { entryId: saved.id, file: first.file, line: first.after, checksum: 'e'.repeat(64) };
  assert.throws(() => memory.restoreBackupNote(backup, 'copy', first.id, time, () => {}), /already exists/i);
  memory.remove(saved.id, time);
  const reopened = new PersonalMemory(path, { redact: text => text.replace('機密表現', '[redacted]') });
  assert.throws(() => reopened.restoreBackupNote(backup, 'denied', reopened.revision(), time, () => {}), /secret/i);
  assert.deepEqual(reopened.list('2026-11-27'), []);
});
