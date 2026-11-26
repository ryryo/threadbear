import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setChief } from '../../../src/bots/chief-rules.ts';

const chief = { id: 'chief', name: 'Chief' };
const writer = { id: 'writer', name: 'Writer' };
const reader = { id: 'reader', name: 'Reader' };

// Adapted from DS-Bot's roster.test.js at d104d9ca, L439–480.
// Original assertions keep replacement atomic, preserve order, and protect the last Chief.
test('another Bot takes the Chief place in one step', () => {
  const chiefBotIds = [chief.id];
  const next = setChief(chiefBotIds, writer, true, { replace: chief.id });
  assert.deepEqual(next, [writer.id]);
  assert.equal(next[0], writer.id);
  assert.deepEqual(chiefBotIds, [chief.id]);
});

test('a Chief moves to the front and the others keep their order', () => {
  let chiefBotIds = [chief.id];
  chiefBotIds = setChief(chiefBotIds, writer, true);
  assert.deepEqual(chiefBotIds, [chief.id, writer.id]);
  chiefBotIds = setChief(chiefBotIds, writer, true, { primary: true });
  assert.deepEqual(chiefBotIds, [writer.id, chief.id]);
  chiefBotIds = setChief(chiefBotIds, reader, true);
  assert.deepEqual(chiefBotIds, [writer.id, chief.id, reader.id]);
  chiefBotIds = setChief(chiefBotIds, reader, true, { replace: chief.id });
  assert.deepEqual(chiefBotIds, [writer.id, reader.id]);
  chiefBotIds = setChief(chiefBotIds, writer, false);
  assert.deepEqual(chiefBotIds, [reader.id]);
});

test('setChief keeps one Chief and replaces only a Chief', () => {
  const chiefBotIds = [chief.id];
  assert.throws(() => setChief(chiefBotIds, chief, false), /at least one Chief/);
  assert.throws(() => setChief(chiefBotIds, writer, true, { replace: reader.id }), /Only a Chief/);
  assert.throws(() => setChief(chiefBotIds, undefined, true), /Unknown Bot/);
  assert.throws(() => setChief(chiefBotIds, { ...reader, private: true }, true), /private/);
  assert.deepEqual(setChief(chiefBotIds, reader, false), [chief.id]);
});
