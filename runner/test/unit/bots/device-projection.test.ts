import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { BotRepository } from '../../../src/bots/repository.ts';
import { DeviceBotWorkspace } from '../../../src/bots/device-workspace.ts';
import { tmpDir } from '../../helpers/fakes.ts';

test('a device sees only eligible Bot records with scrubbed text, and must name the current workspace and epoch', () => {
  const repo = new BotRepository(join(tmpDir(), 'bots'), 'owner');
  const bot = repo.create({ name: 'Editor', instructions: 'Avoid the SAMPLE_VALUE in outputs' });
  const privateBot = repo.create({ name: 'Hidden', instructions: 'Do not leave this Runner' });
  repo.setPrivate(privateBot.id, privateBot.revision, '/private-fixture', 'private', [], () => {});
  let isPrimary = true;
  const workspace = new DeviceBotWorkspace(repo, () => isPrimary, () => {});
  const view = workspace.snapshot(value => value.replaceAll('SAMPLE_VALUE', '[removed]'));
  assert.deepEqual(view.profiles.map(item => item.name), ['Editor']);
  assert.equal(view.profiles[0]?.instructions, 'Avoid the [removed] in outputs');
  const command = {
    workspaceId: view.workspaceId, epoch: view.epoch,
    botId: bot.id, expectedRevision: bot.revision, operationId: 'same', settings: { name: 'Copy Editor' },
  };
  assert.throws(() => workspace.edit({ ...command, epoch: view.epoch + 1 }), /workspace changed/);
  assert.throws(() => workspace.edit({ ...command, botId: privateBot.id }), /unavailable/);
  isPrimary = false;
  assert.throws(() => workspace.edit(command), /primary/);
  assert.equal(repo.get(bot.id).name, 'Editor');
});
