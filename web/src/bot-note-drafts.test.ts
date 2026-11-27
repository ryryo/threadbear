import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearErasedDrafts, savedNoteDrafts, noteDraftTarget } from './bot-note-drafts.ts';

function fixture(fields: Record<string, string>) {
  const values = new Map(Object.entries(fields));
  const storage = {
    get length() { return values.size; },
    key(index: number) { return [...values.keys()][index] ?? null; },
    getItem(key: string) { return values.get(key) ?? null; },
    removeItem(key: string) { values.delete(key); },
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
