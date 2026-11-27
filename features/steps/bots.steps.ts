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

type TaskWorld = BotWorld & { taskBot?: string; taskOrigin?: string; taskThread?: string };

When('I open a Bot conversation ready for a background task', async function (this: TaskWorld) {
  assert.ok(this.app instanceof GpuiDriver);
  const ready = await this.app.withManagedRunner(async client => {
    const { bot } = await client.call<{ bot: { id: string } }>('bots.create', { name: '編集者' });
    const { conversation } = await client.call<{ conversation: { threadId: string } }>('bots.conversations.create', {
      botId: bot.id, operationId: 'original-task-chat',
    });
    return { botId: bot.id, origin: conversation.threadId };
  });
  this.taskBot = ready.botId;
  this.taskOrigin = ready.origin;
  await this.until('the originating conversation appears', d => d.sidebar.sections.some(
    section => section.threads.some(thread => thread.id === ready.origin)));
  await this.app.do({ cmd: 'open', id: ready.origin });
});

When('I start a background task from that conversation', async function (this: TaskWorld) {
  assert.ok(this.app instanceof GpuiDriver);
  await this.until('the originating conversation is loaded', d =>
    d.selection?.id === this.taskOrigin && d.transcript.state === 'loaded');
  await click(this, 'Background tasks');
  await click(this, 'New background task');
  await this.app.do({ cmd: 'type', here: true, text: '見出し案\n背景で見出し案を考える' });
  await click(this, 'Save');
  this.taskThread = await this.app.withManagedRunner(async client => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const { rows } = await client.call<{ rows: { id: string; threadId: string; title: string }[] }>(
        'bots.tasks.list', { botId: this.taskBot });
      const task = rows.find(row => row.title === '見出し案');
      if (task) {
        const { result } = await client.call<{ result?: { whole: boolean; text: string } }>('bots.tasks.read', { taskId: task.id });
        if (result?.whole && result.text === BOT_FIXTURE_REPLY) return task.threadId;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('The isolated Bot background task did not finish');
  });
  assert.notEqual(this.taskThread, this.taskOrigin);
  await click(this, 'Open original conversation');
});

When("I open this Bot's background tasks", async function (this: TaskWorld) {
  await this.until('the originating conversation is loaded', d =>
    d.selection?.id === this.taskOrigin && d.transcript.state === 'loaded');
  await click(this, 'Background tasks');
});

When('I read the saved background task result', async function (this: TaskWorld) {
  await click(this, 'Read task result');
});

Then("I can open the background task's own thread", async function (this: TaskWorld) {
  await click(this, 'Open task');
  await this.until('the background task has a separate selected thread', d =>
    d.selection && d.selection.id === this.taskThread && d.selection.id !== this.taskOrigin && d.transcript.state === 'loaded');
});

Then('I can return directly to its original conversation', async function (this: TaskWorld) {
  await click(this, 'Original conversation');
  await this.until('the original Bot thread opens from the background task', d =>
    d.selection?.id === this.taskOrigin && d.transcript.state === 'loaded');
});

When('I create the Bot team {string}', async function (this: BotWorld, title: string) {
  await click(this, 'Teams');
  await click(this, 'New team');
  await this.app.do({ cmd: 'type', here: true, text: title });
  await click(this, 'Save');
});

When('I add {string} to the Bot team', async function (this: BotWorld, bot: string) {
  await click(this, `Add ${bot}`);
});

When('I appoint {string} as the first Chief', async function (this: BotWorld, bot: string) {
  await click(this, `Make ${bot} Chief`);
});

When('I replace the Chief with {string}', async function (this: BotWorld, bot: string) {
  await click(this, `Replace Chief with ${bot}`);
});

When('I add {string} to the team and appoint it as Chief in Japanese', async function (this: BotWorld, bot: string) {
  await click(this, `${bot}を追加`);
  await click(this, `${bot}をChiefにする`);
});

