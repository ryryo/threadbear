import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { BotConversations } from '../../../src/bots/conversations.ts';
import { BotRepository } from '../../../src/bots/repository.ts';
import { BotReviews } from '../../../src/bots/reviews.ts';
import { PersonalMemory } from '../../../src/bots/ported/personal-memory.js';
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
  repo.setAutomation(editor.id, modelSaved.revision, 'reviewEnabled', true, randomUUID());
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

test('an opted-in Bot only reviews its regular conversations when a Group thread is idle', async () => {
  const home = tmpDir();
  const root = join(home, 'bots');
  const { runner } = makeHarness(home);
  const repo = new BotRepository(root, 'runner');
  const bot = repo.create({ name: 'Reviewer' });
  const bound = repo.setModelBinding(bot.id, bot.revision, {
    provider: 'claude', accountId: 'claude-3', model: 'claude-sonnet-4-6',
  });
  repo.setAutomation(bot.id, bound.revision, 'reviewEnabled', true, randomUUID());
  const { st } = runner.makeThread({ text: '', title: 'Group work', worktree: false }, {
    id: randomUUID(), sessionId: randomUUID(),
    botLink: { botId: bot.id, groupId: 'desk', conversationId: 'group-conversation' },
  });
  const service = new BotReviews({
    root, repo, runner, enabled: () => true, redact: String,
    askers: { claude: async () => { throw new Error('Group work must use the Group memory decision'); } },
  });
  await assert.doesNotReject(service.review(st.rec.id));
});

test('automatic tidy uses the same selected login and only starts after a scope changes', async () => {
  const home = tmpDir();
  const root = join(home, 'bots');
  let conversations: BotConversations;
  const h = makeHarness(home, {}, { botContext: rec => conversations.context(rec) });
  const repo = new BotRepository(root, 'runner-1');
  conversations = new BotConversations(h.runner, repo, root);
  const bot = repo.create({ name: 'Writer' });
  const link = conversations.create(bot.id, 'chat');
  h.runner.update({ threadId: link.threadId, accountId: 'claude-3', model: 'claude-sonnet-4-6' });
  const bound = conversations.conversationModel(bot.id, bot.revision, link.threadId);
  const reviewed = repo.setAutomation(bot.id, bound.revision, 'reviewEnabled', true, randomUUID());
  repo.setAutomation(bot.id, reviewed.revision, 'tidyEnabled', true, randomUUID());
  const memoryRoot = join(root, 'memory', bot.id);
  const memory = new PersonalMemory(memoryRoot);
  memory.add('A pinned owner note', {}, h.runner.isoNow());
  const imported = Array.from({ length: 8 }, (_, index) => `- Prior fact ${index} [id: old${index}; added: 2026-10-03]`);
  appendFileSync(join(memoryRoot, 'MEMORY.md'), `\n## Imported notes\n${imported.join('\n')}\n`);
  const requested: string[] = [];
  let protectedWrites = 0;
  const service = new BotReviews({
    root, repo, runner: h.runner, enabled: () => true, redact: String,
    protectTidy: () => { protectedWrites++; },
    askers: { claude: async request => {
      assert.equal(request.account.id, 'claude-3');
      const tidy = request.system.includes('You tidy');
      requested.push(tidy ? 'tidy' : 'review');
      return { ok: true, text: tidy ? '{"changes":[{"op":"retire","entry":1,"why":"old"}]}' : '{"changes":[{"op":"add","text":"The user wants short headings"}]}' };
    } },
  });
  h.runner.send(link.threadId, 'Use short headings', [], { botSource: { kind: 'owner' } });
  await tick();
  h.adapter.last.init();
  h.adapter.last.result('completed');
  await tick();
  await service.review(link.threadId);
  assert.deepEqual(requested, ['review']);
  const [proposal] = service.reports(bot.id, link.threadId);
  service.approve(bot.id, link.threadId, proposal.id, 0, 'fixture-approve');
  await service.review(link.threadId);
  assert.deepEqual(requested, ['review', 'tidy']);
  assert.equal(protectedWrites, 1);
  assert.equal(memory.history()[0].op, 'tidy');
  assert.ok(memory.list('2026-11-27').some(note => note.pinned));
});
