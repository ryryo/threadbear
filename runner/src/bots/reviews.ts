import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { CliResponse } from '../models/claude-pool.ts';
import type { Account, Provider } from '../protocol.ts';
import type { Runner } from '../runner.ts';
import { cutOut } from '../store.ts';
import { reviewBatch } from './memory-review.ts';
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

  async review(threadId: string): Promise<void> {
    const { repo, runner, enabled, redact, askers, privateFolder } = this.options;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      if (!enabled()) return;
      const rec = runner.threads.get(threadId)?.rec;
      if (!rec?.botLink || rec.status !== 'idle' || rec.copied || privateFolder?.(rec.cwd)) return;
      const bot = repo.get(rec.botLink.botId);
      const binding = bot.modelBinding;
      if (!bot.reviewEnabled || bot.archivedAt || !binding || this.unavailable(bot)) return;
      const account = runner.accounts.get(binding.accountId);
      const ask = askers[binding.provider];
      if (!account || !ask) return;
      const link = this.link(bot.id, threadId);
      if (rec.botLink.conversationId !== link.id) return;
      const cursor = this.checkpoints.cursor(link.id);
      const log = runner.store.log(threadId);
      const through = Math.min(log.lastSeq, cursor + PAGE_EVENTS);
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
      if (outcome.first === undefined) this.checkpoints.advance(link.id, cursor, outcome.through);
      else this.checkpoints.record({
        purpose: 'bot-memory-review', threadId, botId: bot.id, conversationId: link.id, configRevision: bot.revision,
        scopeRevision, provider: binding.provider, model: binding.model, accountId: account.id,
        first: outcome.first, through: outcome.through,
      }, cursor, { ...outcome, usage });
    }
  }
}
