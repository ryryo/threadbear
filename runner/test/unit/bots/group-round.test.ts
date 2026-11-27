import assert from 'node:assert/strict';
import { test } from 'node:test';
import { callIn, startable, type GroupRound } from '../../../src/bots/group-round.ts';

const candidate = (id: string) => ({ id, name: id });
const round = (): GroupRound => ({ id: 'round', roomId: 'room', sourceSeq: 1, status: 'running', batches: 0, slots: [] });

test('ordered calls wait for the earlier speaker and mentions can run together', () => {
  const group = round();
  callIn(group, ['admin', 'writer', 'tester'].map(candidate), 'Check the heading', undefined, { ordered: true });
  assert.deepEqual(group.slots.filter(slot => startable(group, slot)).map(slot => slot.id), ['admin']);
  group.slots[0].status = 'speaking';
  assert.equal(group.slots.some(slot => startable(group, slot)), false);
  callIn(group, ['translator', 'proofreader'].map(candidate), 'Parallel review');
  assert.deepEqual(group.slots.filter(slot => startable(group, slot)).map(slot => slot.id), ['translator', 'proofreader']);
  group.slots[0].status = 'done';
  assert.ok(startable(group, group.slots[1]));
});

test('a member cannot run two calls together and a stopped round has no admissions', () => {
  const group = round();
  callIn(group, [candidate('writer')], 'First request');
  const first = group.slots[0];
  first.status = 'speaking';
  callIn(group, [candidate('writer')], 'New request', 'tester', { batchKey: 'batch' });
  const next = group.slots[1];
  assert.notEqual(next.callId, first.callId);
  assert.equal(next.batchKey, 'batch');
  assert.equal(startable(group, next), false);
  first.status = 'done';
  assert.equal(startable(group, next), true);
  group.status = 'stopped';
  assert.equal(startable(group, next), false);
});

test('a parallel mention can take a waiting ordered slot without changing its admission ID', () => {
  const group = round();
  callIn(group, [candidate('writer'), candidate('tester')], 'Ordered', undefined, { ordered: true });
  const saved = group.slots[1].callId;
  callIn(group, [candidate('tester')], 'Explicit mention');
  assert.equal(group.slots.length, 2);
  assert.equal(group.slots[1].callId, saved);
  assert.equal(group.slots[1].note, 'Explicit mention');
  assert.equal(startable(group, group.slots[1]), true);
});
