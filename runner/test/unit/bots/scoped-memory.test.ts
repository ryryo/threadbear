import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import { BotRepository } from '../../../src/bots/repository.ts';
import { ScopedMemory } from '../../../src/bots/scoped-memory.ts';
import { Projects } from '../../../src/projects.ts';
import { FakeClock } from '../../../src/clock.ts';
import { nullLogger } from '../../../src/log.ts';
import { makeHarness, tmpDir } from '../../helpers/fakes.ts';

const time = '2026-11-27T00:00:00.000Z';
const owner = { kind: 'owner' } as const;

test('a linked Bot, team, group and project use separate journals and current access', () => {
  const home = tmpDir();
  const root = join(home, 'bots');
  const projects = new Projects({ home, clock: new FakeClock(), log: nullLogger });
  const h = makeHarness(home, {}, { projects });
  projects.start(h.runner);
  const project = projects.create({ title: 'Handbook', by: 'mike' });
  const repo = new BotRepository(root, 'fixture');
  const bot = repo.create({ name: 'Writer' });
  const allow = { kind: 'bot', id: bot.id, private: false, teamId: repo.workspaceId(), groupId: 'room', projectId: project.id, grants: [
    { kind: 'project', id: project.id, write: true },
  ] } as const;
  let members = [bot.id];
  const mem = new ScopedMemory({ root, repo, projects, group: id => id === 'room' ? { name: 'Room', memberIds: members } : undefined });
  const own = { kind: 'bot', id: bot.id } as const;
  const team = { kind: 'team', id: repo.workspaceId() } as const;
  const docs = { kind: 'project', id: project.id } as const;
  const room = { kind: 'group', id: 'room' } as const;
  mem.open(own, allow, 'write').add('Only for Writer', {}, time);
  mem.open(team, owner, 'write').add('Only for the workspace team', {}, time);
  mem.open(docs, allow, 'write').add('Only for Handbook', {}, time);
  mem.open(room, allow, 'write').add('Only for the group', {}, time);
  for (const [scope, text] of [[own, 'Writer'], [team, 'the workspace team'], [docs, 'Handbook'], [room, 'the group']] as const) {
    assert.deepEqual(mem.open(scope, allow, 'read').list('2026-11-27').map(note => note.text), [`Only for ${text}`]);
  }
  assert.throws(() => mem.open(team, allow, 'write'), /cannot use/);
  assert.throws(() => mem.open(docs, { ...allow, projectId: undefined }, 'read'), /cannot use/);
  members = [];
  assert.throws(() => mem.open(room, allow, 'read'), /cannot use/);
  assert.throws(() => mem.open({ kind: 'project', id: '../../outside' }, owner, 'read'), /Invalid memory scope/);
});

test('scope edits are idempotent, and restore rechecks secrets learned since the original change', () => {
  const root = tmpDir();
  const repo = new BotRepository(root, 'fixture');
  const team = { kind: 'team', id: repo.workspaceId() } as const;
  const mem = new ScopedMemory({ root, repo });
  const scope = mem.open(team, owner, 'write');
  const operation = randomUUID();
  const mutation = { op: 'add', text: 'fixture-sensitive-value' } as const;
  const first = scope.change(mutation, operation, 'empty', time);
  assert.deepEqual(scope.change(mutation, operation, 'empty', time), first);
  assert.throws(() => scope.change({ op: 'add', text: 'Other' }, operation, 'empty', time), /different change/);
  assert.throws(() => scope.change({ op: 'add', text: 'Other' }, randomUUID(), 'empty', time), /notes changed/);
  const removed = scope.change({ op: 'remove', entryId: first.note!.id }, randomUUID(), first.revision, time);
  const reopened = new ScopedMemory({ root, repo, redact: text => text.replaceAll('fixture-sensitive-value', '[redacted]') }).open(team, owner, 'write');
  assert.throws(() => reopened.change({ op: 'restore', changeId: removed.revision }, randomUUID(), removed.revision, time), /secret/);
  assert.equal(reopened.revision(), removed.revision);
  assert.deepEqual(reopened.list('2026-11-27'), []);
});

test('only the owner can erase a note, including from an archived Bot, after checking the writer', () => {
  const root = tmpDir();
  const repo = new BotRepository(root, 'fixture');
  const bot = repo.create({ name: 'Writer' });
  const own = { kind: 'bot', id: bot.id } as const;
  const team = { kind: 'team', id: repo.workspaceId() } as const;
  let guarded = false;
  const memory = new ScopedMemory({ root, repo, protectErasure: () => {
    if (!guarded) throw new Error('No compatible supervisor');
  } });
  const ownMemory = memory.open(own, owner, 'write');
  const teamMemory = memory.open(team, owner, 'write');
  const text = '合成テスト用。会話には入れない覚書。';
  const note = ownMemory.add(text, {}, time);
  teamMemory.add(text, {}, time);
  const config = { entryId: note.id, operationId: randomUUID(), expectedRevision: ownMemory.revision(), time };
  const botActor = { kind: 'bot', id: bot.id, private: false, grants: [] } as const;
  assert.throws(() => memory.erase(own, botActor, config), /Only the owner/);
  assert.throws(() => new ScopedMemory({ root, repo }).erase(own, owner, config), /unavailable/);
  repo.archive(bot.id, bot.revision, time);
  assert.throws(() => memory.open(own, owner, 'write'), /cannot use/);
  assert.throws(() => memory.erase(own, owner, config), /No compatible supervisor/);
  assert.equal(ownMemory.revision(), config.expectedRevision);
  assert.equal(ownMemory.list('2026-11-27')[0].text, text);
  guarded = true;
  const result = memory.erase(own, owner, config);
  assert.deepEqual(memory.erase(own, owner, config), result);
  assert.deepEqual(ownMemory.list('2026-11-27'), []);
  assert.equal(teamMemory.list('2026-11-27')[0].text, text);
});
