import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TaskJournal } from '../../../src/bots/task-journal.ts';
import { BackgroundBotTasks } from '../../../src/bots/task-service.ts';

test('an operation reserves one execution Thread while the original conversation stays in place', async t => {
  const root = mkdtempSync(join(tmpdir(), 'bot-task-service-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let diskFull = false;
  const journal = new TaskJournal(root, (file, contents, mode) => {
    if (diskFull) throw new Error('disk full');
    writeFileSync(file, contents, { mode });
  }, () => {});
  const origin = { botId: 'writer', threadId: 'normal-thread', conversationId: 'normal', folder: '/workspace' };
  const opened: string[] = [];
  const stopped: string[] = [];
  const service = new BackgroundBotTasks({
    journal, source: () => origin, authorize: async from => ({ folder: from.folder }),
    parent: () => undefined, admitted: task => opened.includes(task.threadId) ? { kind: 'accepted', turnId: 'work' } : { kind: 'new' },
    openThread: task => opened.push(task.threadId),
    enqueue: (_, payload) => {
      assert.equal(payload, 'Check the title');
      return { turnId: 'work' };
    },
    stop: async task => { stopped.push(task.threadId); }, clock: () => '2026-11-27T00:00:00Z',
  });
  const input = { operationId: 'one', title: 'Draft', brief: 'Check the title' };
  const [a, b] = await Promise.all([service.start(origin.threadId, input), service.start(origin.threadId, input)]);
  assert.equal(a.id, b.id);
  assert.deepEqual(opened, [a.threadId]);
  assert.notEqual(a.threadId, origin.threadId);
  assert.equal(a.sourceConversationId, origin.conversationId);
  diskFull = true;
  assert.deepEqual(await service.cancel(a.id, a.revision), { stopped: true, saved: false });
  assert.deepEqual(stopped, [a.threadId]);
});
