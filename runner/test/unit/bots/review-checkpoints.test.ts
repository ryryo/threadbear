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

test('recovery erases the approved proposal and pending edits to the same note without renumbering other proposals', t => {
  const { home, conversationId, evidence } = fixture(t);
  const storage = new ReviewCheckpoints(home);
  const selected = '合成覚書。玄関の目印は青い箱。';
  const report = storage.record(evidence, 0, { rejected: 0, changes: [
    { op: 'add', text: selected },
    { op: 'edit', id: 'selected-note', before: selected, text: '合成の編集案。' },
    { op: 'add', text: '残す別の提案。' },
  ] });
  const receipt = { ...evidence, reportId: report.id, index: 0, operationId: randomUUID(), acceptedText: selected };
  storage.reconcile(conversationId, [receipt]);
  (new ReviewCheckpoints(home)).reconcile(conversationId, [{ ...receipt, acceptedText: undefined, erased: true }], new Set(['selected-note']));
  const reopened = new ReviewCheckpoints(home);
  const [updated] = reopened.reports(conversationId);
  assert.deepEqual(updated.changes, [
    { op: 'erased', decision: 'erased', operationId: receipt.operationId },
    { op: 'erased', decision: 'erased' },
    { op: 'add', text: '残す別の提案。', decision: 'pending' },
  ]);
  reopened.reconcile(conversationId, [receipt]);
  assert.doesNotMatch(readFileSync(join(home, `${conversationId}.json`), 'utf8'), /青い箱|合成の編集案/);
  assert.equal(reopened.cursor(conversationId), evidence.through);
  assert.throws(() => reopened.retry(evidence, { rejected: 0, changes: [] }, report.id, randomUUID()), /permanently erased/);
});
