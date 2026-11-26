import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { BotConversations } from '../../../src/bots/conversations.ts';
import { BotRepository } from '../../../src/bots/repository.ts';
import { BotRequests } from '../../../src/bots/request-service.ts';
import { makeHarness, tick, tmpDir } from '../../helpers/fakes.ts';
import { buildThreadbearTools } from '../../../src/threadbear-mcp.ts';
import { ThreadRouter } from '../../../src/handover.ts';
import { botRequestMethods } from '../../../src/bots/rpc.ts';
import { CallerGate } from '../../../src/rpc-gate.ts';
import { RpcServer } from '../../../src/rpc.ts';
import { RunnerClient } from '../../../src/client.ts';
import { threadKey } from '../../../src/rpc-auth.ts';
import { nullLogger } from '../../../src/log.ts';

test('a delegated result goes once to the originating Bot conversation and keeps its whole Japanese reply', async () => {
  const home = tmpDir();
  const root = join(home, 'bots');
  let conversations: BotConversations;
  let requests: BotRequests;
  const h = makeHarness(home, {}, {
    botContext: record => conversations.context(record),
    botRequestQueue: (id, ref) => requests.queue(id, ref),
  });
  const repo = new BotRepository(root, 'runner');
  conversations = new BotConversations(h.runner, repo, root);
  const editor = repo.create({ name: '編集者' });
  const writer = repo.create({ name: 'ライター' });
  const original = conversations.create(editor.id, 'editor-a');
  const unrelated = conversations.create(editor.id, 'editor-b');
  const target = conversations.create(writer.id, 'writer-a');
  const makeService = (runner = h.runner) => new BotRequests({
    root, runner, repo, owns: () => true, protect: () => {}, warn: () => assert.fail('Could not reconcile the test request'),
  });
  requests = makeService();
  h.runner.send(original.threadId, 'Check the draft');
  await tick();
  const sourceSession = h.adapter.last;
  sourceSession.init();
  sourceSession.result();
  await tick();

  const request = { to: writer.id, text: '見出しを提案してください。', name: 'headline', when: 'queue' as const };
  const authorize = async () => 'full' as const;
  const accepted = await requests.sendBot(original.threadId, request, authorize);
  assert.equal(accepted.threadId, target.threadId);
  assert.deepEqual(await requests.sendBot(original.threadId, request, authorize), accepted);
  await tick();
  const targetSession = h.adapter.last;
  assert.notEqual(targetSession, sourceSession);
  assert.equal(targetSession.sent.length, 1);
  targetSession.init();
  const full = '長い日本語の返事。'.repeat(450);
  targetSession.text('result', full);
  targetSession.result();
  await tick();

  requests = makeService();
  requests.recover(target.threadId);
  await tick();
  assert.match(sourceSession.sent.at(-1)?.text ?? '', /Bot result for/);
  assert.ok(sourceSession.sent.at(-1)?.text.endsWith(full));
  requests.recover();
  assert.equal(sourceSession.sent.filter(input => input.text.includes('Bot result for')).length, 1);
  assert.deepEqual(requests.ownerRead(original.threadId, accepted.requestId).result, { text: full, whole: true });
  assert.equal(requests.ownerList(unrelated.threadId).length, 0);
  assert.throws(() => requests.ownerRead(unrelated.threadId, accepted.requestId), /another conversation/);
});


function setup() {
  const home = tmpDir();
  const root = join(home, 'bots');
  let conversations: BotConversations;
  let requests: BotRequests;
  const h = makeHarness(home, {}, {
    botContext: record => conversations.context(record),
    botRequestQueue: (id, ref) => requests.queue(id, ref),
  });
  const repo = new BotRepository(root, 'runner');
  conversations = new BotConversations(h.runner, repo, root);
  const source = conversations.create(repo.create({ name: 'Editor' }).id, 'editor');
  const writer = repo.create({ name: 'Writer' });
  const target = conversations.create(writer.id, 'writer');
  requests = new BotRequests({ root, runner: h.runner, repo, owns: () => true, protect: () => {}, warn: () => {} });
  return { h, repo, conversations, source, target, writer, requests };
}

test('only the owner uses request RPCs and a JSON caller cannot insert a Bot request correlation', async t => {
  const { h, source, target, writer, requests } = setup();
  const { runner } = h;
  const token = 'test-owner-token';
  const server = new RpcServer({
    host: '127.0.0.1', port: 0, token, runner, log: nullLogger,
    gate: new CallerGate({ runner }), methods: botRequestMethods(() => requests),
  });
  const { port } = await server.listen();
  const url = `ws://127.0.0.1:${port}/rpc`;
  const owner = await RunnerClient.connect(url, token);
  const caller = runner.makeThread({ text: '', permissionMode: 'full' }).st.rec.id;
  const agent = await RunnerClient.connect(url, threadKey(token, caller), { threadId: caller });
  t.after(async () => { owner.close(); agent.close(); await server.close(); });
  const params = { threadId: source.threadId, botId: writer.id, name: 'a', text: 'Summarize this', when: 'queue' };
  await assert.rejects(agent.call('bots.requests.send', params), /owner/);
  const receipt = await owner.call<{ requestId: string }>('bots.requests.send', params);
  await tick();
  await assert.rejects(agent.call('bots.requests.list', { threadId: source.threadId }), /owner/);
  assert.equal(requests.ownerList(source.threadId).length, 1);
  await agent.call('threads.send', { threadId: target.threadId, text: 'Ordinary message', botRequest: { id: receipt.requestId, role: 'result' } });
  await tick();
  const journal = h.store.log(target.threadId);
  const inputs = journal.read(1, journal.lastSeq).filter(event => event.type === 'user.message');
  assert.equal(inputs.find(event => event.text === 'Summarize this')?.botInput?.request?.role, 'request');
  assert.equal(inputs.find(event => event.text === 'Ordinary message')?.botInput?.request, undefined);
});

