import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chiefGrant, type TeamAuthority } from '../../../src/bots/chief-policy.ts';

const chief = { id: 'chief', name: 'Chief' };
const writer = { id: 'writer', name: 'Writer' };
const authority: TeamAuthority = { chiefEnabled: true, chiefIds: [chief.id], revision: 2, grantByChief: {} };

test('ordinary Bot and Chief without a grant cannot manage another Bot', () => {
  assert.throws(() => chiefGrant(authority, writer, 'updateOtherBot', 2), /Only a Chief/);
  assert.throws(() => chiefGrant(authority, chief, 'updateOtherBot', 2), /has not allowed/);
});

test('one management grant does not authorize a different operation or a stale revision', () => {
  const granted = { ...authority, grantByChief: { chief: { updateOtherBot: { botIds: [writer.id], fields: ['role' as const] } } } };
  assert.deepEqual(chiefGrant(granted, chief, 'updateOtherBot', 2), { botIds: [writer.id], fields: ['role'] });
  assert.throws(() => chiefGrant(granted, chief, 'stopOtherBot', 2), /has not allowed/);
  assert.throws(() => chiefGrant(granted, chief, 'updateOtherBot', 1), /changed/);
  assert.throws(() => chiefGrant({ ...granted, chiefEnabled: false }, chief, 'updateOtherBot', 2), /Only a Chief/);
});
