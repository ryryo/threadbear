import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearErasedDrafts, savedNoteDrafts, noteDraftTarget, readNoteDraft, saveManagedNoteDraft,
  removeManagedNoteDrafts, managedNoteStoreId } from './bot-note-drafts.ts';

function fixture(fields: Record<string, string>) {
  const values = new Map(Object.entries(fields));
  const storage = {
    get length() { return values.size; },
    key(index: number) { return [...values.keys()][index] ?? null; },
    getItem(key: string) { return values.get(key) ?? null; },
    removeItem(key: string) { values.delete(key); },
    setItem(key: string, value: string) { values.set(key, value); },
  };
  return { values, storage };
}

const prefix = 'bot-action-draft';
const oldOwner = prefix + ':old-runner:workspace:1:notes:bot:desk';
const otherScope = prefix + ':old-runner:workspace:1:notes:bot:reader';
const otherWorkspace = prefix + ':new-runner:elsewhere:7:notes:bot:desk';
const draft = (id: string, scopeId: string, text = '削除する覚書の下書き') => JSON.stringify({
  operationId: 'old-op', action: { kind: 'note.edit', entryId: id, scope: { kind: 'bot', id: scopeId }, text },
});

test('duplicated tabs share the stored bytes, while a later write cannot resurrect a managed erasure', () => {
  const origin = fixture({});
  const tab = fixture({});
  const original = JSON.parse(draft('same-id', 'desk'));
  const other = JSON.parse(draft('same-id', 'reader', '別のスコープ'));
  assert.equal(managedNoteStoreId(origin.storage, () => 'one'), 'one');
  assert.equal(managedNoteStoreId(origin.storage, () => 'two'), 'one');
  assert.ok(saveManagedNoteDraft(origin.storage, tab.storage, oldOwner, 'slot-a', original));
  const duplicate = fixture(Object.fromEntries(tab.values));
  assert.deepEqual(readNoteDraft(origin.storage, duplicate.storage, oldOwner), original);
  assert.ok(!tab.values.get(oldOwner)?.includes(original.action.text), 'session storage carries only the reference');
  assert.ok(saveManagedNoteDraft(origin.storage, duplicate.storage, otherScope, 'slot-b', other));
  const exact = noteDraftTarget('workspace', original.action)!;
  assert.deepEqual(removeManagedNoteDrafts(origin.storage, tab.storage, [exact]), [exact]);
  assert.equal(readNoteDraft(origin.storage, duplicate.storage, oldOwner), null);
  assert.ok(!saveManagedNoteDraft(origin.storage, duplicate.storage, oldOwner, 'slot-c', original));
  assert.deepEqual(readNoteDraft(origin.storage, duplicate.storage, otherScope), other);
});

test('only an exact erasure response clears stored text, also for an older Runner epoch', () => {
  const { storage, values } = fixture({
    [oldOwner]: draft('same-id', 'desk'),
    [otherScope]: draft('same-id', 'reader'),
    [otherWorkspace]: draft('same-id', 'desk'),
    [prefix + ':new-runner:workspace:2:notes:bot:wrong-key']: draft('same-id', 'desk'),
  });
  const snapshots = savedNoteDrafts(storage);
  assert.deepEqual(snapshots.map(item => item.target), [
    { workspaceId: 'workspace', scope: { kind: 'bot', id: 'desk' }, entryId: 'same-id' },
    { workspaceId: 'workspace', scope: { kind: 'bot', id: 'reader' }, entryId: 'same-id' },
    { workspaceId: 'elsewhere', scope: { kind: 'bot', id: 'desk' }, entryId: 'same-id' },
  ]);
  clearErasedDrafts(storage, snapshots, []);
  assert.equal(values.size, 4);
  clearErasedDrafts(storage, snapshots, [true, false, false]);
  assert.deepEqual([...values.keys()], [otherScope, otherWorkspace, prefix + ':new-runner:workspace:2:notes:bot:wrong-key']);
});

test('an old lookup does not delete a different draft saved while it was in flight', () => {
  const { storage, values } = fixture({ [oldOwner]: draft('deleted', 'desk') });
  const snapshot = savedNoteDrafts(storage);
  values.set(oldOwner, draft('untouched', 'desk'));
  clearErasedDrafts(storage, snapshot, [true]);
  assert.ok(values.get(oldOwner)?.includes('untouched'));
  assert.equal(noteDraftTarget('workspace', { kind: 'note.add', text: '同じ本文の新規下書き' }), undefined);
  assert.deepEqual(noteDraftTarget('workspace', { kind: 'note.remove', entryId: 'deleted', scope: { kind: 'group', id: 'room' } }),
    { workspaceId: 'workspace', entryId: 'deleted', scope: { kind: 'group', id: 'room' } });
});