test('message_bot shares the permission ceiling checked for the destination named in the card', async () => {
  const { h, source, target, writer, requests } = setup();
  const { runner } = h;
  runner.update({ threadId: source.threadId, permissionMode: 'ask' });
  runner.update({ threadId: target.threadId, permissionMode: 'auto' });
  runner.send(source.threadId, 'Review the phrasing');
  await tick();
  h.adapter.last.init();
  const control = new ThreadRouter(runner, () => undefined, undefined, source.threadId);
  const tools = buildThreadbearTools(control, source.threadId, Date.now, undefined, undefined, undefined, { botRequests: requests });
  const tool = tools.find(item => item.name === 'message_bot');
  assert.ok(tool);
  const pending = tool.handler({ bot: writer.name, request: 'proofread', text: 'Check the headline', when: 'queue' } as never, {});
  let approval: { approvalId: string } | undefined;
  for (let i = 0; i < 50 && !approval; i++) {
    await tick();
    approval = h.events(source.threadId).find(event => event.type === 'approval.requested') as typeof approval;
  }
  assert.ok(approval);
  runner.update({ threadId: target.threadId, permissionMode: 'full' });
  runner.respondApproval({ threadId: source.threadId, approvalId: approval.approvalId, decision: 'allow' });
  assert.equal((await pending as { isError?: boolean }).isError, true);
  await tick();
  assert.equal(h.adapter.sessions.some(session => session.opts.threadId === target.threadId), false);
});

test('checking a cancelled delivery does not rerun it, and an owner starts a separate attempt only once', async () => {
  const { h, source, target, writer, requests } = setup();
  h.runner.send(target.threadId, 'Current work');
  await tick();
  const accepted = await requests.sendOwner(source.threadId, { to: writer.id, name: 'first', text: 'First brief', when: 'queue' });
  const first = requests.ownerGet(source.threadId, accepted.requestId);
  const cancelled = requests.ownerCancel(source.threadId, first.id, first.revision);
  assert.equal(requests.ownerRetry(source.threadId, first.id, cancelled.revision).state.status, 'cancelled');
  assert.equal(h.store.load(target.threadId)?.queue.length, 0);

  const attempt = await requests.ownerRerun(source.threadId, first.id, cancelled.revision, 'New brief', 'operation');
  assert.notEqual(attempt.requestId, first.id);
  assert.equal(attempt.threadId, first.targetThreadId);
  assert.equal(requests.ownerGet(source.threadId, attempt.requestId).rerunOf, first.id);
  assert.deepEqual(await requests.ownerRerun(source.threadId, first.id, cancelled.revision, 'New brief', 'operation'), attempt);
  assert.deepEqual(h.store.load(target.threadId)?.queue.map(input => input.text), ['New brief']);
});

test('a parent request returns the continuation after a child, and cancelling the parent does not wake it', async () => {
  for (const cancel of [false, true]) {
    const { h, repo, conversations, source, target, writer, requests } = setup();
    const worker = repo.create({ name: 'Reader' });
    const childTarget = conversations.create(worker.id, 'reader');
    const parent = await requests.sendOwner(source.threadId, { to: writer.id, name: 'parent', text: 'Ask for a second opinion', when: 'queue' });
    await tick();
    const parentSession = h.adapter.last;
    parentSession.init();
    await requests.sendBot(target.threadId, { to: worker.id, name: 'child', text: 'Give a second opinion', when: 'queue' }, async () => 'full');
    await tick();
    const childSession = h.adapter.last;
    childSession.init();
    parentSession.text('earlier', 'I asked for a second opinion.');
    parentSession.result();
    await tick();
    requests.recover(target.threadId);
    const current = requests.ownerGet(source.threadId, parent.requestId);
    assert.notEqual(current.state.status, 'returned');
    if (cancel) requests.ownerCancel(source.threadId, current.id, current.revision);

    childSession.text('opinion', 'The heading could be clearer.');
    childSession.result();
    await tick();
    requests.recover(childTarget.threadId);
    await tick();
    if (cancel) {
      assert.equal(parentSession.sent.length, 1);
      continue;
    }
    assert.match(parentSession.sent.at(-1)?.text ?? '', /The heading could be clearer/);
    parentSession.text('conclusion', 'Use a clearer heading.');
    parentSession.result();
    await tick();
    requests.recover(target.threadId);
    assert.deepEqual(requests.ownerRead(source.threadId, parent.requestId).result, { text: 'Use a clearer heading.', whole: true });
  }
});
