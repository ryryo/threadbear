import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { ReviewCheckpoints, type ReviewEvidence } from '../../../src/bots/review-checkpoints.ts';

function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'tb-review-checkpoints-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const conversationId = randomUUID();
  const evidence: ReviewEvidence = {
    purpose: 'bot-memory-review', botId: randomUUID(), configRevision: 4, scopeRevision: 'notes-v1',
    conversationId, threadId: randomUUID(), provider: 'claude', model: 'fixture-model', accountId: 'fixture-account',
    first: 20, through: 22,
  };
  return { home, conversationId, evidence };
}

test('the source, candidates and cursor survive restart in the same checkpoint', t => {
  const { home, conversationId, evidence } = fixture(t);
  const storage = new ReviewCheckpoints(home);
  const saved = storage.record(evidence, 0, { rejected: 1, changes: [{ op: 'add', text: '日本語で見出しを短くする' }] });
  const reopened = new ReviewCheckpoints(home);
  assert.equal(reopened.cursor(conversationId), 22);
  assert.deepEqual(reopened.reports(conversationId), [saved]);
  assert.deepEqual(saved?.source, evidence);
  assert.deepEqual(saved?.changes[0], { op: 'add', text: '日本語で見出しを短くする', decision: 'pending' });
  assert.throws(() => reopened.record(evidence, 0, { rejected: 0, changes: [] }), /checkpoint changed/);
});

test('a failed save never advances a review, and a diagnostic keeps only safe fields', t => {
  const { home, conversationId, evidence } = fixture(t);
  const storage = new ReviewCheckpoints(home, () => { throw new Error('fixture write failure'); });
  assert.throws(() => storage.record(evidence, 0, { rejected: 1, changes: [], diagnostic: 'invalid-reply' }), /fixture write failure/);
  assert.equal(storage.cursor(conversationId), 0);
  const reopened = new ReviewCheckpoints(home);
  reopened.record(evidence, 0, {
    rejected: 0, changes: [], diagnostic: 'invalid-reply',
    ...{ raw: 'fixture that must never be stored' },
  });
  assert.doesNotMatch(readFileSync(join(home, `${conversationId}.json`), 'utf8'), /fixture that must never be stored/);
  assert.equal(reopened.cursor(conversationId), 22);
});

test('a retried decision cannot overwrite an earlier, different one', t => {
  const { home, conversationId, evidence } = fixture(t);
  const storage = new ReviewCheckpoints(home);
  const saved = storage.record(evidence, 0, { rejected: 0, changes: [{ op: 'add', text: 'Keep this' }] })!;
  const op = randomUUID();
  storage.reject(conversationId, saved.id, 0, op);
  storage.reject(conversationId, saved.id, 0, op);
  assert.throws(() => storage.reject(conversationId, saved.id, 0, randomUUID()), /already decided/);
  assert.deepEqual(new ReviewCheckpoints(home).reports(conversationId)[0].changes[0], { op: 'add', text: 'Keep this', decision: 'rejected', operationId: op });
});
