// A linked request owns its delivery and result lifecycle. ThreadStore still
// owns the input queue, turns and full answer. Persist each state before
// exposing it to another caller or trying the next delivery.
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../fsutil.ts';
import { isPermissionMode, type PermissionMode } from '../protocol.ts';
import type { KeptResult } from './handoff-result.ts';
import { ROOT_CHILDREN, parentScope, type RequestNode } from './request-graph.ts';

export type RequestResult = { turnId: string; result: KeptResult; replyId: string; failed?: boolean };
type RequestState =
  | { status: 'admitted' }
  | { status: 'queued' | 'running'; turnId: string }
  | ({ status: 'returning' | 'returned' } & RequestResult)
  | { status: 'uncertain'; reason: string; reply?: RequestResult }
  | { status: 'failed' | 'cancelled'; reason: string };
export type RequestRow = RequestNode & {
  revision: number;
  rerunOf?: string;
  sourceThreadId: string;
  sourceConversationId: string;
  targetThreadId: string;
  targetConversationId: string;
  acceptedAt: string;
  sourcePrivateBotId?: string;
  targetPrivateBotId?: string;
  ceiling?: PermissionMode;
  returnCeiling?: PermissionMode;
  when: 'queue' | 'now';
  state: RequestState;
};
type Admission = Omit<RequestRow, 'rootRequestId' | 'revision' | 'state'>;

const transitions: Record<RequestState['status'], ReadonlySet<RequestState['status']>> = {
  admitted: new Set(['queued', 'running', 'uncertain', 'failed', 'cancelled']),
  queued: new Set(['running', 'returning', 'failed', 'uncertain', 'cancelled']),
  running: new Set(['returning', 'failed', 'uncertain', 'cancelled']),
  returning: new Set(['returned', 'uncertain', 'cancelled']),
  returned: new Set(),
  failed: new Set(),
  uncertain: new Set(['queued', 'running', 'returned', 'cancelled']),
  cancelled: new Set(),
};

const key = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128 && !value.includes('\u0000');

function validResult(row: RequestRow, reply: RequestResult): boolean {
  const { result, replyId, turnId, failed } = reply;
  return replyId === `bot-reply:${row.id}` && key(turnId) && (failed === undefined || typeof failed === 'boolean') &&
    result?.source?.threadId === row.targetThreadId && Number.isSafeInteger(result.source.seq) && result.source.seq > 0 &&
    typeof result.text === 'string' && result.text.length <= 2_000 &&
    (result.length === undefined ? result.hash === undefined :
      Number.isSafeInteger(result.length) && result.length > 2_000 && typeof result.hash === 'string' && /^[0-9a-f]{64}$/.test(result.hash));
}

function validState(row: RequestRow): boolean {
  const { state } = row;
  if (!state || !Object.hasOwn(transitions, state.status)) return false;
  switch (state.status) {
    case 'admitted': return true;
    case 'queued':
    case 'running': return key(state.turnId);
    case 'failed':
    case 'cancelled': return typeof state.reason === 'string' && state.reason.length > 0 && state.reason.length <= 1_000;
    case 'uncertain':
      return typeof state.reason === 'string' && state.reason.length > 0 && state.reason.length <= 1_000 &&
        (state.reply === undefined || validResult(row, state.reply));
    case 'returning':
    case 'returned': return validResult(row, state);
  }
}

function validRow(row: RequestRow): boolean {
  return !!row && key(row.id) && Number.isSafeInteger(row.revision) && row.revision > 0 &&
    [row.rootRequestId, row.targetBotId, row.targetThreadId, row.targetConversationId, row.sourceThreadId, row.sourceConversationId].every(key) &&
    (row.sourceBotId === undefined || key(row.sourceBotId)) && (row.parentRequestId === undefined || key(row.parentRequestId)) &&
    (row.rerunOf === undefined || key(row.rerunOf)) &&
    (row.sourcePrivateBotId === undefined || key(row.sourcePrivateBotId)) &&
    (row.targetPrivateBotId === undefined || key(row.targetPrivateBotId)) &&
    (row.ceiling === undefined || isPermissionMode(row.ceiling)) &&
    (row.returnCeiling === undefined || isPermissionMode(row.returnCeiling)) &&
    typeof row.acceptedAt === 'string' && Number.isFinite(Date.parse(row.acceptedAt)) && (row.when === 'queue' || row.when === 'now') && validState(row);
}

