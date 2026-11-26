import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PermissionMode } from '../../../src/protocol.ts';
import { PermissionChanges } from '../../../src/bots/permission-changes.ts';

function deferred() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
}

function fixture() {
  let saved = { revision: 1, ceiling: 'ask' as PermissionMode };
  const actual = new Map([['conversation', saved.ceiling], ['background-task', saved.ceiling]]);
  let onApply: (id: string) => Promise<void> = async () => {};
  const changes = new PermissionChanges({
    read: () => saved,
    threads: () => [...actual.keys()],
    commit: (_bot, revision, ceiling) => {
      assert.equal(revision, saved.revision);
      saved = { revision: revision + 1, ceiling };
    },
    apply: async (id, wanted) => {
      await onApply(id);
      const mode = wanted();
      if (mode !== undefined) actual.set(id, mode);
    },
    warn: () => {},
  });
  return { actual, changes, saved: () => saved, beforeApply: (next: typeof onApply) => { onApply = next; } };
}

// DS-Bot permissions.test.js L99–129 and L183–224, with the native
// workspace revision and current Thread identifiers as the fixture.
test('the newest requested limit wins when two changes overlap', async () => {
  const { actual, changes, saved, beforeApply } = fixture();
  const first = deferred();
  let calls = 0;
  beforeApply(async () => { if (++calls === 1) await first.wait; });
  const pending = changes.set('bot', 1, 'full');
  await changes.set('bot', 1, 'plan');
  first.release();
  await assert.rejects(pending, /superseded/);
  assert.deepEqual(saved(), { revision: 2, ceiling: 'plan' });
  assert.deepEqual([...actual.values()], ['plan', 'plan']);
});

test('a change that fails on the background task restores the first Thread and the saved setting', async () => {
  const { actual, changes, saved, beforeApply } = fixture();
  let failed = false;
  beforeApply(async id => {
    if (id === 'background-task' && !failed) {
      failed = true;
      throw new Error('The task refused its new mode');
    }
  });
  await assert.rejects(changes.set('bot', 1, 'full'), /task refused/);
  assert.deepEqual(saved(), { revision: 1, ceiling: 'ask' });
  assert.deepEqual([...actual.values()], ['ask', 'ask']);
});

test('an older rollback cannot overwrite a newer permission while it waits on a Thread', async () => {
  const { actual, changes, saved, beforeApply } = fixture();
  const rollingBack = deferred();
  const release = deferred();
  let calls = 0;
  beforeApply(async () => {
    ++calls;
    if (calls === 2) throw new Error('One Thread refused');
    if (calls === 3) {
      rollingBack.release();
      await release.wait;
    }
  });
  const previous = changes.set('bot', 1, 'full');
  const refused = assert.rejects(previous, /Thread refused/);
  await rollingBack.wait;
  await changes.set('bot', 1, 'plan');
  release.release();
  await refused;
  assert.deepEqual(saved(), { revision: 2, ceiling: 'plan' });
  assert.deepEqual([...actual.values()], ['plan', 'plan']);
});
