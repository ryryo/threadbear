import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parentScope, type RequestNode } from '../../src/bots/request-graph.ts';

const root: RequestNode = { id: 'root', rootRequestId: 'root', sourceBotId: 'chief', targetBotId: 'editor' };
const next: RequestNode = { id: 'next', rootRequestId: 'root', sourceBotId: 'editor', targetBotId: 'writer', parentRequestId: 'root' };
const more: RequestNode = { id: 'more', rootRequestId: 'root', sourceBotId: 'writer', targetBotId: 'reader', parentRequestId: 'next' };

test('new work cannot loop to its caller or ancestor, or claim another Bot’s parent', () => {
  const rows = new Map([root, next, more].map(row => [row.id, row]));
  assert.throws(() => parentScope({ sourceBotId: 'writer', targetBotId: 'chief', parentRequestId: 'next' }, rows, 'bad'), /ancestor/);
  assert.throws(() => parentScope({ sourceBotId: 'writer', targetBotId: 'writer' }, rows, 'bad'), /itself/);
  assert.throws(() => parentScope({ sourceBotId: 'visitor', targetBotId: 'new', parentRequestId: 'next' }, rows, 'bad'), /another Bot/);
  assert.deepEqual(parentScope({ sourceBotId: 'reader', targetBotId: 'reviewer', parentRequestId: 'more' }, rows, 'leaf'), { depth: 4, rootRequestId: 'root' });
  rows.set('leaf', { id: 'leaf', rootRequestId: 'root', sourceBotId: 'reader', targetBotId: 'reviewer', parentRequestId: 'more' });
  assert.throws(() => parentScope({ sourceBotId: 'reviewer', targetBotId: 'owner-bot', parentRequestId: 'leaf' }, rows, 'bad'), /depth limit/);
});

test('settled children remain charged to their root budget', () => {
  const rows = new Map([[root.id, root]]);
  for (let i = 0; i < 32; i++) {
    const id = `child-${i}`;
    rows.set(id, { id, rootRequestId: root.id, sourceBotId: 'editor', targetBotId: 'helper', parentRequestId: root.id });
  }
  assert.throws(() => parentScope({ sourceBotId: 'editor', targetBotId: 'other', parentRequestId: 'root' }, rows, 'next'), /child limit/);
});
