import assert from 'node:assert/strict';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { TaskJournal } from '../../../src/bots/task-journal.ts';

const at = '2026-11-27T00:00:00Z';
const scope = { botId: 'writer', sourceThreadId: 'source-thread', sourceConversationId: 'source-conversation', title: '記事の確認', brief: '見出しを確認' };

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'bot-task-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let fail = false;
  const writer = (file: string, body: string, mode: number) => {
    if (fail) throw new Error('disk full');
    writeFileSync(`${file}.next`, body, { mode });
    renameSync(`${file}.next`, file);
  };
  return { reload: () => new TaskJournal(root, writer, () => {}), failWrites: () => { fail = true; } };
}

test('one terminal write keeps both the saved task result and its pending reply after recovery', t => {
  const { reload, failWrites } = fixture(t);
  const task = reload().reserve({ ...scope, operationId: 'a' }, at);
  assert.equal(reload().reserve({ ...scope, operationId: 'a' }, at).threadId, task.threadId);
  assert.throws(() => reload().reserve({ ...scope, brief: 'Different brief', operationId: 'a' }, at), /different task/);
  const result = { source: { threadId: task.threadId, seq: 123 }, text: '見出しを確認しました' };
  const done = reload().finish(task.id, task.revision, at, 'completed', result.text, result, true);
  assert.deepEqual(reload().get(task.id).state, {
    status: 'completed', outcome: { summary: result.text, result }, reply: { id: `bot-task-reply:${task.id}`, sent: false },
  });
  failWrites();
  assert.throws(() => reload().returned(task.id, done.revision, at, `bot-task-reply:${task.id}`), /disk full/);
  assert.deepEqual(reload().get(task.id), done);
});

test('task history pages past sixty jobs without deleting earlier result references', t => {
  const journal = fixture(t).reload();
  const first = journal.reserve({ ...scope, operationId: '0' }, at);
  for (let i = 0; i < 61; i++) {
    const task = journal.reserve({ ...scope, operationId: String(i) }, at);
    journal.finish(task.id, task.revision, at, 'completed', '結果', { source: { threadId: task.threadId, seq: 3 }, text: '結果' }, false);
  }
  const page = journal.list(scope.botId);
  assert.equal(page.rows.length, 50);
  assert.ok(page.more);
  const second = journal.list(scope.botId, page.more);
  assert.equal(second.rows.length, 11);
  assert.equal(second.rows.at(-1)?.id, first.id);
  assert.deepEqual(journal.get(first.id).state, {
    status: 'completed', outcome: { summary: '結果', result: { source: { threadId: first.threadId, seq: 3 }, text: '結果' } },
  });
});

test('the workspace reserves four tasks and no Bot acquires a third active slot', t => {
  const journal = fixture(t).reload();
  journal.reserve({ ...scope, operationId: 'a' }, at);
  journal.reserve({ ...scope, operationId: 'b' }, at);
  assert.throws(() => journal.reserve({ ...scope, operationId: 'c' }, at), /task limit/);
  journal.reserve({ ...scope, botId: 'reader', sourceThreadId: 'thread-reader', sourceConversationId: 'r', operationId: 'a' }, at);
  journal.reserve({ ...scope, botId: 'reviewer', sourceThreadId: 'thread-reviewer', sourceConversationId: 'e', operationId: 'a' }, at);
  assert.throws(() => journal.reserve({ ...scope, botId: 'another', sourceThreadId: 'thread-another', sourceConversationId: 'a', operationId: 'a' }, at), /task limit/);
});
