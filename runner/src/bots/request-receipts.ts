import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../fsutil.ts';
import { NAME_MAX, install, type ReceiptRecord, type RequestIdentity, type Verdict } from './ported/requests.js';

export type DeliveryReceipt = { requestId: string; threadId: string; turnId: string; when: 'queue' | 'now' };
type Undelivered = { reason: unknown };
type Decision = DeliveryReceipt | Undelivered;
type Row = ReceiptRecord<Decision>;
type Outcome = Verdict<DeliveryReceipt> | { status: 'refused'; reason: unknown };
type Identity = { caller: string; context: string; name: string; payload: unknown };

function load(file: string): Record<string, Row> {
  let rows: Record<string, Row>;
  try {
    if (!lstatSync(file).isFile()) throw new Error('The Bot request receipt store must be a regular file');
    rows = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Row>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  if (!rows || typeof rows !== 'object' || Array.isArray(rows)) throw new Error('Invalid Bot request receipt store');
  for (const [key, row] of Object.entries(rows)) {
    const parts = key.split('\u0000');
    if (parts.length !== 3 || parts.some(part => !part) || !row || !['pending', 'delivered', 'uncertain'].includes(row.outcome) ||
        !/^[a-f0-9]{64}$/.test(row.fingerprint) || !Number.isFinite(row.at) || typeof row.run !== 'string') {
      throw new Error('Invalid Bot request receipt');
    }
    const receipt = row.receipt;
    if (receipt !== undefined && (!receipt || typeof receipt !== 'object' || 'reason' in receipt || typeof receipt.requestId !== 'string' ||
        typeof receipt.threadId !== 'string' || typeof receipt.turnId !== 'string' || !['queue', 'now'].includes(receipt.when))) {
      throw new Error('Invalid Bot delivery receipt');
    }
  }
  return rows;
}

// Use DS-Bot's exact admission and replay state machine. The Runner supplies
// its existing data lock, authenticated names and atomic file replacement.
export class RequestReceipts {
  readonly identity: (input: Identity) => RequestIdentity;
  readonly known: (request: RequestIdentity) => Promise<Verdict<DeliveryReceipt> | undefined>;
  readonly admit: (request: RequestIdentity, deliver: () => Promise<Decision>) => Promise<Outcome>;

  constructor(root: string, owns: () => boolean, protect: () => void, warn: () => void, write = atomicWriteFileSync) {
    const file = join(root, 'request-receipts.json');
    const state = { requests: load(file) };
    const port: {
      state: typeof state;
      own: (rows: typeof state.requests, key: string) => Row | undefined;
      readOnly: () => string | undefined;
      save: () => Promise<void>;
      warn: () => void;
    } = {
      state,
      own: (rows, key) => Object.hasOwn(rows, key) ? rows[key] : undefined,
      readOnly: () => owns() ? undefined : 'The Runner does not own this Bot workspace',
      save: async () => {
        if (!owns()) throw new Error('The Runner does not own this Bot workspace');
        protect();
        write(file, JSON.stringify(state.requests) + '\n', 0o600);
      },
      warn,
    };
    install<Decision>(port);
    this.identity = input => {
      if (!input.name || input.name.length > NAME_MAX || [input.caller, input.context, input.name].some(value => !value || value.includes('\u0000'))) {
        throw new Error('Invalid Bot request identity');
      }
      return port.requestIdentity(input);
    };
    this.known = async request => {
      const outcome = await port.knownRequest(request);
      if (!outcome || !('receipt' in outcome)) return outcome;
      if ('reason' in outcome.receipt) return undefined;
      return { ...outcome, receipt: outcome.receipt };
    };
    this.admit = async (request, deliver) => {
      const outcome = await port.admitRequest(request, async () => {
        const decision = await deliver();
        if ('reason' in decision) request.unsent = true;
        return decision;
      });
      if (!('receipt' in outcome)) return outcome;
      if ('reason' in outcome.receipt) return { status: 'refused', reason: outcome.receipt.reason };
      return { ...outcome, receipt: outcome.receipt };
    };
  }
}
