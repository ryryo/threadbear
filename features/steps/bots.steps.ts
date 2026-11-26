import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import { GpuiDriver } from '../support/gpui.ts';
import type { ThreadbearWorld } from '../support/world.ts';
import { BOT_FIXTURE_REPLY } from '../../runner/test/helpers/managed-runner.ts';

type BotWorld = ThreadbearWorld & { firstBotThread?: string; secondBotThread?: string; requestSource?: string };

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

When('I open a Bot conversation with a completed request', async function (this: BotWorld) {
  assert.ok(this.app instanceof GpuiDriver);
  this.requestSource = await this.app.withManagedRunner(async client => {
    type Bot = { bot: { id: string } };
    type Linked = { conversation: { threadId: string } };
    const { bot: editor } = await client.call<Bot>('bots.create', { name: '編集者' });
    const { bot: writer } = await client.call<Bot>('bots.create', { name: 'ライター' });
    const { conversation: original } = await client.call<Linked>('bots.conversations.create', { botId: editor.id, operationId: 'original' });
    await client.call('bots.conversations.create', { botId: writer.id, operationId: 'recipient' });
    const { requestId } = await client.call<{ requestId: string }>('bots.requests.send', {
      threadId: original.threadId, botId: writer.id, name: 'heading', text: '見出しを提案してください。', when: 'queue',
    });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const { result } = await client.call<{ result?: { whole: boolean; text: string } }>('bots.requests.get', { threadId: original.threadId, requestId });
      if (result?.whole && result.text === BOT_FIXTURE_REPLY) return original.threadId;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('The isolated Bot request did not return its full reply');
  });
  await this.until('the original Bot conversation appears', d => d.sidebar.sections.some(section =>
    section.threads.some(thread => thread.id === this.requestSource)));
  await this.app.do({ cmd: 'open', id: this.requestSource });
});

When('I open requests from the original Bot conversation', async function (this: BotWorld) {
  await this.until('the original Bot conversation is loaded', d => d.selection?.id === this.requestSource && d.transcript.state === 'loaded');
  await click(this, 'Requests from this conversation');
});

When('I read the saved Bot request result', async function (this: BotWorld) {
  await click(this, 'Read result');
});

Then('I see the full saved request result', async function (this: BotWorld) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const item = await this.app.do({ cmd: 'a11y', label: BOT_FIXTURE_REPLY });
      assert.match(item, /^ok /);
      return;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('nothing labelled') || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
});
