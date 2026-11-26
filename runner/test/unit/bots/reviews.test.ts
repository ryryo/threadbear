import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { BotConversations } from '../../../src/bots/conversations.ts';
import { BotRepository } from '../../../src/bots/repository.ts';
import { BotReviews } from '../../../src/bots/reviews.ts';
import { makeHarness, tick, tmpDir } from '../../helpers/fakes.ts';

test('opted-in review reads a linked Thread, pins its login, and restores proposals after restart', async () => {
  const home = tmpDir();
  const root = join(home, 'bots');
  let conversations: BotConversations;
  const h = makeHarness(home, {}, { botContext: rec => conversations.context(rec) });
  const repo = new BotRepository(root, 'runner-1');
  conversations = new BotConversations(h.runner, repo, root);
  const editor = repo.create({ name: '編集者' });
  const a = conversations.create(editor.id, 'first');
  h.runner.update({ threadId: a.threadId, accountId: 'claude-3', model: 'claude-sonnet-4-6' });
  const modelSaved = conversations.conversationModel(editor.id, editor.revision, a.threadId);
  const picks: string[] = [];
  const service = new BotReviews({
    root, repo, runner: h.runner, enabled: () => true, redact: String,
    askers: { claude: async req => {
      picks.push(`${req.account.id}:${req.model}`);
      assert.match(req.prompt, /日本語で見出しを短くする/);
      return { ok: true, text: '{"changes":[{"op":"add","text":"ユーザーは短い見出しを好む"}]}', outputTokens: 12 };
    } },
  });
  h.runner.send(a.threadId, '日本語で見出しを短くする', [], { botSource: { kind: 'owner' } });
  await tick();
  h.adapter.last.init();
  h.adapter.last.result('completed');
  await tick();

  await service.review(a.threadId);
  assert.deepEqual(picks, []);
  repo.setReviewEnabled(editor.id, modelSaved.revision, true, randomUUID());
  await service.review(a.threadId);
  await service.review(a.threadId);
  assert.deepEqual(picks, ['claude-3:claude-sonnet-4-6']);
  const reopened = new BotReviews({ root, repo: new BotRepository(root, 'runner-1'), runner: h.restart().runner, enabled: () => true, redact: String, askers: {} });
  const [report] = reopened.reports(editor.id, a.threadId);
  assert.equal(report.source.threadId, a.threadId);
  assert.equal(report.usage?.outputTokens, 12);
  assert.deepEqual(report.changes, [{ op: 'add', text: 'ユーザーは短い見出しを好む', decision: 'pending' }]);
  assert.deepEqual(conversations.notes(editor.id, a.threadId), []);
  const priorCheckpoint = join(root, 'reviews', `${a.id}.json`);
  const snapshot = readFileSync(priorCheckpoint);
  const operationId = randomUUID();
  const accepted = 'ユーザーは短く具体的な見出しを好む';
  reopened.approve(editor.id, a.threadId, report.id, 0, operationId, accepted);
  assert.equal(conversations.notes(editor.id, a.threadId)[0].text, accepted);
  // A crash after the journal commit leaves the earlier review checkpoint.
  writeFileSync(priorCheckpoint, snapshot);
  assert.equal(reopened.reports(editor.id, a.threadId)[0].changes[0].decision, 'approved');
  reopened.approve(editor.id, a.threadId, report.id, 0, operationId, accepted);
  assert.throws(() => reopened.approve(editor.id, a.threadId, report.id, 0, operationId, 'different'), /already decided/);
  assert.throws(() => reopened.reject(editor.id, a.threadId, report.id, 0, randomUUID()), /already decided/);
  assert.equal(conversations.history(editor.id, a.threadId).rows.length, 1);
  const replay = randomUUID();
  await service.retry(editor.id, a.threadId, report.id, replay);
  await service.retry(editor.id, a.threadId, report.id, replay);
  await service.review(a.threadId);
  assert.deepEqual(picks, ['claude-3:claude-sonnet-4-6', 'claude-3:claude-sonnet-4-6']);
  assert.deepEqual(reopened.reports(editor.id, a.threadId)[0].retry, { previous: report.id, operationId: replay });
});
