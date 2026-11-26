import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { CliResponse } from '../models/claude-pool.ts';
import type { Account, Provider } from '../protocol.ts';
import type { Runner } from '../runner.ts';
import { cutOut } from '../store.ts';
import { reviewBatch } from './memory-review.ts';
import { tidyRequest, tidySystem, writtenIn } from './ported/memory-copy.js';
import { PersonalMemory } from './ported/personal-memory.js';
import type { Bot, BotRepository } from './repository.ts';
import { ReviewCheckpoints } from './review-checkpoints.ts';
import { reviewLineOf } from './review-events.ts';

const MAX_PASSES = 4;
const PAGE_EVENTS = 256;

type Ask = (req: { account: Account; model: string; system: string; prompt: string }) => Promise<CliResponse>;
export type BotReviewOptions = {
  root: string;
  repo: BotRepository;
  runner: Runner;
  enabled: () => boolean;
  redact: (text: string) => string;
  askers: Partial<Record<Provider, Ask>>;
  privateFolder?: (folder: string) => boolean;
};

export class BotReviews {
  private readonly checkpoints: ReviewCheckpoints;
  private readonly options: BotReviewOptions;
  private work: Promise<void> = Promise.resolve();

  constructor(options: BotReviewOptions) {
    this.options = options;
    this.checkpoints = new ReviewCheckpoints(join(options.root, 'reviews'));
  }

  private link(botId: string, threadId: string) {
    const link = this.options.repo.conversations(botId).find(item => item.threadId === threadId);
    if (!link) throw new Error('This Thread does not belong to this Bot');
    return link;
  }

  reports(botId: string, threadId: string) {
    const link = this.link(botId, threadId);
    this.reconcile(botId, link.id);
    return this.checkpoints.reports(link.id);
  }

  reject(botId: string, threadId: string, reportId: string, index: number, operationId: string): void {
    const link = this.link(botId, threadId);
    this.reconcile(botId, link.id);
    this.checkpoints.reject(link.id, reportId, index, operationId);
  }

  approve(botId: string, threadId: string, reportId: string, index: number, operationId: string, acceptedText?: string): void {
    const { repo, runner, redact } = this.options;
    const link = this.link(botId, threadId);
    const reports = this.reports(botId, threadId);
    const report = reports.find(item => item.id === reportId);
    const candidate = report?.changes[index];
    if (!report || !candidate) throw new Error('Unknown memory proposal');
    if (candidate.decision === 'approved' && candidate.operationId === operationId && candidate.acceptedText === acceptedText) return;
    if (candidate.decision !== 'pending') throw new Error('This memory proposal was already decided');
    if (reports.some(row => row.changes.some(item => item.operationId === operationId))) throw new Error('The operation id already belongs to another proposal');
    if (repo.get(botId).archivedAt) throw new Error('This Bot is archived');
    if (candidate.op === 'remove' && acceptedText !== undefined) throw new Error('A removal cannot replace the note text');
    const applied = this.memory(botId).approveReview(candidate, {
      reportId, index, operationId, conversationId: link.id, threadId,
      first: report.source.first, through: report.source.through,
      ...(acceptedText === undefined ? {} : { acceptedText }),
    }, runner.isoNow(), redact);
    this.checkpoints.reconcile(link.id, [applied]);
  }

  private memory(botId: string): PersonalMemory {
    const { root, redact } = this.options;
    return new PersonalMemory(join(root, 'memory', botId), { base: root, redact });
  }

  private reconcile(botId: string, conversationId: string): void {
    const receipts = this.memory(botId).history().flatMap(row => row.review ?? []);
    if (receipts.length > 0) this.checkpoints.reconcile(conversationId, receipts);
  }

  unavailable(bot: Bot): string | undefined {
    const { runner, askers } = this.options;
    const binding = bot.modelBinding;
    if (!binding) return 'Choose this Bot’s login and model from a conversation first.';
    if (!askers[binding.provider]) return 'This model provider does not support automatic Bot memory review.';
    const account = runner.accounts.get(binding.accountId);
    if (!account || account.provider !== binding.provider) return 'The Bot’s saved login is no longer available.';
    try {
      if (runner.checkSettings(account, binding.model, binding.effort).model !== binding.model) return 'The Bot’s saved model is no longer available.';
    } catch {
      return 'The Bot’s saved model is no longer available.';
    }
    return undefined;
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.work.then(work);
    this.work = result.then(() => {}, () => {});
    return result;
  }

  review(threadId: string): Promise<void> { return this.enqueue(() => this.reviewNew(threadId)); }

  retry(botId: string, threadId: string, reportId: string, operationId: string): Promise<void> {
    return this.enqueue(async () => {
      const link = this.link(botId, threadId);
      const rows = this.checkpoints.reports(link.id);
      const completed = rows.find(row => row.retry?.operationId === operationId);
      if (completed) {
        if (completed.retry?.previous !== reportId) throw new Error('The operation id already belongs to a different review');
        return;
      }
      const previous = rows.find(row => row.id === reportId);
      if (!previous) throw new Error('Unknown memory review');
      const { first, through } = previous.source;
      const next = await this.evaluate(threadId, false, first - 1, through);
      if (!next?.source || next.source.first !== first || next.source.through !== through) throw new Error('This review’s original event range is no longer available');
      this.checkpoints.retry(next.source, next.result, reportId, operationId);
    });
  }

