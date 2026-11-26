import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canUseMemory, type MemoryActor, type MemoryScope } from '../../../src/bots/memory-policy.ts';

const writer = { kind: 'bot', id: 'writer', teamId: 'editorial', groupId: 'launch', projectId: 'docs', private: false, grants: [] } satisfies MemoryActor;
const coder = { ...writer, id: 'coder', teamId: 'engineering' };
const diary = { ...writer, id: 'diary', private: true };
const team: MemoryScope = { kind: 'team', id: 'editorial' };
const group: MemoryScope = { kind: 'group', id: 'launch', memberIds: ['writer', 'coder'] };
const project: MemoryScope = { kind: 'project', id: 'docs' };
const own: MemoryScope = { kind: 'bot', id: 'writer', teamId: 'editorial', private: false };
const hidden: MemoryScope = { kind: 'bot', id: 'diary', teamId: 'editorial', private: true };

test('own Bot memory stays writable and Private memory stays closed to peers', () => {
  assert.equal(canUseMemory(writer, own, 'write'), true);
  assert.equal(canUseMemory(writer, hidden, 'read'), false);
  assert.equal(canUseMemory(diary, hidden, 'write'), true);
  assert.equal(canUseMemory(coder, own, 'read', true), false);
  const sameTeam = { ...writer, id: 'reader' };
  assert.equal(canUseMemory(sameTeam, own, 'read'), false, 'the default prompt does not recall a peer’s notes');
  assert.equal(canUseMemory(sameTeam, own, 'read', true), true);
});

test('other teams cannot read or write a team’s notes', () => {
  assert.equal(canUseMemory(writer, team, 'read'), true);
  assert.equal(canUseMemory(writer, team, 'write'), false);
  assert.equal(canUseMemory(coder, team, 'read'), false);
  assert.equal(canUseMemory(coder, team, 'write'), false);
  assert.equal(canUseMemory(diary, team, 'read'), true);
});

test('a group requires current membership and its own conversation', () => {
  assert.equal(canUseMemory(writer, group, 'write'), true);
  assert.equal(canUseMemory({ ...writer, groupId: undefined }, group, 'read'), false);
  assert.equal(canUseMemory({ ...writer, id: 'departed' }, group, 'read'), false);
  assert.equal(canUseMemory(diary, group, 'read'), false);
});

test('a project needs its explicit conversation binding and a grant for that project', () => {
  const readDocs = { kind: 'project', id: 'docs', write: false } as const;
  assert.equal(canUseMemory(writer, project, 'read'), false);
  assert.equal(canUseMemory({ ...writer, grants: [readDocs] }, project, 'read'), true);
  assert.equal(canUseMemory({ ...writer, projectId: undefined, grants: [readDocs] }, project, 'read'), false);
  assert.equal(canUseMemory({ ...writer, grants: [readDocs] }, project, 'write'), false);
});

test('the owner can maintain every scope and a Bot cannot turn a read grant into a write', () => {
  for (const scope of [team, group, project, hidden]) {
    assert.equal(canUseMemory({ kind: 'owner' }, scope, 'write'), true);
  }
  assert.equal(canUseMemory({ ...writer, grants: [{ kind: 'team', id: 'editorial', write: false }] }, team, 'write'), false);
  assert.equal(canUseMemory({ ...writer, grants: [{ kind: 'team', id: 'editorial', write: true }] }, team, 'write'), true);
  assert.equal(canUseMemory({ ...coder, grants: [{ kind: 'team', id: 'editorial', write: true }] }, team, 'write'), false);
  assert.equal(canUseMemory({ ...writer, grants: [{ kind: 'bot', id: 'diary', write: true }] }, hidden, 'write', true), false);
});
