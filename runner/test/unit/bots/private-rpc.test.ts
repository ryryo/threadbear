import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { RunnerClient } from '../../../src/client.ts';
import { ThreadRouter, phoneCommands } from '../../../src/handover.ts';
import { nullLogger } from '../../../src/log.ts';
import { ErrorCode, RpcError } from '../../../src/protocol.ts';
import { threadKey } from '../../../src/rpc-auth.ts';
import { CallerGate } from '../../../src/rpc-gate.ts';
import { RpcServer } from '../../../src/rpc.ts';
import type { ToolApprovalAnswer } from '../../../src/adapters/types.ts';
import type { AgentApprovalRequest } from '../../../src/threadbear-mcp.ts';
import { makeHarness, tmpDir } from '../../helpers/fakes.ts';

test('Full access and explicit IDs do not reveal private Bot events, summaries or search matches', async t => {
  const h = makeHarness(tmpDir());
  const token = 'private-bot-rpc-fixture';
  const outsider = h.runner.makeThread({ text: '', title: 'Ordinary matching', permissionMode: 'full' }).st.rec.id;
  const privateBotId = randomUUID();
  const linked = h.runner.makeThread({ text: '', title: 'Sensitive matching', permissionMode: 'full' }, { id: randomUUID(), sessionId: randomUUID(), privateBotId }).st.rec.id;
  const server = new RpcServer({ host: '127.0.0.1', port: 0, token, runner: h.runner, log: nullLogger, gate: new CallerGate({ runner: h.runner }), methods: {
    'schedules.list': () => ({ schedules: [{ threadId: linked, title: 'Sensitive schedule' }, { threadId: outsider, title: 'Ordinary schedule' }] }),
    'runner.status': () => ({ busy: [linked, outsider], background: [{ threadId: linked, tasks: ['Sensitive task'] }] }),
  } });
  const { port } = await server.listen();
  const url = `ws://127.0.0.1:${port}/rpc`;
  const full = await RunnerClient.connect(url, threadKey(token, outsider), { threadId: outsider });
  const own = await RunnerClient.connect(url, threadKey(token, linked), { threadId: linked });
  const owner = await RunnerClient.connect(url, token);
  t.after(async () => { full.close(); own.close(); owner.close(); await server.close(); });

  const observed: unknown[] = [];
  full.onNotification((_method, params) => observed.push(params));
  const callerList = await full.call<{ threads: { id: string }[] }>('threads.list', { ids: [linked, outsider] });
  assert.deepEqual(callerList.threads.map(thread => thread.id), [outsider]);
  const matches = await full.call<{ threads: { id: string }[] }>('threads.search', { query: 'matching', limit: 1 });
  assert.deepEqual(matches.threads.map(thread => thread.id), [outsider]);
  assert.deepEqual(await full.call('runner.status'), { busy: [outsider], background: [] });
  assert.deepEqual(await full.call('schedules.list'), { schedules: [{ threadId: outsider, title: 'Ordinary schedule' }] });
  await assert.rejects(full.call('threads.events', { threadId: linked }), /Thread not found/);
  await assert.rejects(full.call('threads.subscribe', { threadId: linked }), /Thread not found/);
  await assert.rejects(own.call('threads.send', { threadId: outsider, text: 'Sensitive content' }), /needs the owner/);
  await assert.rejects(own.call('approvals.respond', { threadId: linked }), /Only the local owner/);
  await assert.rejects(own.call('threads.update', { threadId: outsider, title: 'Outside' }), /write outside/);
  await assert.rejects(own.call('schedules.create', { threadId: linked, text: 'Private' }), /write outside/);
  await assert.rejects(owner.call('threads.share', { threadId: linked, access: 'link' }), /cannot have a shared link/);
  await assert.doesNotReject(owner.call('threads.events', { threadId: linked }));
  await assert.doesNotReject(own.call('threads.events', { threadId: linked }));
  await owner.call('threads.update', { threadId: linked, title: 'Sensitive updated' });
  await full.call('threads.list');
  assert.doesNotMatch(JSON.stringify(observed), /Sensitive/);
});

test('disclosure approval binds the full text, destination and local owner decision', async () => {
  const h = makeHarness(tmpDir());
  const ordinary = h.runner.makeThread({ text: '', title: 'Destination' }).st.rec;
  const privateBotId = randomUUID();
  const own = h.runner.makeThread({ text: '', title: 'Private' }, { id: randomUUID(), sessionId: randomUUID(), privateBotId }).st.rec.id;
  const router = new ThreadRouter(h.runner, () => undefined, () => undefined, own);
  let called = Promise.withResolvers<AgentApprovalRequest>();
  let permission = Promise.withResolvers<ToolApprovalAnswer>();
  h.runner.requestAgentApproval = async (actor, request) => {
    assert.equal(actor, own);
    called.resolve(request);
    return permission.promise;
  };
  const sent: unknown[] = [];
  h.runner.send = (id, text) => { sent.push({ id, text }); return { turnId: 'fixture' }; };
  const text = 'Share exactly this text';
  const accepted = router.send(ordinary.id, text);
  const request = await called.promise;
  assert.equal(request.noReview, true);
  assert.deepEqual(request.input, { threadId: ordinary.id, destination: 'Destination', text, bodyHash: createHash('sha256').update(text).digest('hex') });
  assert.deepEqual(sent, []);
  permission.resolve({ decision: 'allow' });
  await accepted;
  assert.deepEqual(sent, [{ id: ordinary.id, text }]);

  called = Promise.withResolvers();
  permission = Promise.withResolvers();
  const changed = router.send(ordinary.id, text);
  await called.promise;
  ordinary.title = 'A renamed destination';
  permission.resolve({ decision: 'allow' });
  await assert.rejects(changed, /changed while waiting/);
  assert.equal(sent.length, 1);
});

test('agent tools and the sync command path use the same persisted Private identity', async () => {
  const h = makeHarness(tmpDir());
  const publicThread = h.runner.makeThread({ text: '', title: 'Ordinary match' }).st.rec.id;
  const privateBotId = randomUUID();
  const own = h.runner.makeThread({ text: '', title: 'Private match' }, { id: randomUUID(), sessionId: randomUUID(), privateBotId }).st.rec.id;
  const router = new ThreadRouter(h.runner, () => undefined, () => undefined, publicThread);
  const locked = new ThreadRouter(h.runner, () => undefined, () => undefined, own);
  h.runner.requestAgentApproval = async () => ({ decision: 'deny' });
  assert.deepEqual((await router.search('match', 1)).map(thread => thread.id), [publicThread]);
  assert.deepEqual((await router.list()).map(thread => thread.id), [publicThread]);
  await assert.rejects(router.events(own), /Thread not found/);
  await assert.rejects(locked.send(publicThread, 'Private'), /needs the owner/);
  await assert.rejects(locked.update({ threadId: publicThread, title: 'Outside' }), /write outside/);
  await assert.doesNotReject(locked.events(own));
  const phone = phoneCommands(h.runner, undefined, id => {
    if (h.runner.privateBotOf(id)) throw new RpcError(ErrorCode.threadNotFound, `Thread not found: ${id}`);
  });
  assert.throws(() => phone.send(own, 'A phone command', [], { origin: 'phone' }), /Thread not found/);
  assert.throws(() => phone.markSeen?.(own), /Thread not found/);
});
