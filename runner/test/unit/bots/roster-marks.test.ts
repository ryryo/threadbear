import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rosterMark } from '../../../src/bots/roster-mark.mjs';

test('the roster renders the original mask, light and dark inks, and Aurora gradient', () => {
  const ink = rosterMark({ id: 'bot-id', color: 'blue', avatar: { shape: 'star' } });
  assert.match(ink.light, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg".*<mask id="bot-mark"/);
  assert.match(ink.light, /fill="#2563EB"/);
  assert.match(ink.dark!, /fill="#3B82F6"/);
  const aurora = rosterMark({ id: 'bot-id', color: 'aurora', avatar: { shape: 'star' } });
  assert.match(aurora.light, /<linearGradient id="bot-markg".*#A4FFB0.*#2E9EF7/);
  assert.equal(aurora.dark, undefined);
  assert.doesNotMatch(ink.light + ink.dark + aurora.light, /var\(|%MASK%/);
  assert.deepEqual(rosterMark({ id: 'bot-id' }), rosterMark({ id: 'bot-id', avatar: { shape: 'unknown' } }));
});
