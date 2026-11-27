import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { BotRepository } from '../../../src/bots/repository.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'threadbear-bot-roster-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, open: () => new BotRepository(root, 'runner-1') };
}

test('the roster reserves names and saves neither partial edits nor a new id on rename', t => {
  const { open } = fixture(t);
  const repo = open();
  const writer = repo.create({ name: ' Editor ' });
  assert.throws(() => repo.create({ name: 'editor' }), /already exists/);
  const current = repo.update(writer.id, writer.revision, { name: '編集者' });
  assert.equal(current.id, writer.id);
  assert.throws(() => repo.update(writer.id, writer.revision, { name: 'Stale' }), /changed/);
  assert.deepEqual(open().list(), [current]);
});

test('the ported roster rejects names that cannot be mentioned', t => {
  const { open } = fixture(t);
  const roster = open();
  for (const name of ['a@b', 'All', '所有人']) assert.throws(() => roster.create({ name }), /cannot/);
  const writer = roster.create({ name: 'Writer 2' });
  assert.throws(() => roster.update(writer.id, writer.revision, { name: 'Writer@home' }), /cannot/);
  assert.equal(roster.update(writer.id, writer.revision, { name: '新 Writer' }).name, '新 Writer');
});

test('a failed save does not leave the Bot registered in memory', t => {
  const { root, open } = fixture(t);
  const repo = open();
  const file = join(root, 'state.json');
  mkdirSync(file);
  assert.throws(() => repo.create({ name: 'Editor' }));
  assert.deepEqual(repo.list(), []);
  rmSync(file, { recursive: true });
  assert.equal(repo.create({ name: 'Editor' }).name, 'Editor');
});

test('separate conversations reserve distinct Thread and session ids and keep their links after reopening', t => {
  const { open } = fixture(t);
  const repo = open();
  const bot = repo.create({ name: '編集者' });
  const a = repo.reserveConversation(bot.id, 'operation-a');
  const b = repo.reserveConversation(bot.id, 'operation-b');
  assert.notEqual(a.threadId, b.threadId);
  assert.notEqual(a.sessionId, b.sessionId);
  assert.deepEqual(repo.conversations(bot.id), []);
  const restarted = open();
  assert.deepEqual(restarted.reserveConversation(bot.id, 'operation-a'), a);
  assert.throws(() => restarted.confirmConversation('operation-a', b.threadId), /does not match/);
  restarted.confirmConversation('operation-a', a.threadId);
  restarted.confirmConversation('operation-b', b.threadId);
  const links = open().conversations(bot.id);
  assert.deepEqual(links.map(link => [link.id, link.threadId]), [[a.id, a.threadId], [b.id, b.threadId]]);
  assert.deepEqual(open().reserveConversation(bot.id, 'operation-a'), links[0]);
});

test('corrupt state remains intact and cannot be treated as an empty roster', t => {
  const { root, open } = fixture(t);
  writeFileSync(join(root, 'state.json'), '{');
  assert.throws(() => open(), /could not read/i);
});

test('renaming a Bot after reopening preserves fields from a newer writer in saved settings', t => {
  const { root, open } = fixture(t);
  const bot = open().create({ name: 'Editor' });
  const file = join(root, 'state.json');
  const state = JSON.parse(readFileSync(file, 'utf8'));
  const modelBinding = { accountId: 'login', provider: 'codex', model: 'model', futureField: ['keep'] };
  const privacy = { folder: '/private-editor', operationId: 'privacy-edit', futureField: { keep: true } };
  Object.assign(state.bots[0], { modelBinding, privacy });
  writeFileSync(file, JSON.stringify(state));

  open().update(bot.id, bot.revision, { name: 'Reviewer' });
  const saved = JSON.parse(readFileSync(file, 'utf8')).bots[0];
  assert.deepEqual(saved.modelBinding, modelBinding);
  assert.deepEqual(saved.privacy, privacy);
  assert.equal(saved.name, 'Reviewer');

  saved.modelBinding.provider = 'unknown-authority';
  state.bots[0] = saved;
  writeFileSync(file, JSON.stringify(state));
  assert.throws(() => open(), /could not read/i);
});

test('paired-device edit acknowledgements expose only the paired profile fields', t => {
  const { root, open } = fixture(t);
  const bot = open().create({ name: 'Editor' });
  const file = join(root, 'state.json');
  const state = JSON.parse(readFileSync(file, 'utf8'));
  Object.assign(state.bots[0], {
    workFolder: '/local-fixture',
    modelBinding: { accountId: 'local-login', provider: 'codex', model: 'model' },
    futureLocalField: 'owner-only fixture',
  });
  writeFileSync(file, JSON.stringify(state));

  const profile = { id: bot.id, name: 'Reviewer', role: '', instructions: '', revision: 2 };
  const edit = (rev: number, op: string) => open().updateWithReceipt(bot.id, rev, { name: 'Reviewer' }, op);
  assert.deepEqual(edit(1, 'edit-profile'), { outcome: 'saved', bot: profile });
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  // An older writer may already have saved the full row as its receipt.
  stored.profileReceipts[0].bot = stored.bots[0];
  writeFileSync(file, JSON.stringify(stored));
  assert.deepEqual(edit(1, 'edit-profile'), { outcome: 'saved', bot: profile });
  assert.deepEqual(edit(1, 'conflict'), { outcome: 'conflict', current: profile, draft: { name: 'Reviewer' } });
});
