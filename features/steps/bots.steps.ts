import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Given, Then, When } from '@cucumber/cucumber';
import { GpuiDriver } from '../support/gpui.ts';
import { okValue } from '../support/driver.ts';
import type { ThreadbearWorld } from '../support/world.ts';
import { BOT_FIXTURE_REPLY } from '../../runner/test/helpers/managed-runner.ts';

type BotWorld = ThreadbearWorld & { firstBotThread?: string; secondBotThread?: string; requestSource?: string; attachment?: string; attachmentEvents?: unknown[]; profileUrl?: string; libraryPhoto?: string };

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

When("I open the conversations for the worker's Bot", async function (this: BotWorld) {
  await click(this, 'Bots: assistants with their own settings and notes');
  await click(this, 'Editorial Bot');
  await click(this, 'Conversations');
});

When('I ask {string} to do work for the Bot saying {string}', async function (this: BotWorld, runner: string, brief: string) {
  await click(this, 'Run on another Runner');
  await click(this, runner);
  await this.app.do({ cmd: 'type', here: true, text: brief });
  await click(this, 'Save');
});

When('I open the worker requests for that conversation', async function (this: BotWorld) {
  await click(this, 'Worker requests');
});

Then("I can open the remote worker's saved Thread", async function (this: BotWorld) {
  await click(this, 'Open worker Thread');
  await this.until('the completed worker Thread on mac-mini', d =>
    d.selection?.id === 'mini_media' && d.transcript.state === 'loaded');
});

When('I open requests in the Bot workspace', async function (this: BotWorld) {
  await click(this, 'Bots: assistants with their own settings and notes');
  await click(this, 'Editorial Bot');
  await click(this, 'Requests');
});

When('I give up waiting for a delegated Bot request', async function (this: BotWorld) {
  await click(this, 'Give up waiting');
});

Then('I can read the late Bot reply', async function (this: BotWorld) {
  await click(this, 'Read result');
  await seeRequestResult(this, '遅れて届いた見出し案。');
});

When('I open the Bot workspace move', async function (this: BotWorld) {
  await click(this, 'Bots: assistants with their own settings and notes');
  await click(this, 'Move Bot workspace');
});

When('I choose {string} as the Bot workspace destination', async function (this: BotWorld, runner: string) {
  await click(this, runner);
});

