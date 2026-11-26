import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicWriteFileSync } from '../fsutil.ts';
import { PROVIDERS } from '../protocol.ts';
import type { ReviewChange } from './memory-review.ts';
import { REVIEW_CHANGES_MAX } from './ported/memory-copy.js';
import { MEMORY_LIMITS } from './ported/memory-entries.js';
import type { ReviewReceipt } from './ported/personal-memory.js';
import { botOperationId } from './repository.ts';

const sequence = z.int().nonnegative();
const evidence = z.object({
  purpose: z.literal('bot-memory-review'), botId: z.uuid(), conversationId: z.uuid(), threadId: z.uuid(),
  configRevision: z.int().positive(), scopeRevision: z.string().min(1).max(128),
  first: sequence, through: sequence, provider: z.enum(PROVIDERS), model: z.string().min(1), accountId: z.string().min(1),
}).refine(source => source.first <= source.through);
const note = z.string().trim().min(1).max(MEMORY_LIMITS.entry);
const decision = { decision: z.enum(['pending', 'rejected', 'approved']), operationId: botOperationId.optional(), acceptedText: note.optional() };
const change = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), text: note, until: z.iso.date().optional(), ...decision }),
  z.object({ op: z.literal('edit'), id: z.string().min(1), before: note, text: note, ...decision }),
  z.object({ op: z.literal('remove'), id: z.string().min(1), before: note, ...decision }),
]);
const usage = z.object({ inputTokens: sequence.optional(), outputTokens: sequence.optional(), notionalUsd: z.number().nonnegative().optional() });
const report = z.object({
  id: z.uuid(), source: evidence, rejected: z.int().nonnegative(), changes: z.array(change).max(REVIEW_CHANGES_MAX),
  diagnostic: z.literal('invalid-reply').optional(),
  usage: usage.optional(),
  retry: z.object({ previous: z.uuid(), operationId: botOperationId }).optional(),
});
const checkpoint = z.object({ conversationId: z.uuid(), cursor: sequence, reports: z.array(report) });

export type ReviewEvidence = z.infer<typeof evidence>;
type Report = z.infer<typeof report>;
type Checkpoint = z.infer<typeof checkpoint>;
type Result = { rejected: number; changes: ReviewChange[]; diagnostic?: 'invalid-reply'; usage?: z.infer<typeof usage> };

/** Each conversation's cursor and reports are replaced together under the Runner's write lock. */
export class ReviewCheckpoints {
  private readonly root: string;
  private readonly write: typeof atomicWriteFileSync;

  constructor(root: string, write = atomicWriteFileSync) {
    this.root = root;
    this.write = write;
  }

  private file(conversationId: string): string { return join(this.root, `${z.uuid().parse(conversationId)}.json`); }

  private read(conversationId: string): Checkpoint {
    const file = this.file(conversationId);
    try {
      if (!lstatSync(this.root).isDirectory() || !lstatSync(file).isFile()) throw new Error('Review data must use regular files');
      const saved = checkpoint.parse(JSON.parse(readFileSync(file, 'utf8')));
      if (saved.conversationId !== conversationId || saved.reports.some(row => row.source.conversationId !== conversationId || row.source.through > saved.cursor)) {
        throw new Error('Review data does not match the conversation');
      }
      return saved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { conversationId, cursor: 0, reports: [] };
      throw error;
    }
  }

  private save(next: Checkpoint): void {
    this.write(this.file(next.conversationId), `${JSON.stringify(next)}\n`, 0o600);
  }

  cursor(conversationId: string): number { return this.read(conversationId).cursor; }

  reports(conversationId: string): Report[] { return this.read(conversationId).reports; }

  private pending(conversationId: string, expectedCursor: number, through: number): Checkpoint {
    const saved = this.read(conversationId);
    if (saved.cursor !== expectedCursor) throw new Error('The review checkpoint changed');
    if (sequence.parse(through) <= expectedCursor) throw new Error('The review cursor must move forward');
    return { ...saved, cursor: through };
  }

  advance(conversationId: string, expectedCursor: number, through: number): void {
    this.save(this.pending(conversationId, expectedCursor, through));
  }

  record(source: ReviewEvidence, expectedCursor: number, result: Result): Report {
    const next = this.pending(source.conversationId, expectedCursor, source.through);
    if (source.first <= expectedCursor) throw new Error('The review range overlaps reviewed events');
    return this.writeReport(next, source, result);
  }

  retry(source: ReviewEvidence, result: Result, previous: string, operationId: string): Report {
    const checkpoint = this.read(source.conversationId);
    const original = checkpoint.reports.find(row => row.id === previous);
    if (!original || original.source.first !== source.first || original.source.through !== source.through) throw new Error('The source range changed');
    const completed = checkpoint.reports.find(row => row.retry?.operationId === operationId);
    if (completed) {
      if (completed.retry?.previous !== previous) throw new Error('The operation id already belongs to a different review');
      return completed;
    }
    return this.writeReport(checkpoint, source, result, { previous, operationId });
  }

  private writeReport(state: Checkpoint, source: ReviewEvidence, result: Result, retry?: Report['retry']): Report {
    const accepted = report.parse({
      id: randomUUID(), source, rejected: result.rejected,
      ...(result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic }),
      ...(result.usage === undefined ? {} : { usage: result.usage }),
      ...(retry === undefined ? {} : { retry }),
      changes: result.changes.map(item => ({ ...item, decision: 'pending' })),
    });
    this.save({ ...state, reports: [accepted, ...state.reports] });
    return accepted;
  }

  reject(conversationId: string, reportId: string, changeIndex: number, operationId: string): void {
    botOperationId.parse(operationId);
    const saved = this.read(conversationId);
    const current = saved.reports.find(row => row.id === reportId)?.changes[changeIndex];
    if (!current) throw new Error('Unknown memory proposal');
    if (current.decision === 'rejected' && current.operationId === operationId) return;
    if (current.decision !== 'pending') throw new Error('This memory proposal was already decided');
    if (saved.reports.some(row => row.changes.some(item => item.operationId === operationId))) throw new Error('The operation id already belongs to another proposal');
    current.decision = 'rejected';
    current.operationId = operationId;
    this.save(saved);
  }

  // A committed memory journal row is enough to finish the corresponding
  // UI decision if the Runner lost power before its second atomic write.
  reconcile(conversationId: string, receipts: readonly ReviewReceipt[]): void {
    const saved = this.read(conversationId);
    let changed = false;
    for (const receipt of receipts) {
      if (receipt.conversationId !== conversationId) continue;
      const row = saved.reports.find(item => item.id === receipt.reportId);
      const current = row?.changes[receipt.index];
      if (!row || !current || row.source.threadId !== receipt.threadId) throw new Error('A review receipt does not match its proposal');
      if (current.decision === 'approved' && current.operationId === receipt.operationId && current.acceptedText === receipt.acceptedText) continue;
      if (current.decision !== 'pending') throw new Error('A review receipt conflicts with the recorded decision');
      current.decision = 'approved';
      current.operationId = receipt.operationId;
      if (receipt.acceptedText !== undefined) current.acceptedText = note.parse(receipt.acceptedText);
      changed = true;
    }
    if (changed) this.save(saved);
  }
}