  tidy(botId: string, memory: () => PersonalMemory, expectedRevision: string, operationId: string, protect: () => void) {
    return this.enqueue(async () => {
      const { runner, repo, enabled, askers, redact } = this.options;
      if (!enabled()) throw new Error('Bot memory tidy is unavailable');
      const bot = repo.get(botId);
      if (bot.archivedAt) throw new Error('This Bot is archived');
      const store = memory();
      const previous = store.tidyResult(operationId);
      if (previous) return previous;
      if (store.revision() !== expectedRevision) throw new Error('These notes changed. Reload the current notes before tidying.');
      const time = runner.isoNow();
      const input = store.tidyInput(time.slice(0, 10));
      if (!input || (input.numbered.length < 8 && input.ended.length === 0)) return { revision: expectedRevision, counts: { merged: 0, moved: 0, retired: 0 } };
      let reply = '{"changes":[]}';
      if (input.numbered.length >= 8) {
        const problem = this.unavailable(bot);
        const binding = bot.modelBinding;
        const ask = binding && askers[binding.provider];
        const account = binding && runner.accounts.get(binding.accountId);
        if (problem || !binding || !ask || !account) throw new Error(problem ?? 'The Bot’s model is unavailable');
        const max = Math.max(1, Math.floor((input.numbered.length + input.ended.length) / 5));
        const language = writtenIn(input.numbered.map(entry => entry.text), 'the user’s language');
        const answer = await ask({ account, model: binding.model, system: tidySystem({ who: redact(bot.name), max }), prompt: tidyRequest({ entries: input.numbered, language }) });
        if (!answer.ok) throw new Error('The Bot’s model could not tidy this memory scope');
        reply = answer.text;
      }
      if (!enabled() || repo.get(botId).revision !== bot.revision) throw new Error('The Bot changed while the model was reviewing the notes');
      const current = memory();
      if (current.revision() !== expectedRevision) throw new Error('These notes changed while the model reviewed them');
      protect();
      return current.tidy(input, reply, operationId, time);
    });
  }

  private async reviewNew(threadId: string): Promise<void> {
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const next = await this.evaluate(threadId, true);
      if (!next) return;
      if (!next.source) this.checkpoints.advance(next.conversationId, next.cursor, next.result.through);
      else this.checkpoints.record(next.source, next.cursor, next.result);
    }
  }

  private async evaluate(threadId: string, automatic: boolean, after?: number, before?: number) {
    const { repo, runner, enabled, redact, askers, privateFolder } = this.options;
    if (!enabled()) return;
    const rec = runner.threads.get(threadId)?.rec;
    if (!rec?.botLink || rec.status !== 'idle' || rec.copied || privateFolder?.(rec.cwd)) return;
    const bot = repo.get(rec.botLink.botId);
    const binding = bot.modelBinding;
    if ((automatic && !bot.reviewEnabled) || bot.archivedAt || !binding || this.unavailable(bot)) return;
    const account = runner.accounts.get(binding.accountId);
    const ask = askers[binding.provider];
    if (!account || !ask) return;
    const link = this.link(bot.id, threadId);
    if (rec.botLink.conversationId !== link.id) return;
    const cursor = after ?? this.checkpoints.cursor(link.id);
    const log = runner.store.log(threadId);
    const through = Math.min(log.lastSeq, before ?? cursor + PAGE_EVENTS);
    if (through <= cursor) return;
    const events = log.read(cursor + 1, through);
    const cut = JSON.stringify([rec.rewinds, rec.withheldSeqs]);
    const lines = events.flatMap(event => {
      if (cutOut(rec, event.seq)) return [];
      const line = reviewLineOf(event, link.id, redact);
      return line ?? [];
    });
    const notes = this.memory(bot.id).list(runner.isoNow().slice(0, 10));
    const scopeRevision = createHash('sha256').update(JSON.stringify(notes)).digest('hex');
    let usage: { inputTokens?: number; outputTokens?: number; notionalUsd?: number } | undefined;
    const outcome = await reviewBatch({ bot, notes, lines, through, redact, ask: async (system, prompt) => {
      const answer = await ask({ account, model: binding.model, system, prompt });
      if (!answer.ok) throw new Error('The Bot’s model could not complete its memory review');
      const { inputTokens, outputTokens, notionalUsd } = answer;
      usage = { inputTokens, outputTokens, notionalUsd };
      return answer.text;
    } });
    // A late reply cannot write into a different configuration, deleted
    // conversation or rewound log, or after this Runner gave up ownership.
    const now = runner.threads.get(threadId)?.rec;
    if (!enabled() || !now || now.status !== 'idle' || now.botLink?.conversationId !== link.id ||
        JSON.stringify([now.rewinds, now.withheldSeqs]) !== cut || repo.get(bot.id).revision !== bot.revision) return;
    const source = outcome.first === undefined ? undefined : {
      purpose: 'bot-memory-review' as const, threadId, botId: bot.id, conversationId: link.id, configRevision: bot.revision,
      scopeRevision, provider: binding.provider, model: binding.model, accountId: account.id,
      first: outcome.first, through: outcome.through,
    };
    return { conversationId: link.id, cursor, source, result: { ...outcome, usage } };
  }
}