function load(file: string): Map<string, RequestRow> {
  let input: unknown;
  try {
    if (!lstatSync(file).isFile()) throw new Error('The Bot requests store must be a regular file');
    input = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw error;
  }
  if (!Array.isArray(input)) throw new Error('Invalid Bot requests store');
  const rows = new Map<string, RequestRow>();
  for (const row of input as RequestRow[]) {
    if (!validRow(row) || rows.has(row.id)) {
      throw new Error('Invalid Bot request row');
    }
    rows.set(row.id, row);
  }
  const counts = new Map<string, number>();
  for (const row of rows.values()) {
    if (parentScope(row, rows, row.id, false).rootRequestId !== row.rootRequestId) throw new Error('Invalid Bot request ancestry');
    if (row.id === row.rootRequestId) continue;
    const count = (counts.get(row.rootRequestId) ?? 0) + 1;
    if (count > ROOT_CHILDREN) throw new Error('The stored Bot workspace exceeds its root request limit');
    counts.set(row.rootRequestId, count);
  }
  return rows;
}

export class RequestStateStore {
  private readonly file: string;
  private readonly protect: () => void;
  private readonly write: typeof atomicWriteFileSync;
  private rows: Map<string, RequestRow>;

  constructor(root: string, protect: () => void, write = atomicWriteFileSync) {
    this.file = join(root, 'requests.json');
    this.protect = protect;
    this.write = write;
    this.rows = load(this.file);
  }

  private save(row: RequestRow): RequestRow {
    if (!validRow(row)) throw new Error('Invalid Bot request row');
    const next = new Map(this.rows).set(row.id, row);
    this.protect();
    this.write(this.file, JSON.stringify([...next.values()]) + '\n', 0o600);
    this.rows = next;
    return structuredClone(row);
  }

  get(id: string): RequestRow {
    const row = this.rows.get(id);
    if (!row) throw new Error('Unknown Bot request');
    return structuredClone(row);
  }

  list(): RequestRow[] { return structuredClone([...this.rows.values()]); }

  children(id: string): RequestRow[] {
    return structuredClone([...this.rows.values()].filter(row => row.parentRequestId === id));
  }

  cancelledAncestor(row: RequestRow): boolean {
    let id = row.parentRequestId;
    while (id) {
      const parent = this.get(id);
      if (parent.state.status === 'cancelled') return true;
      id = parent.parentRequestId;
    }
    return false;
  }

  admit(input: Admission): RequestRow {
    if (this.rows.has(input.id)) throw new Error('This Bot request already has an identity');
    if (input.rerunOf) {
      const previous = this.get(input.rerunOf);
      if (previous.sourceThreadId !== input.sourceThreadId || previous.sourceConversationId !== input.sourceConversationId ||
          previous.targetThreadId !== input.targetThreadId || previous.targetConversationId !== input.targetConversationId) {
        throw new Error('A new attempt must keep its original conversations');
      }
    }
    const { rootRequestId } = parentScope(input, this.rows, input.id);
    return this.save({ ...input, rootRequestId, revision: 1, state: { status: 'admitted' } });
  }

  acceptDelivery(id: string, expectedRevision: number, turnId: string, when: RequestRow['when']): RequestRow {
    const row = this.get(id);
    if (row.revision !== expectedRevision) throw new Error('This Bot request changed');
    if (row.state.status !== 'admitted' || (row.when === 'queue' && when === 'now')) {
      throw new Error('The request delivery does not match its admission');
    }
    return this.save({ ...row, when, revision: row.revision + 1, state: { status: when === 'now' ? 'running' : 'queued', turnId } });
  }

  advance(id: string, expectedRevision: number, state: RequestState): RequestRow {
    const row = this.get(id);
    if (row.revision !== expectedRevision) throw new Error('This Bot request changed');
    if (!transitions[row.state.status].has(state.status)) throw new Error('This Bot request cannot enter that state');
    if ('turnId' in row.state && 'turnId' in state && row.state.turnId !== state.turnId) throw new Error('The recipient’s turn changed');
    const expected = row.state.status === 'returning' ? row.state : row.state.status === 'uncertain' ? row.state.reply : undefined;
    if (state.status === 'returned' && (!expected || expected.replyId !== state.replyId ||
        expected.turnId !== state.turnId || expected.failed !== state.failed || JSON.stringify(expected.result) !== JSON.stringify(state.result))) {
      throw new Error('The result delivery does not match its saved receipt');
    }
    return this.save({ ...row, revision: row.revision + 1, state: structuredClone(state) });
  }
}
