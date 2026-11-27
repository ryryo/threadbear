import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { BotRepository } from '../../../src/bots/repository.ts';
import { tmpDir } from '../../helpers/fakes.ts';

test('two editors cannot share a saved Bot revision, and a lost reply recovers its original receipt', () => {
  const home = join(tmpDir(), 'bots');
  const writer = new BotRepository(home, 'runner');
  const bot = writer.create({ name: 'Editor' });
  const first = writer.updateWithReceipt(bot.id, bot.revision, { name: 'Copy Editor' }, 'device-a');
  assert.equal(first.outcome, 'saved');
  const conflict = writer.updateWithReceipt(bot.id, bot.revision, { name: 'Lead Editor' }, 'device-b');
  assert.deepEqual(conflict, {
    outcome: 'conflict', current: first.bot, draft: { name: 'Lead Editor' },
  });
  const reopened = new BotRepository(home, 'runner');
  const retry = reopened.updateWithReceipt(bot.id, bot.revision, { name: 'Copy Editor' }, 'device-a');
  assert.deepEqual(retry, first);
  assert.throws(() => reopened.updateWithReceipt(bot.id, bot.revision, { name: 'Different work' }, 'device-a'), /different edit/);
  assert.equal(reopened.get(bot.id).revision, bot.revision + 1);
});

test('a failed durable write leaves both the accepted revision and its receipt absent', () => {
  const home = join(tmpDir(), 'bots');
  let rejected = false;
  const writer = new BotRepository(home, 'runner', () => { if (rejected) throw new Error('ENOSPC'); });
  const bot = writer.create({ name: 'Editor' });
  rejected = true;
  assert.throws(() => writer.updateWithReceipt(bot.id, bot.revision, { instructions: 'Prefer short titles' }, 'pending'), /ENOSPC/);
  assert.deepEqual(writer.get(bot.id), bot);
  const recovered = new BotRepository(home, 'runner');
  assert.deepEqual(recovered.get(bot.id), bot);
  assert.equal(recovered.updateWithReceipt(bot.id, bot.revision, { instructions: 'Prefer short titles' }, 'pending').outcome, 'saved');
});