Then('I cannot move the workspace before choosing what to do with its Project', async function (this: BotWorld) {
  const deadline = Date.now() + 10_000;
  do {
    const labels = JSON.parse(await this.app.do({ cmd: 'labels' })) as { label: string; disabled?: boolean }[];
    const start = labels.find(row => row.label === 'Start workspace transfer');
    if (start) {
      assert.equal(start.disabled, true);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.fail('The start transfer control did not appear.');
});

When('I assign the Bot workspace Project to {string}', async function (this: BotWorld, project: string) {
  await click(this, 'Choose a destination for Editorial');
  await click(this, project);
});

When('I confirm the Bot workspace move', async function (this: BotWorld) {
  await click(this, 'Start workspace transfer');
});

When('I cancel the Bot workspace transfer', async function (this: BotWorld) {
  await click(this, 'Cancel workspace transfer');
});

Then(/^I can see that the Bot workspace transfer (is waiting for the destination|was cancelled)$/, async function (this: BotWorld, state: string) {
  const expected = state === 'was cancelled' ? 'Transfer cancelled' : 'Waiting for the destination Runner';
  const deadline = Date.now() + 10_000;
  do {
    const labels = JSON.parse(await this.app.do({ cmd: 'labels' })) as { label: string }[];
    if (labels.some(row => row.label === expected)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.fail(`Could not see the transfer status: ${expected}`);
});

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

type ProfilePage = { key: string; hidden?: boolean; loading?: boolean; hasKeyboard?: boolean };
const profilePages = (dump: unknown) => (dump as { webPanels?: { pages?: ProfilePage[] } }).webPanels?.pages ?? [];

When('I narrow the window beside Highlights', async function (this: BotWorld) {
  await this.app.do({ cmd: 'resize', w: 1180, h: 800 });
});

function profileField(label: string) {
  return `document.querySelector('[aria-label="${label}"]')`;
}

async function profileValue(world: BotWorld, js: string) {
  return (JSON.parse(okValue(await world.app.do({ cmd: 'webPanel', do: 'eval', key: world.profileUrl, js }))) as { value?: unknown }).value;
}

When('I open the original Bot profile editor', async function (this: BotWorld) {
  await click(this, 'Settings');
  await click(this, 'Open profile editor');
  this.profileUrl = await this.until('the original profile page laid out and loaded', dump =>
    profilePages(dump).find(page => page.key.startsWith('http://127.0.0.1:') && page.key.includes('/?lang=') && !page.hidden && page.loading === false)?.key,
  75_000);
});

Then('the original profile cards show the Bot {string}', async function (this: BotWorld, name: string) {
  assert.equal(await profileValue(this, 'document.querySelectorAll(".bt-set-card").length'), 3);
  assert.equal(await profileValue(this, 'getComputedStyle(document.querySelector(".bt-set-card")).borderRadius'), '12px');
  assert.equal(await profileValue(this, profileField('Name') + '.value'), name);
});

Then('the original memory card shows {string}', async function (this: BotWorld, label: string) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const shown = await profileValue(this, 'document.querySelector(".bt-mem-row-go")?.parentElement.querySelector(".bt-bs-label")?.textContent');
    if (shown === label) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.fail('The original memory card did not show ' + label);
});

When('I give the Bot {string} the note {string}', async function (this: BotWorld, name: string, text: string) {
  assert.ok(this.app instanceof GpuiDriver);
  await this.app.withManagedRunner(async client => {
    const { bots } = await client.call<{ bots: { id: string; name: string }[] }>('bots.list', {});
    const bot = bots.find(item => item.name === name);
    assert.ok(bot);
    const scope = { kind: 'bot', id: bot.id };
    const { revision } = await client.call<{ revision: string }>('bots.memory.scope.read', { scope });
    await client.call('bots.memory.scope.add', { scope, expectedRevision: revision, text, operationId: randomUUID() });
  });
});

When('I manage the memory from the original profile', async function (this: BotWorld) {
  okValue(await this.app.do({ cmd: 'webPanel', do: 'click', key: this.profileUrl, selector: '.bt-mem-row-go' }));
});

async function originalAvatarEditor(world: BotWorld) {
  okValue(await world.app.do({ cmd: 'webPanel', do: 'click', key: world.profileUrl, selector: '.bt-avatar-trigger' }));
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await profileValue(world, 'Boolean(document.querySelector(".bt-avedit .bt-shape"))')) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.fail('The original avatar editor did not open');
}

When("I choose the original avatar's Star and Aurora", async function (this: BotWorld) {
  await originalAvatarEditor(this);
  assert.equal(await profileValue(this, 'getComputedStyle(document.querySelector(".bt-avedit")).borderRadius'), '16px');
  assert.equal(await profileValue(this, 'document.querySelector(".bt-shape[aria-label=Star] svg path") !== null'), true);
  await profileValue(this, 'document.querySelector(".bt-shape[aria-label=Star]").click(); document.querySelector(".bt-color[aria-label=Aurora]").click();');
});

async function avatarPersisted(world: BotWorld, name: string, shape?: string, color?: string) {
  assert.ok(world.app instanceof GpuiDriver);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { bots } = await world.app.withManagedRunner(client => client.call<{ bots: { name: string; avatar?: { shape?: string }; color?: string }[] }>('bots.list', {}));
    const bot = bots.find(item => item.name === name);
    if (bot && bot.color === color && (shape ? bot.avatar?.shape === shape : bot.avatar === undefined)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail('The Runner did not save the expected avatar for ' + name);
}

Then('the Bot {string} has the saved Star and Aurora avatar', async function (this: BotWorld, name: string) {
  await avatarPersisted(this, name, 'star', 'aurora');
});

Then('the Bot {string} has its default avatar', async function (this: BotWorld, name: string) {
  await avatarPersisted(this, name);
});

When('I reset the original avatar to its default', async function (this: BotWorld) {
  await originalAvatarEditor(this);
  assert.equal(await profileValue(this, 'document.querySelector(".bt-shape[aria-label=Star]").getAttribute("aria-pressed")'), 'true');
  assert.equal(await profileValue(this, 'document.querySelector(".bt-color[aria-label=Aurora]").getAttribute("aria-pressed")'), 'true');
  okValue(await this.app.do({ cmd: 'webPanel', do: 'click', key: this.profileUrl, selector: '.bt-avedit-reset' }));
});

When('I upload a raster photo using the original Bot editor', async function (this: BotWorld) {
  okValue(await this.app.do({ cmd: 'webPanel', do: 'click', key: this.profileUrl, selector: '.bt-avedit-tab:nth-of-type(2)' }));
  await chooseAvatarFixture(this, '.bt-dropzone input[type=file]', '#006bea');
});

async function chooseAvatarFixture(world: BotWorld, selector: string, color: string) {
  await profileValue(world, `(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    const canvas = document.createElement('canvas');
    canvas.width = 32; canvas.height = 22;
    const brush = canvas.getContext('2d');
    brush.fillStyle = ${JSON.stringify(color)}; brush.fillRect(0, 0, 32, 22);
    canvas.toBlob(blob => {
      const files = new DataTransfer();
      files.items.add(new File([blob], 'photo.png', { type: 'image/png' }));
      input.files = files.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, 'image/png');
  })()`);
}

async function photoInPanel(world: BotWorld, expression: string, expected?: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await profileValue(world, expression);
    if (typeof value === 'string' && (expected === undefined || expected === value)) return value;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.fail('The avatar library did not update the displayed photo');
}

When('I import a different photo into the original avatar library', async function (this: BotWorld) {
  okValue(await this.app.do({ cmd: 'webPanel', do: 'click', key: this.profileUrl, selector: '.bt-avedit-tab:nth-of-type(3)' }));
  const oldPhoto = await photoInPanel(this, 'document.querySelector(".bt-avatar-trigger img")?.src');
  await chooseAvatarFixture(this, '.bt-lib input[type=file]', '#b03de0');
  this.libraryPhoto = await photoInPanel(this, 'document.querySelector(".bt-lib-pick img")?.src');
  assert.notEqual(this.libraryPhoto, oldPhoto);
});

When('I use the imported photo for the Bot', async function (this: BotWorld) {
  okValue(await this.app.do({ cmd: 'webPanel', do: 'click', key: this.profileUrl, selector: '.bt-lib-pick' }));
  assert.ok(this.libraryPhoto);
  await photoInPanel(this, 'document.querySelector(".bt-avatar-trigger img")?.src', this.libraryPhoto);
});

When('I remove the imported photo from the library', async function (this: BotWorld) {
  okValue(await this.app.do({ cmd: 'webPanel', do: 'click', key: this.profileUrl, selector: '.bt-lib-del' }));
  await photoInPanel(this, 'document.querySelector(".bt-lib .bt-note")?.textContent', 'No photos in the library yet.');
});

Then('the Bot {string} still uses the imported photo', async function (this: BotWorld, name: string) {
  assert.ok(this.app instanceof GpuiDriver);
  assert.ok(this.libraryPhoto);
  await photoInPanel(this, 'document.querySelector(".bt-avatar-trigger img")?.src', this.libraryPhoto);
  const { bots } = await this.app.withManagedRunner(client => client.call<{ bots: { name: string; avatar?: { image?: string } }[] }>('bots.list', {}));
  assert.equal(bots.find(bot => bot.name === name)?.avatar?.image, this.libraryPhoto);
});

Then('the original Bot {string} shows its saved photo', async function (this: BotWorld, name: string) {
  assert.ok(this.app instanceof GpuiDriver);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { bots } = await this.app.withManagedRunner(client => client.call<{ bots: { name: string; avatar?: { image?: string } }[] }>('bots.list', {}));
    const image = bots.find(bot => bot.name === name)?.avatar?.image;
    if (image && /^data:image\/(?:webp|png);base64,/.test(image) &&
        await profileValue(this, 'document.querySelector(".bt-avatar-trigger img")?.naturalWidth') === 160) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail('The original avatar crop did not render and save a 160-pixel photo');
});

When('I set the original profile label to {string}', async function (this: BotWorld, label: string) {
  const field = profileField('Label');
  await profileValue(this, field + '.focus();' + field + '.select()');
  await this.app.do({ cmd: 'webPanel', do: 'focus', key: this.profileUrl });
  await this.until('the profile card has the keyboard', dump => profilePages(dump).some(page => page.key === this.profileUrl && page.hasKeyboard));
  await this.app.do({ cmd: 'native-keys', text: label });
  assert.equal(await profileValue(this, field + '.value'), label);
  await profileValue(this, profileField('Name') + '.focus()');
});

Then('the Bot {string} has the label {string}', async function (this: BotWorld, name: string, label: string) {
  assert.ok(this.app instanceof GpuiDriver);
  const driver = this.app;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { bots } = await driver.withManagedRunner(client => client.call<{ bots: { name: string; role: string }[] }>('bots.list', {}));
    if (bots.find(bot => bot.name === name)?.role === label) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`The Runner did not save the expected profile for ${name}`);
});

When('I close the original Bot profile editor', async function (this: BotWorld) {
  await click(this, 'Close profile editor');
});

Then('the old profile view cannot read the Bot', async function (this: BotWorld) {
  assert.ok(this.profileUrl);
  const url = new URL(this.profileUrl);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const reply = await fetch(new URL('/api/profile', url), { headers: { 'X-Threadbear-Profile': url.hash.slice(1) } });
    await reply.body?.cancel();
    if (reply.status === 403) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail('The closed profile was still readable');
});

When('I duplicate the Bot from the menu of {string}', async function (this: BotWorld, name: string) {
  const deadline = Date.now() + 10_000;
  let row: { x: number; y: number } | undefined;
  do {
    const labels = JSON.parse(await this.app.do({ cmd: 'labels' })) as { label: string; x: number; y: number; role?: string; disabled?: boolean }[];
    row = labels.find(label => label.label === name && label.role === 'Button' && !label.disabled);
    if (!row) await new Promise(resolve => setTimeout(resolve, 100));
  } while (!row && Date.now() < deadline);
  assert.ok(row, 'The original Bot is in the sidebar');
  await this.app.do({ cmd: 'click-at', x: row.x, y: row.y, right: true });
  assert.match(await this.app.do({ cmd: 'context-menus' }), /Duplicate/);
  await this.app.do({ cmd: 'click', title: 'Duplicate' });
});

Then('{string} has no conversations or notes', async function (this: BotWorld, name: string) {
  await click(this, name);
  await click(this, 'Memory');
  await click(this, `Bot: ${name}`);
  assert.ok(this.app instanceof GpuiDriver);
  await this.app.withManagedRunner(async client => {
    const { bots } = await client.call<{ bots: { id: string; name: string }[] }>('bots.list', {});
    const bot = bots.find(row => row.name === name);
    assert.ok(bot);
    const { conversations } = await client.call<{ conversations: unknown[] }>('bots.get', { botId: bot.id });
    assert.deepEqual(conversations, []);
    const { notes } = await client.call<{ notes: unknown[] }>('bots.memory.scope.read', { scope: { kind: 'bot', id: bot.id } });
    assert.deepEqual(notes, []);
  });
});

Then('{string} still has the note {string}', async function (this: BotWorld, name: string, note: string) {
  await click(this, name);
  await click(this, 'Memory');
  await click(this, `Bot: ${name}`);
  await seeRequestResult(this, note);
});

Given('a normal Thread called {string} has a saved reply', async function (this: BotWorld, title: string) {
  assert.ok(this.app instanceof GpuiDriver);
  const driver = this.app;
  await driver.withManagedRunner(async client => {
    const { thread } = await client.call<{ thread: { id: string } }>('threads.create', { text: '短い編集会議', title, worktree: false });
    this.attachment = thread.id;
    for (let i = 0; i < 100; i += 1) {
      const reply = await client.call<{ threads: { status: string }[] }>('threads.list', { ids: [thread.id] });
      if (reply.threads[0]?.status === 'idle') {
        const { events } = await client.call<{ events: unknown[] }>('threads.events', { threadId: thread.id });
        assert.ok(JSON.stringify(events).includes('日本語の見出し案。'));
        this.attachmentEvents = events;
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail('The normal Thread did not finish its fixture reply.');
  });
});

When('I choose the existing Thread {string} for the Bot', async function (this: BotWorld, title: string) {
  await click(this, 'Attach existing Thread');
  await click(this, title);
});

Then('the ordinary Thread has no Bot yet', async function (this: BotWorld) {
  assert.ok(this.app instanceof GpuiDriver);
  const { threads } = await this.app.withManagedRunner(client =>
    client.call<{ threads: { botLink?: unknown }[] }>('threads.list', { ids: [this.attachment] }));
  assert.equal(threads[0].botLink, undefined);
});

When('I confirm the Bot attachment', async function (this: BotWorld) {
  await click(this, 'Attach this Thread');
});

Then('I see the existing Thread with its saved reply and new Bot link', async function (this: BotWorld) {
  await this.until('the attached Thread with its original transcript', d => d.selection?.id === this.attachment && d.transcript.state === 'loaded');
  assert.ok(this.app instanceof GpuiDriver);
  await this.app.withManagedRunner(async client => {
    const { threads } = await client.call<{ threads: { botLink?: { botId: string } }[] }>('threads.list', { ids: [this.attachment] });
    assert.ok(threads[0].botLink?.botId);
    const { events } = await client.call<{ events: unknown[] }>('threads.events', { threadId: this.attachment });
    assert.ok(this.attachmentEvents);
    assert.deepEqual(events.slice(0, this.attachmentEvents.length), this.attachmentEvents);
  });
});

async function openBotBackups(world: BotWorld) {
  await click(world, 'Bots: assistants with their own settings and notes');
  await click(world, 'Editorial Bot');
  await click(world, 'Memory');
  await click(world, 'Bot: Editorial Bot');
  await click(world, 'Open note backups');
}

When("I view the backup for the Bot's memory", async function (this: BotWorld) {
  await openBotBackups(this);
  await click(this, '2026-11-27T10:00:00.000Z · 10000000');
});

When('I open the note backups for the Bot', async function (this: BotWorld) {
  await openBotBackups(this);
});

When('I back up the current Bot notes', async function (this: BotWorld) {
  await click(this, 'Back up these notes');
});

Then('I can open the newly created backup', async function (this: BotWorld) {
  await click(this, '2026-11-27T11:00:00.000Z · 20000000');
});

When('I select the backed-up note {string}', async function (this: BotWorld, note: string) {
  await click(this, note);
});

When('I confirm restoration of the selected note', async function (this: BotWorld) {
  await click(this, 'Restore this note');
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
  await seeRequestResult(this, BOT_FIXTURE_REPLY);
});

async function seeRequestResult(world: BotWorld, text: string) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const item = await world.app.do({ cmd: 'a11y', label: text });
      assert.match(item, /^ok /);
      return;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('nothing labelled') || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

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

When('I save {int} Group history posts matching {string}', async function (this: GroupWorld, count: number, keyword: string) {
  assert.ok(this.app instanceof GpuiDriver);
  await this.app.withManagedRunner(async client => {
    const { groups } = await client.call<{ groups: { id: string }[] }>('bots.groups.list', {});
    assert.equal(groups.length, 1);
    const groupId = groups[0].id;
    await client.call('bots.groups.stop', { groupId });
    for (let i = 0; i < count; i += 1) {
      await client.call('bots.groups.post', { groupId, text: `${keyword} item ${i}`, operationId: `history-${i}` });
    }
  });
});

When('I search Group history for {string}', async function (this: GroupWorld, keyword: string) {
  await click(this, 'Search Group history');
  await this.app.do({ cmd: 'type', here: true, text: keyword });
  await click(this, 'Search history');
});

Then('the Group history offers older results', async function (this: GroupWorld) {
  const deadline = Date.now() + 10_000;
  do {
    const labels = JSON.parse(await this.app.do({ cmd: 'labels' })) as { label: string; disabled?: boolean }[];
    if (labels.some(row => row.label === 'Older results' && !row.disabled)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.fail('The Group search did not offer an older page.');
});

When('I open the older Group search results', async function (this: GroupWorld) {
  await click(this, 'Older results');
});

Then('the Group search shows {string}', async function (this: GroupWorld, line: string) {
  // The older row is below the first twenty, so scroll the Group pane there.
  const deadline = Date.now() + 10_000;
  do {
    const labels = JSON.parse(await this.app.do({ cmd: 'labels' })) as { label: string }[];
    if (labels.some(row => row.label === line)) return;
    await this.app.do({ cmd: 'point', x: 620, y: 665, scrollY: -500 });
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.fail(`The Group search did not show "${line}".`);
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

When('I schedule a new Bot conversation saying {string}', async function (this: BotWorld, body: string) {
  await click(this, 'Schedule a new conversation');
  await this.app.do({ cmd: 'type', here: true, text: body });
  await click(this, 'Save the schedule (Return)');
});

When('I run the saved Bot schedule now', async function (this: BotWorld) {
  assert.ok(this.app instanceof GpuiDriver);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const labels = JSON.parse(await this.app.do({ cmd: 'labels' })) as { label: string }[];
    const editorOpen = labels.some(item => item.label === 'Save the schedule (Return)');
    if (!editorOpen) {
      const saved = await this.app.withManagedRunner(client =>
        client.call<{ schedules: unknown[] }>('bots.schedules.list', {}));
      if (saved.schedules.length) {
        await click(this, 'Bot schedules');
        await click(this, 'Run now');
        return;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail('The Bot schedule editor did not finish saving.');
});

Then('the scheduled message ran in a new conversation with {string}', async function (this: BotWorld, name: string) {
  assert.ok(this.app instanceof GpuiDriver);
  await this.app.withManagedRunner(async client => {
    const { bots } = await client.call<{ bots: { id: string; name: string }[] }>('bots.list', {});
    const bot = bots.find(row => row.name === name);
    assert.ok(bot);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const { schedules } = await client.call<{ schedules: {
        botTarget: { kind: string; botId: string };
        lastRun?: { outcome: string; threadId?: string; botSettingsRevision?: number };
      }[] }>('bots.schedules.list', {});
      const row = schedules[0];
      if (row?.lastRun?.outcome === 'sent') {
        assert.deepEqual(row.botTarget, { kind: 'newConversation', botId: bot.id });
        const { conversations } = await client.call<{ conversations: { threadId: string }[] }>('bots.get', { botId: bot.id });
        assert.deepEqual(conversations.map(row => row.threadId), [row.lastRun.threadId]);
        assert.equal(row.lastRun.botSettingsRevision, 1);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail('The saved Bot schedule did not start its conversation.');
  });
});
