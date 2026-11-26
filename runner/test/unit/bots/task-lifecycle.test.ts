import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reconcileActiveTask, stopTask, type TaskEvidence } from '../../../src/bots/task-lifecycle.ts';

// The original reconcileTasksAfterRestart cases, with approvals and handover
// represented by Threadbear's own Thread evidence.
test('a restart interrupts only an orphaned task and preserves a task with unsatisfied children', () => {
  const nothing: TaskEvidence = { kept: false, activeTurn: false, switching: false, runningJobs: false, queuedInput: false, approval: false, children: false };
  for (const field of ['kept', 'activeTurn', 'switching', 'runningJobs', 'queuedInput', 'approval'] as const) {
    assert.equal(reconcileActiveTask({ ...nothing, [field]: true }), 'active', field);
  }
  assert.equal(reconcileActiveTask({ ...nothing, children: true }), 'waiting_work');
  assert.equal(reconcileActiveTask(nothing), 'interrupted');
});

test('stopTask still stops execution when its terminal record cannot be saved', async () => {
  const visited: string[] = [];
  await assert.rejects(stopTask(true, async () => {
    visited.push('save');
    throw new Error('disk full');
  }, async () => {
    visited.push('cancel execution and outstanding work');
  }), /disk full/);
  assert.deepEqual(visited, ['save', 'cancel execution and outstanding work']);
});
