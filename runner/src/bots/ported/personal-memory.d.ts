export type MemoryNote = { id: string; text: string; pinned: boolean; until?: string; topic?: string };
export type MemoryChange = {
  id: string;
  time: string;
  op: 'add' | 'remove' | 'replace' | 'tidy';
  before?: string;
  after?: string;
  restored?: string;
  sourceThreadId?: string;
  sourceTurnId?: string;
  sourceSeq?: number;
  actor?: string;
  review?: ReviewReceipt;
};

export type ReviewSource = { reportId: string; index: number; conversationId: string; threadId: string; first: number; through: number };
export type ReviewReceipt = ReviewSource & { operationId: string; acceptedText?: string };
export type ScopeChange = { op: 'add'; text: string; until?: string }
  | { op: 'edit'; entryId: string; text: string }
  | { op: 'remove'; entryId: string }
  | { op: 'restore'; changeId: string };
type BotNoteSource = { actor: string; sourceThreadId: string; sourceTurnId: string; sourceSeq: number; pin: boolean };
type TidyEntry = { text: string; file: { topic?: string }; meta: { added?: string } };
export type TidyCounts = { merged: number; moved: number; retired: number };
type TidyInput = { revision: string; numbered: TidyEntry[]; ended: TidyEntry[] };

export class PersonalMemory {
  constructor(root: string, options?: { scope?: 'own' | 'team' | 'project' | 'group'; base?: string; redact?: (text: string) => string });
  list(today: string): MemoryNote[];
  search(query: string, today: string): MemoryNote[];
  history(): MemoryChange[];
  historyPage(before?: string): { rows: MemoryChange[]; more: string | null };
  revision(): string;
  add(text: string, options: { until?: string; sourceThreadId?: string }, time: string): MemoryNote;
  replace(id: string, text: string, time: string): MemoryNote;
  remove(id: string, time: string): void;
  restore(id: string, time: string): void;
  change(mutation: ScopeChange, operationId: string, expectedRevision: string, time: string, source?: BotNoteSource): { revision: string; note?: MemoryNote };
  tidyInput(today: string): TidyInput | undefined;
  tidy(input: TidyInput, reply: string, operationId: string, time: string): { revision: string; counts: TidyCounts };
  tidyResult(operationId: string): { revision: string; counts: TidyCounts } | undefined;
  approveReview(change: import('../memory-review.ts').ReviewChange, receipt: ReviewReceipt, time: string, redact: (text: string) => string): ReviewReceipt;
}
