import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { test } from 'node:test';
import { ProfilePanelServer } from '../../../src/bots/profile-panel.ts';
import { RunnerClient } from '../../../src/client.ts';
import { nullLogger } from '../../../src/log.ts';
import { threadKey } from '../../../src/rpc-auth.ts';
import { CallerGate } from '../../../src/rpc-gate.ts';
import { RpcServer } from '../../../src/rpc.ts';
import { makeHarness, tmpDir } from '../../helpers/fakes.ts';

test('the profile panel can edit only its selected live Bot and only one profile field', async t => {
  let available = true;
  let connected = true;
  let now = 0;
  const profiles = new Map([
    ['one', { id: 'one', name: '編集者', role: '', instructions: '', revision: 1 }],
    ['two', { id: 'two', name: 'Other', role: '', instructions: '', revision: 1 }],
  ]);
  const panel = new ProfilePanelServer({
    now: () => now,
    read: id => available ? profiles.get(id) : undefined,
    update: (id, revision, field) => {
      const previous = profiles.get(id)!;
      if (previous.revision !== revision) throw new Error('The Bot changed.');
      const saved = { ...previous, ...field, revision: revision + 1 };
      profiles.set(id, saved);
      return saved;
    },
  });
  t.after(() => panel.dispose());
  const open = (id: string) => panel.open(id, () => connected);
  const first = await open('one');
  const url = new URL(first.url);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.hash, '#' + first.id);
  const request = (id: string, body?: object, origin = url.origin) => fetch(new URL('/api/profile', url), {
    method: body ? 'PATCH' : 'GET',
    headers: { 'X-Threadbear-Profile': id, ...(body ? { 'Content-Type': 'application/json', Origin: origin } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const html = await fetch(url.origin);
  assert.match(html.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  assert.match(await html.text(), /profile\.js/);
  const script = await fetch(new URL('/profile.js', url));
  assert.equal(script.status, 200);
  assert.ok((await script.text()).includes('X-Threadbear-Profile'));
  assert.equal((await request('missing')).status, 403);
  assert.deepEqual(await (await request(first.id)).json(), profiles.get('one'));
  const change = { expectedRevision: 1, role: '校正者' };
  assert.equal((await request(first.id, change, 'https://not-the-panel.example')).status, 403);
  for (const unwanted of [{ ...change, botId: 'two' }, { ...change, private: true }, { ...change, name: 'New' }]) {
    assert.equal((await request(first.id, unwanted)).status, 400);
  }
  assert.equal((await request(first.id, change)).status, 200);
  assert.equal((await request(first.id, change)).status, 409);
  assert.equal(profiles.get('one')?.role, '校正者');
  assert.equal(profiles.get('two')?.role, '');

  const second = await open('two');
  assert.equal((await request(first.id)).status, 403);
  panel.close(first.id);
  assert.equal((await request(second.id)).status, 200);
  available = false;
  assert.equal((await request(second.id)).status, 403);
  available = true;
  panel.close(second.id);
  assert.equal((await request(second.id)).status, 403);
  const third = await open('two');
  connected = false;
  assert.equal((await request(third.id)).status, 403);
  connected = true;
  now += 24 * 60 * 60_000;
  assert.equal((await request(third.id)).status, 403);
});

test('only the local owner desktop connection can open the profile and its disconnect revokes access', async t => {
  const h = makeHarness(tmpDir());
  const profile = { id: 'fixture-bot', name: 'Editor', role: '', instructions: '', revision: 1 };
  const panel = new ProfilePanelServer({ read: () => profile, update: () => assert.fail('read-only fixture') });
  const token = 'isolated-profile-owner';
  const rpc = new RpcServer({ host: '127.0.0.1', port: 0, token, runner: h.runner, log: nullLogger,
    gate: new CallerGate({ runner: h.runner }),
    botProfilePanel: { open: (p, connected) => panel.open(String(p.botId), connected), close: () => ({}) },
  });
  const { port } = await rpc.listen();
  const address = `ws://127.0.0.1:${port}/rpc`;
  const owner = await RunnerClient.connect(address, token);
  const id = h.runner.makeThread({ text: '', permissionMode: 'full' }).st.rec.id;
  const thread = await RunnerClient.connect(address, threadKey(token, id), { threadId: id });
  t.after(async () => { owner.close(); thread.close(); await rpc.close(); await panel.dispose(); });
  await assert.rejects(owner.call('bots.profilePanel.open', { botId: profile.id }), /local Threadbear/);
  await thread.call('hello', { client: 'threadbear-desktop' });
  await assert.rejects(thread.call('bots.profilePanel.open', { botId: profile.id }), /owner/);
  await owner.call('hello', { client: 'threadbear-desktop' });
  const lease = await owner.call<{ id: string; url: string }>('bots.profilePanel.open', { botId: profile.id });
  const read = () => fetch(new URL('/api/profile', lease.url), { headers: { 'X-Threadbear-Profile': lease.id } });
  assert.deepEqual(await (await read()).json(), profile);
  owner.close();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const reply = await read();
    await reply.body?.cancel();
    if (reply.status === 403) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('The profile capability outlived its owner connection');
});

test('closing a view rejects a save that has not finished sending its body', async t => {
  let checking: (() => void) | undefined;
  const profile = { id: 'fixture-bot', name: 'Editor', role: '', instructions: '', revision: 1 };
  const panel = new ProfilePanelServer({ read: () => { checking?.(); return profile; }, update: () => assert.fail('closed view wrote') });
  t.after(() => panel.dispose());
  const lease = await panel.open(profile.id, () => true);
  const url = new URL('/api/profile', lease.url);
  const reading = Promise.withResolvers<void>();
  const complete = Promise.withResolvers<number | undefined>();
  checking = reading.resolve;
  const first = '{"expectedRevision":1,';
  const rest = '"role":"Late"}';
  const send = httpRequest(url, { method: 'PATCH', headers: {
    'X-Threadbear-Profile': lease.id, Origin: url.origin,
    'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(first + rest),
  } }, response => {
    response.resume();
    complete.resolve(response.statusCode);
  });
  send.on('error', error => complete.reject(error));
  send.write(first);
  await reading.promise;
  panel.close(lease.id);
  send.end(rest);
  assert.equal(await complete.promise, 403);
});
