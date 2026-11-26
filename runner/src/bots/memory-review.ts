// Debounce, serialize and fit batches as in DS-Bot d104d9ca18d69a35460f14e15dff4d553181433a,
// ds-bot/src/host/memory-review.js. Apache-2.0, Fei2411 and contributors.
import type { Clock, TimerHandle } from '../clock.ts';
import { REVIEW_CHANGES_MAX, reviewRequest, reviewSystem, writtenIn } from './ported/memory-copy.js';
import { cleanDay, cleanEntry, looksSecret, MEMORY_LIMITS, parseReview } from './ported/memory-entries.js';
import type { MemoryNote } from './ported/personal-memory.js';
import { fitted } from './ported/review-lines.js';
import type { ReviewLine } from './review-events.ts';

const IDLE_DELAY_MS = 2_000;
const MAX_REPLY_CHARS = 32_000;

export class ReviewQueue {
  private readonly timers = new Map<string, TimerHandle>();
  private readonly waiting = new Map<string, symbol>();
  private chain = Promise.resolve();
  private readonly clock: Clock;
  private readonly review: (key: string) => Promise<void>;
  private readonly onError: (key: string) => void;

  constructor(clock: Clock, review: (key: string) => Promise<void>, onError: (key: string) => void) {
    this.clock = clock;
    this.review = review;
    this.onError = onError;
  }

  status(key: string, idle: boolean): void {
    this.timers.get(key)?.cancel();
    this.timers.delete(key);
    if (!idle) {
      this.waiting.delete(key);
      return;
    }
    if (!this.waiting.has(key)) {
      this.timers.set(key, this.clock.setTimeout(() => {
        this.timers.delete(key);
        this.enqueue(key);
      }, IDLE_DELAY_MS));
    }
  }

  private enqueue(key: string): void {
    const ticket = Symbol();
    this.waiting.set(key, ticket);
    this.chain = this.chain.then(async () => {
      if (this.waiting.get(key) !== ticket) return;
      this.waiting.delete(key);
      try {
        await this.review(key);
      } catch {
        this.onError(key);
      }
    });
  }

  settled(): Promise<void> { return this.chain; }

  stop(): void {
    for (const timer of this.timers.values()) timer.cancel();
    this.timers.clear();
    this.waiting.clear();
  }
}

export type ReviewChange = { op: 'add'; text: string; until?: string }
  | { op: 'edit'; id: string; before: string; text: string }
  | { op: 'remove'; id: string; before: string };
type Batch = { first?: number; through: number; more: boolean; rejected: number; changes: ReviewChange[]; diagnostic?: 'invalid-reply' };

type ReviewOptions = {
  bot: { name: string; role?: string };
  lines: readonly ReviewLine[];
  through: number;
  notes: readonly MemoryNote[];
  redact: (text: string) => string;
  ask: (system: string, prompt: string) => Promise<string>;
  group?: boolean;
};

// The caller reads and saves the cursor. Transport and storage errors throw so
// it can retry the same range. Only bounded diagnostics and accepted text leave here.
export async function reviewBatch({ bot, lines, through, notes, redact, ask, group = false }: ReviewOptions): Promise<Batch> {
  const keeper = { name: redact(bot.name), role: bot.role && redact(bot.role) };
  const { count, texts } = fitted(lines.map(line => ({ ...line, text: redact(line.text) })), keeper);
  const latest = lines.slice(0, count);
  const owner = latest.filter(line => line.who === 'user');
  const more = count < lines.length;
  const batch: Batch = { through: more ? latest[count - 1].seq : through, more, rejected: 0, changes: [] };
  if (owner.length === 0) return batch;
  batch.first = latest[0].seq;
  const reply = await ask(reviewSystem({ group }), reviewRequest({
    who: group ? `The group: ${keeper.name}.` : `The Bot: ${keeper.name}${keeper.role ? `, ${keeper.role}` : ''}.`,
    tag: group ? 'group' : 'own',
    numbered: notes.map(note => ({
      scope: group ? 'group' : 'own', file: {}, meta: { pinned: note.pinned }, text: redact(note.text),
    })),
    where: group ? 'the group chat' : 'its own chat with the user',
    earlier: [], fresh: texts, more, language: writtenIn(owner.map(line => redact(line.text).replace(/^User: /, '')), 'the user’s language'),
  }));
  const parsed = reply.length <= MAX_REPLY_CHARS ? parseReview(reply) : undefined;
  if (!parsed) return { ...batch, diagnostic: 'invalid-reply' };
  batch.rejected = parsed.leftOut.length + Math.max(0, parsed.changes.length - REVIEW_CHANGES_MAX);
  for (const change of parsed.changes.slice(0, REVIEW_CHANGES_MAX)) {
    const note = typeof change.entry === 'number' ? notes[change.entry - 1] : undefined;
    const text = cleanEntry(change.text);
    const invalidText = !text || text.length > MEMORY_LIMITS.entry || looksSecret(change.text ?? '') || redact(change.text ?? '') !== change.text;
    const until = cleanDay(change.until);
    // The authenticated conversation determines the scope. The model cannot
    // name other audiences or create a path. The writer rechecks notes and pins.
    if (change.team === true || change.for !== undefined || change.group !== undefined || change.topic !== undefined) {
      batch.rejected++;
    } else if (change.op === 'add' && !invalidText && (change.until === undefined || change.until === until)) {
      batch.changes.push({ op: 'add', text, ...(until === undefined ? {} : { until }) });
    } else if (change.op !== 'add' && note && !note.pinned && !looksSecret(note.text) && redact(note.text) === note.text && (change.op === 'remove' || !invalidText)) {
      batch.changes.push(change.op === 'remove'
        ? { op: 'remove', id: note.id, before: note.text }
        : { op: 'edit', id: note.id, before: note.text, text });
    } else {
      batch.rejected++;
    }
  }
  return batch;
}
