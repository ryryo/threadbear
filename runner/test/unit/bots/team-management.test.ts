import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, renameSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { BotConversations } from '../../../src/bots/conversations.ts';
import { BotRepository } from '../../../src/bots/repository.ts';
import { BotTeams } from '../../../src/bots/teams.ts';
import { makeHarness, tick, tmpDir } from '../../helpers/fakes.ts';

async function fixture() {
  const home = tmpDir();
  const root = join(home, 'bots');
  let conversations: BotConversations;
  const h = makeHarness(home, {}, { botContext: rec => conversations.context(rec) });
  const repo = new BotRepository(root, 'owner');
  conversations = new BotConversations(h.runner, repo, root);
  const chief = repo.create({ name: 'Chief' });
  const writer = repo.create({ name: 'Writer' });
  const administrator = conversations.create(chief.id, 'chief');
  const worker = conversations.create(writer.id, 'writer');
  const now = () => h.runner.isoNow();
  const team = repo.createTeam('Editorial', [chief.id, writer.id], now());
  const assigned = repo.setChief(team.id, team.revision, chief.id, { main: true }, now());
  const service = new BotTeams({ repo, runner: h.runner, protect: () => {}, tasks: async () => {} });
  for (const threadId of [administrator.threadId, worker.threadId]) {
    h.runner.update({ threadId, permissionMode: 'full' });
    h.runner.send(threadId, 'Work on the user’s request');
    await tick();
    h.adapter.last.init();
  }
  return { h, repo, chief, writer, administrator, worker, assigned, home, service };
}

test('a Full general Bot and a Chief without a grant cannot update other Bot settings', async () => {
  const { chief, writer, administrator, worker, assigned, service } = await fixture();
  assert.throws(() => service.editBot(worker.threadId, assigned.revision, chief.id, chief.revision, { role: 'Intruder' }), /Only a Chief/);
  assert.throws(() => service.editBot(administrator.threadId, assigned.revision, writer.id, writer.revision, { role: 'Editor' }), /has not allowed/);
});

test('a Chief uses only the saved model, login, folder and permission in an allowed template', { skip: process.platform === 'win32' }, async () => {
  const { h, repo, chief, administrator, assigned, home, service } = await fixture();
  const folder = join(realpathSync.native(home), 'workspace');
  mkdirSync(folder);
  const text = { id: 'copy-editor', role: 'Copy editor', instructions: 'Check titles', accountId: 'claude-3',
    model: 'claude-sonnet-4-6', folder, permissionCeiling: 'ask' as const };
  const granted = service.ownerSetGrants(assigned.id, assigned.revision, chief.id, { createBot: { maxCreated: 2, templates: [text] } });
  assert.throws(() => service.createBot(administrator.threadId, granted.revision, 'other-model', 'Unexpected'), /permitted Bot template/);
  const made = service.createBot(administrator.threadId, granted.revision, text.id, 'Copy editor');
  assert.deepEqual(made.bot.modelBinding, { provider: 'claude', accountId: text.accountId, model: text.model });
  assert.equal(made.bot.workFolder, folder);
  assert.equal(made.bot.permissionCeiling, 'ask');
  assert.equal(repo.teamIdForBot(made.bot.id), assigned.id);
  assert.throws(() => service.createBot(administrator.threadId, granted.revision, text.id, 'Late'), /team changed/);
  const changedFolder = join(home, 'new-workspace');
  renameSync(folder, changedFolder);
  symlinkSync(changedFolder, folder);
  assert.throws(() => service.createBot(administrator.threadId, made.team.revision, text.id, 'Different folder'), /folder changed/);
  h.runner.update({ threadId: administrator.threadId, permissionMode: 'ask' });
  const wide = service.ownerSetGrants(assigned.id, made.team.revision, chief.id, {
    createBot: { maxCreated: 2, templates: [{ ...text, folder: realpathSync.native(changedFolder), permissionCeiling: 'full' }] },
  });
  assert.throws(() => service.createBot(administrator.threadId, wide.revision, text.id, 'Wide capability'), /current permission/);
});
