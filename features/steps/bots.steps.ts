import assert from 'node:assert/strict';
import { Then, When } from '@cucumber/cucumber';
import type { ThreadbearWorld } from '../support/world.ts';

type BotWorld = ThreadbearWorld & { firstBotThread?: string; secondBotThread?: string };

async function click(world: ThreadbearWorld, tip: string) {
  await world.app.do({ cmd: 'click', tip });
}

When('I create a Bot called {string} from the Bots page', async function (this: BotWorld, name: string) {
  await click(this, 'Bots: assistants with their own settings and notes');
  await click(this, 'New Bot');
  await this.app.do({ cmd: 'type', here: true, text: name });
  await click(this, 'Save');
});

When('I open a new Bot conversation', async function (this: BotWorld) {
  const before = (await this.app.dump()).selection?.id;
  await click(this, 'New conversation');
  this.firstBotThread = await this.until('a new Bot conversation', (d) => d.selection?.id !== before && d.selection?.id);
});

When('I save a note from that conversation saying {string}', async function (this: BotWorld, note: string) {
  await click(this, 'Show the Bot’s notes and settings');
  await click(this, 'Add note');
  await this.app.do({ cmd: 'type', here: true, text: note });
  await click(this, 'Save');
});

When("I open the Bot's Conversations tab", async function (this: BotWorld) {
  await click(this, 'Conversations');
});

When('I open another Bot conversation', async function (this: BotWorld) {
  await click(this, 'New conversation');
  this.secondBotThread = await this.until('another Bot conversation', (d) => d.selection?.id !== this.firstBotThread && d.selection?.id);
});

Then('the two Bot conversations have separate threads', function (this: BotWorld) {
  assert.ok(this.firstBotThread && this.secondBotThread);
  assert.notEqual(this.firstBotThread, this.secondBotThread);
});

When('I open memory from the current Bot conversation', async function (this: BotWorld) {
  await this.until('the selected Bot conversation has reloaded', (d) => d.selection?.id === this.secondBotThread && d.transcript.state === 'loaded');
  await click(this, 'Show the Bot’s notes and settings');
});

Then("the Bot's notes show {string}", async function (this: BotWorld, note: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const labels = JSON.parse(await this.app.do({ cmd: 'labels' })) as { label: string }[];
    if (labels.some((item) => item.label === note)) return;
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  assert.fail(`Could not find the note ${note} on the Bot page`);
});
