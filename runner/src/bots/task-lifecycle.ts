// Adapted from Fei-Craft/DS-Bot d104d9ca18d69a35460f14e15dff4d553181433a,
// ds-bot/src/host/bot-tasks.js, stopTask and reconcileTasksAfterRestart.
// Copyright 2026 Fei2411 and the DS Bot contributors. Apache-2.0.
export type TaskEvidence = {
  kept: boolean;
  activeTurn: boolean;
  switching: boolean;
  runningJobs: boolean;
  queuedInput: boolean;
  approval: boolean;
  children: boolean;
};

// Preserve work whenever something still owns it. The Runner supplies the
// actual Thread and journal evidence after recovering or adopting that Thread.
export function reconcileActiveTask(evidence: TaskEvidence): 'active' | 'waiting_work' | 'interrupted' {
  if (evidence.kept || evidence.activeTurn || evidence.switching || evidence.runningJobs ||
      evidence.queuedInput || evidence.approval) return 'active';
  if (evidence.children) return 'waiting_work';
  return 'interrupted';
}

// Save first so the subsequent turn-end cannot replace the owner's stop with
// completion. Always dispatch the Runner's cancellation path, even if the
// journal cannot be saved or the transaction cannot confirm its delivery.
export async function stopTask(wasActive: boolean, settleStopped: () => Promise<void>, stopExecution: () => Promise<void>): Promise<boolean> {
  try {
    if (wasActive) await settleStopped();
  } finally {
    await stopExecution();
  }
  return wasActive;
}
