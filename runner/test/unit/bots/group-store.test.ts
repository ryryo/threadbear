import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { atomicWriteFileSync } from '../../../src/fsutil.ts';
import { GroupStore } from '../../../src/bots/group-store.ts';
import { BotRepository } from '../../../src/bots/repository.ts';

const now = '2026-11-27T00:00:00Z';
function setup(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'threadbear-groups-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const repo = new BotRepository(join(home, 'bots'), 'runner');
  const editor = repo.create({ name: 'Editor' });
  const writer = repo.create({ name: 'Writer' });
  const tester = repo.create({ name: 'Tester' });
  let fail = false;
  const open = () => new GroupStore(join(home, 'bots'), repo, () => {}, (file, text, mode) => {
    if (fail) throw new Error('ENOSPC');
    atomicWriteFileSync(file, text, mode);
  });
  const store = open();
  const create = (title: string) => store.create({
    title, teamId: repo.workspaceId(), memberIds: [editor.id, writer.id, tester.id], adminId: editor.id, mode: 'admin', ceiling: 'ask',
  });
  return { repo, editor, writer, tester, store, open, create, failWrites: () => { fail = true; } };
}

test('a Group post persists the mentioned IDs before work starts and queues the next post in order', t => {
  const { store, create, editor, writer, tester, repo, open } = setup(t);
  const group = create('Editorial');
  const first = store.post(group.id, 'first', '@Writer @Tester 見出し案', now);
  assert.deepEqual(first.calleeIds, [writer.id, tester.id]);
  assert.deepEqual(store.post(group.id, 'first', '@Writer @Tester 見出し案', now), first);
  assert.throws(() => store.post(group.id, 'first', '別の依頼', now), /different post/);
  store.startNext(group.id);
  repo.update(writer.id, writer.revision, { name: 'Copy editor' });
  const second = store.post(group.id, 'second', '別の記事', now);
  assert.deepEqual(second.calleeIds, [editor.id]);
  const saved = open().get(group.id);
  assert.deepEqual(saved.round?.slots.map(slot => slot.id), [writer.id, tester.id]);
  assert.deepEqual(saved.posts, [second]);
  assert.deepEqual(saved.events.map(event => event.seq), [1, 2]);
});

test('stopping one Group persists before cancelling its calls, and leaves the other Group alone', t => {
  const { store, create, open } = setup(t);
  const one = create('Editorial');
  const two = create('Research');
  for (const group of [one, two]) {
    store.post(group.id, 'a', '作業を開始', now);
    store.startNext(group.id);
  }
  store.post(one.id, 'b', '次の計画', now);
  const before = store.get(two.id);
  store.freeze(one.id, now);
  const restarted = open();
  assert.equal(restarted.get(one.id).round?.status, 'stopped');
  assert.equal(restarted.get(one.id).posts.length, 1);
  assert.equal(restarted.startNext(one.id), undefined);
  assert.deepEqual(restarted.get(two.id), before);
});

test('a failed write admits no visible post and a Group rejects a Private Bot', t => {
  const { store, create, repo, writer, open, failWrites } = setup(t);
  const group = create('Editorial');
  repo.setPrivate(writer.id, writer.revision, '/private-fixture', 'private', [], () => {});
  assert.throws(() => create('Cannot include a Private Bot'), /non-Private/);
  failWrites();
  assert.throws(() => store.post(group.id, 'failed', 'draft', now), /ENOSPC/);
  assert.deepEqual(store.get(group.id).events, []);
  assert.deepEqual(open().get(group.id).events, []);
});
