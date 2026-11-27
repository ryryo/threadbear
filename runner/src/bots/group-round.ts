// Port of DS-Bot groups.js callIn/startable at d104d9ca18d69a35460f14e15dff4d553181433a.
// Copyright 2026 Fei2411 and the DS Bot contributors. Apache-2.0 (see ported/NOTICE).
import { randomUUID } from 'node:crypto';

export type GroupCall = {
  id: string;
  callId: string;
  name: string;
  status: 'waiting' | 'speaking' | 'done' | 'failed' | 'stopped';
  note?: string;
  by?: string;
  batch?: number;
  batchKey?: string;
  ordered?: boolean;
  summary?: boolean;
  threadId?: string;
  turnId?: string;
};

export type GroupRound = {
  id: string;
  roomId: string;
  sourceSeq: number;
  status: 'running' | 'finalizing' | 'done' | 'stopped';
  batches: number;
  slots: GroupCall[];
};

export function callIn(
  round: GroupRound, callees: readonly { id: string; name: string }[], note: string, by?: string,
  { ordered = false, batchKey, summary = false }: { ordered?: boolean; batchKey?: string; summary?: boolean } = {},
): void {
  if (callees.length === 0) return
  round.batches = (round.batches ?? 0) + 1
  let last: GroupCall | undefined
  for (const peer of callees) {
    const waiting = round.slots.findIndex(slot => slot.id === peer.id && slot.status === 'waiting' && (by === undefined || slot.by === undefined || slot.by === by)
      && (slot.batchKey === undefined || slot.batchKey === batchKey))
    const moves = waiting === -1 || (ordered && round.slots[waiting].ordered === true)
    const slot: GroupCall = waiting === -1
      ? { id: peer.id, name: peer.name, status: 'waiting', callId: randomUUID() } : round.slots[waiting]
    if (moves && waiting !== -1) round.slots.splice(waiting, 1)
    slot.note = note
    if (summary) slot.summary = true
    slot.batch = round.batches
    if (batchKey !== undefined) slot.batchKey = batchKey
    if (by === undefined) delete slot.by
    else slot.by = by
    if (!moves) slot.ordered = false
    else if (!ordered) round.slots.push(slot)
    else {
      slot.ordered = true
      const queue = round.slots.findIndex(other => other.ordered && other.status === 'waiting')
      round.slots.splice(last ? round.slots.indexOf(last) + 1 : queue === -1 ? round.slots.length : queue, 0, slot)
      last = slot
    }
  }
}

// Whether a waiting call can start now: its member answers nothing else in this
// round, and an ordered call waits for the ordered calls before it.
export const startable = (round: GroupRound, slot: GroupCall): boolean => {
  if (round.status !== 'running' && round.status !== 'finalizing') return false
  if (slot.status !== 'waiting' || round.slots.some(other => other.id === slot.id && other.status === 'speaking')) return false
  if (!slot.ordered) return true
  const at = round.slots.indexOf(slot)
  return round.slots.every((other, index) => !other.ordered || other === slot || (other.status !== 'speaking' && !(other.status === 'waiting' && index < at)))
}