Then('{string} is the Chief of the Bot team', async function (this: BotWorld, bot: string) {
  assert.ok(this.app instanceof GpuiDriver);
  const deadline = Date.now() + 15_000;
  await this.app.withManagedRunner(async client => {
    while (Date.now() < deadline) {
      const { teams } = await client.call<{ teams: { chiefIds: string[] }[] }>('bots.teams.list', {});
      const { bots } = await client.call<{ bots: { id: string; name: string }[] }>('bots.list', {});
      const chief = bots.find(row => row.name === bot);
      if (teams.length === 1 && teams[0].chiefIds.length === 1 && teams[0].chiefIds[0] === chief?.id) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail(`No team had ${bot} as its Chief.`);
  });
});

type GroupWorld = BotWorld & { groupId?: string };

When('I create a Group called {string} with {string}', async function (this: GroupWorld, title: string, bot: string) {
  await click(this, 'Groups');
  await click(this, 'New group');
  await this.app.do({ cmd: 'type', here: true, text: title });
  await click(this, `Add ${bot}`);
  await click(this, 'Save group');
});

When('I post {string} to the Group', async function (this: GroupWorld, body: string) {
  assert.ok(this.app instanceof GpuiDriver);
  await click(this, 'Group message');
  await this.app.do({ cmd: 'type', here: true, text: body });
  await click(this, 'Post to group');
  this.groupId = await this.app.withManagedRunner(async client => {
    const { groups } = await client.call<{ groups: { id: string }[] }>('bots.groups.list', {});
    assert.equal(groups.length, 1);
    return groups[0].id;
  });
});

Then('the Group has the full saved reply', async function (this: GroupWorld) {
  assert.ok(this.app instanceof GpuiDriver);
  assert.ok(this.groupId);
  await this.app.withManagedRunner(async client => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const { events } = await client.call<{ events: { kind: string; seq: number }[] }>('bots.groups.read', { groupId: this.groupId });
      const result = events.find(event => event.kind === 'result');
      if (result) {
        const reply = await client.call<{ text: string; whole: boolean }>('bots.groups.result', { groupId: this.groupId, seq: result.seq });
        assert.deepEqual(reply, { text: BOT_FIXTURE_REPLY, whole: true });
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail('The Group did not save the member’s reply.');
  });
});

When("I approve the Group's reply as a note", async function (this: GroupWorld) {
  assert.ok(this.app instanceof GpuiDriver);
  assert.ok(this.groupId);
  await click(this, 'Review as note');
  const scope = { kind: 'group', id: this.groupId };
  await this.app.withManagedRunner(async client => {
    const { notes } = await client.call<{ notes: unknown[] }>('bots.memory.scope.read', { scope });
    assert.deepEqual(notes, [], 'opening the draft does not save it');
  });
  await click(this, 'Approve note');
  await this.app.withManagedRunner(async client => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const { notes } = await client.call<{ notes: { text: string }[] }>('bots.memory.scope.read', { scope });
      if (notes.length === 1 && BOT_FIXTURE_REPLY.startsWith(notes[0].text)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail('The approved Group note was not saved.');
  });
});

Then('the Group memory has one approved note from the reply', async function (this: GroupWorld) {
  assert.ok(this.app instanceof GpuiDriver);
  assert.ok(this.groupId);
  await this.app.withManagedRunner(async client => {
    const scope = { kind: 'group', id: this.groupId };
    const { notes } = await client.call<{ notes: { text: string }[] }>('bots.memory.scope.read', { scope });
    assert.equal(notes.length, 1);
    assert.ok(notes[0].text.length > 0 && BOT_FIXTURE_REPLY.startsWith(notes[0].text));
  });
});

When("I stop the Group's work", async function (this: GroupWorld) {
  await click(this, 'Stop work');
});

Then('the Group can be resumed', async function (this: GroupWorld) {
  await click(this, 'Resume');
  assert.ok(this.app instanceof GpuiDriver);
  await this.app.withManagedRunner(async client => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const { frozen } = await client.call<{ frozen: boolean }>('bots.groups.read', { groupId: this.groupId });
      if (!frozen) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail('The Group remained stopped.');
  });
});
