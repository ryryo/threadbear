import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import { GpuiDriver } from '../support/gpui.ts';
import type { ThreadbearWorld } from '../support/world.ts';

type BotWorld = ThreadbearWorld & { firstBotThread?: string; secondBotThread?: string };

Given('the app is connected to an isolated Bot Runner', async function (this: BotWorld) {
  await this.until('the app connected to the Bot Runner', d => d.connection === 'connected', 30_000);
});

When('the isolated Bot Runner restarts', async function (this: BotWorld) {
  assert.ok(this.app instanceof GpuiDriver);
  await this.app.restartManagedRunner();
});

async function click(world: ThreadbearWorld, tip: string) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await world.app.do({ cmd: 'click', tip, enabled: true });
      return;
    } catch (error) {
      if (!(error instanceof Error) || !/(no control with the tip|is disabled)/.test(error.message)) throw error;
      if (Date.now() >= deadline) throw new Error(`${error.message}\nControls: ${await world.app.do({ cmd: 'labels' })}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
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

When("I open the Bot's Memory tab", async function (this: BotWorld) {
  await click(this, 'Memory');
});

When('I select {string} in Bot memory', async function (this: BotWorld, scope: string) {
  await click(this, scope);
});

When('I add a Bot memory note saying {string}', async function (this: BotWorld, note: string) {
  await click(this, 'Add note');
  await this.app.do({ cmd: 'type', here: true, text: note });
  await click(this, 'Save');
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

Then("the Bot's notes do not show {string}", async function (this: BotWorld, note: string) {
  const labels = JSON.parse(await this.app.do({ cmd: 'labels' })) as { label: string }[];
  assert.ok(!labels.some(item => item.label === note));
});
