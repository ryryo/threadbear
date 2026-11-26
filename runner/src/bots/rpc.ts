import { z } from 'zod';
import { ErrorCode, RpcError } from '../protocol.ts';
import type { BotConversations } from './conversations.ts';
import type { BotRepository } from './repository.ts';
import type { BotReviews } from './reviews.ts';
import { MEMORY_LIMITS } from './ported/memory-entries.js';

const botId = z.uuid();
const identity = z.object({ botId });
const settings = z.object({ name: z.string().min(1), role: z.string().optional(), instructions: z.string().optional() });
const memoryTarget = identity.extend({ threadId: z.uuid() });
const proposal = memoryTarget.extend({ reportId: z.uuid(), index: z.int().nonnegative(), operationId: z.uuid() });

function method<T>(schema: z.ZodType<T>, run: (p: T) => unknown): (p: Record<string, unknown>) => unknown {
  return (p) => {
    const input = schema.safeParse(p);
    if (!input.success) throw new RpcError(ErrorCode.badParams, `Invalid Bot parameters: ${input.error.issues.map(issue => issue.path.join('.')).join(', ')}`);
    return run(input.data);
  };
}

export function botMethods(workspace: () => { repo: BotRepository; conversations: BotConversations }, reviews?: () => BotReviews): Record<string, (p: Record<string, unknown>) => unknown> {
  const repo = () => workspace().repo;
  const conversations = () => workspace().conversations;
  return {
    'bots.list': () => ({ bots: repo().list() }),
    'bots.get': method(identity, ({ botId }) => { const store = repo(); return { bot: store.get(botId), conversations: store.conversations(botId) }; }),
    'bots.create': method(settings, p => ({ bot: repo().create(p) })),
    'bots.update': method(settings.partial().extend({ botId, expectedRevision: z.int().positive() }), ({ botId, expectedRevision, ...p }) => ({ bot: repo().update(botId, expectedRevision, p) })),
    'bots.archive': method(identity.extend({ expectedRevision: z.int().positive() }), p => ({ bot: conversations().archive(p.botId, p.expectedRevision) })),
    'bots.settings.conversationModel': method(identity.extend({ expectedRevision: z.int().positive(), threadId: z.uuid().nullable() }), p => ({ bot: conversations().conversationModel(p.botId, p.expectedRevision, p.threadId) })),
    'bots.conversations.create': method(identity.extend({ operationId: z.string().min(1).max(128) }), p => {
      const service = conversations();
      const conversation = service.create(p.botId, p.operationId);
      return { conversation, thread: service.summary(conversation.threadId) };
    }),
    'bots.memory.read': method(memoryTarget, p => ({ notes: conversations().notes(p.botId, p.threadId) })),
    'bots.memory.search': method(memoryTarget.extend({ query: z.string().trim().min(1).max(300) }), p => ({ notes: conversations().search(p.botId, p.threadId, p.query) })),
    'bots.memory.add': method(memoryTarget.extend({ text: z.string(), until: z.iso.date().optional() }), p => ({ note: conversations().remember(p.botId, p.threadId, p.text, p.until) })),
    'bots.memory.edit': method(memoryTarget.extend({ entryId: z.string().min(1), text: z.string() }), p => ({ note: conversations().editNote(p.botId, p.threadId, p.entryId, p.text) })),
    'bots.memory.remove': method(memoryTarget.extend({ entryId: z.string().min(1) }), p => { conversations().removeNote(p.botId, p.threadId, p.entryId); return {}; }),
    'bots.memory.history': method(memoryTarget.extend({ before: z.uuid().optional() }), p => conversations().history(p.botId, p.threadId, p.before)),
    'bots.memory.restore': method(memoryTarget.extend({ changeId: z.uuid() }), p => { conversations().restoreNote(p.botId, p.threadId, p.changeId); return {}; }),
    ...(reviews && {
      'bots.settings.automaticReview': method(identity.extend({ expectedRevision: z.int().positive(), enabled: z.boolean() }), ({ botId, expectedRevision, enabled }) => {
        const service = reviews();
        const reason = enabled ? service.unavailable(repo().get(botId)) : undefined;
        if (reason) throw new RpcError(ErrorCode.notAllowed, reason);
        return { bot: repo().setReviewEnabled(botId, expectedRevision, enabled) };
      }),
      'bots.reviews.list': method(memoryTarget, p => ({
        reports: reviews().reports(p.botId, p.threadId), unavailable: reviews().unavailable(repo().get(p.botId)),
      })),
      'bots.reviews.reject': method(proposal, p => {
        reviews().reject(p.botId, p.threadId, p.reportId, p.index, p.operationId);
        return {};
      }),
      'bots.reviews.approve': method(proposal.extend({ text: z.string().trim().min(1).max(MEMORY_LIMITS.entry).optional() }), p => {
        reviews().approve(p.botId, p.threadId, p.reportId, p.index, p.operationId, p.text);
        return {};
      }),
    }),
  };
}
