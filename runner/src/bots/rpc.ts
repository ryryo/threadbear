import { z } from 'zod';
import { ErrorCode, RpcError } from '../protocol.ts';
import type { BotConversations } from './conversations.ts';
import { botOperationId, type Bot, type BotRepository } from './repository.ts';
import { rosterMark } from './roster-mark.mjs';
import type { BotReviews } from './reviews.ts';
import { entryId, MEMORY_LIMITS, parseMemory } from './ported/memory-entries.js';
import type { ScopeChange } from './ported/personal-memory.js';
import type { ScopeRef } from './scoped-memory.ts';
import type { BotRequests } from './request-service.ts';
import { NAME_MAX } from './ported/requests.js';

const botId = z.uuid();
const identity = z.object({ botId });
const settings = z.object({ name: z.string().min(1), role: z.string().optional(), instructions: z.string().optional() });
const memoryTarget = identity.extend({ threadId: z.uuid() });
const proposal = memoryTarget.extend({ reportId: z.uuid(), index: z.int().nonnegative(), operationId: botOperationId });
const scoped = z.object({ scope: z.object({ kind: z.enum(['bot', 'team', 'group', 'project']), id: z.string().min(1).max(128) }) });
const scopeWrite = scoped.extend({ operationId: botOperationId, expectedRevision: z.union([z.literal('empty'), z.uuid()]) });
const automation = identity.extend({ expectedRevision: z.int().positive(), enabled: z.boolean(), operationId: botOperationId });

export function method<T>(schema: z.ZodType<T>, run: (p: T) => unknown): (p: Record<string, unknown>) => unknown {
  return (p) => {
    const input = schema.safeParse(p);
    if (!input.success) throw new RpcError(ErrorCode.badParams, `Invalid Bot parameters: ${input.error.issues.map(issue => issue.path.join('.')).join(', ')}`);
    return run(input.data);
  };
}

const requestSource = z.object({ threadId: z.uuid() });
const requestIdentity = requestSource.extend({ requestId: z.uuid() });
const requestWrite = requestIdentity.extend({ expectedRevision: z.int().positive() });
const requestDestination = z.object({
  botId: z.uuid(), conversationId: z.uuid().optional(), name: z.string().min(1).max(NAME_MAX),
  text: z.string().min(1).max(30_000), when: z.enum(['queue', 'now']).default('queue'),
});
export function botRequestMethods(requests: () => BotRequests): Record<string, (p: Record<string, unknown>) => unknown> {
  return {
    'bots.requests.send': method(requestSource.extend(requestDestination.shape), ({ threadId, botId, ...input }) =>
      requests().sendOwner(threadId, { ...input, to: botId })),
    'bots.requests.list': method(requestSource, ({ threadId }) => ({ requests: requests().ownerList(threadId) })),
    'bots.requests.get': method(requestIdentity, ({ threadId, requestId }) => requests().ownerRead(threadId, requestId)),
    'bots.requests.abandon': method(requestWrite, ({ threadId, requestId, expectedRevision }) =>
      ({ row: requests().ownerAbandon(threadId, requestId, expectedRevision) })),
    'bots.requests.cancel': method(requestWrite, ({ threadId, requestId, expectedRevision }) =>
      ({ row: requests().ownerCancel(threadId, requestId, expectedRevision) })),
    'bots.requests.retry': method(requestWrite, ({ threadId, requestId, expectedRevision }) =>
      ({ row: requests().ownerRetry(threadId, requestId, expectedRevision) })),
    'bots.requests.rerun': method(requestWrite.extend({ text: z.string().trim().min(1).max(30_000), operationId: botOperationId }),
      ({ threadId, requestId, expectedRevision, text, operationId }) => requests().ownerRerun(threadId, requestId, expectedRevision, text, operationId)),
  };
}

const privacy = identity.extend({ expectedRevision: z.int().positive(), folder: z.string().trim().min(1), operationId: botOperationId });
const rosterMarks = z.object({ includeRosterMarks: z.boolean().optional() });
const withRosterMark = (bot: Bot) => ({ ...bot, rosterMark: rosterMark(bot) });

export function botMethods(workspace: () => { repo: BotRepository; conversations: BotConversations }, reviews?: () => BotReviews, makePrivate?: (p: z.infer<typeof privacy>) => unknown, protectFormat?: () => void, requestsAvailable?: () => boolean): Record<string, (p: Record<string, unknown>) => unknown> {
  const repo = () => workspace().repo;
  const conversations = () => workspace().conversations;
  const memory = (scope: ScopeRef, access: 'read' | 'write') => conversations().scopedMemory.open(scope, { kind: 'owner' }, access);
  const now = () => conversations().now();
  const change = (target: z.infer<typeof scopeWrite>, mutation: ScopeChange) => memory(target.scope, 'write').change(mutation, target.operationId, target.expectedRevision, now());
  const setAutomation = (setting: 'reviewEnabled' | 'tidyEnabled') => method(automation, ({ botId, expectedRevision, enabled, operationId }) => ({
    bot: repo().setAutomation(botId, expectedRevision, setting, enabled, operationId, () => {
      const reason = enabled ? reviews?.().unavailable(repo().get(botId)) : undefined;
      if (reason) throw new RpcError(ErrorCode.notAllowed, reason);
    }),
  }));
  return {
    'bots.list': method(rosterMarks, ({ includeRosterMarks }) => {
      const bots = repo().list();
      return { bots: includeRosterMarks ? bots.map(withRosterMark) : bots };
    }),
    'bots.get': method(identity.extend(rosterMarks.shape), ({ botId, includeRosterMarks }) => {
      const store = repo();
      const bot = store.get(botId);
      return { bot: includeRosterMarks ? withRosterMark(bot) : bot, conversations: store.conversations(botId), capabilities: { scopedMemory: true, privacy: Boolean(makePrivate), reviews: Boolean(reviews), requests: requestsAvailable?.() === true } };
    }),
    'bots.create': method(settings, p => ({ bot: repo().create(p) })),
    'bots.duplicate': method(identity.extend({ expectedRevision: z.int().positive(), operationId: botOperationId }),
      async ({ botId, expectedRevision, operationId }) => ({ bot: await conversations().duplicate(botId, expectedRevision, operationId) })),
    'bots.update': method(settings.partial().extend({ botId, expectedRevision: z.int().positive() }), ({ botId, expectedRevision, ...p }) => ({ bot: repo().update(botId, expectedRevision, p) })),
    'bots.archive': method(identity.extend({ expectedRevision: z.int().positive() }), p => ({ bot: conversations().archive(p.botId, p.expectedRevision) })),
    'bots.settings.conversationModel': method(identity.extend({ expectedRevision: z.int().positive(), threadId: z.uuid().nullable() }), p => ({ bot: conversations().conversationModel(p.botId, p.expectedRevision, p.threadId) })),
    'bots.conversations.create': method(identity.extend({ operationId: z.string().min(1).max(128) }), p => {
      const service = conversations();
      const conversation = service.create(p.botId, p.operationId);
      return { conversation, thread: service.summary(conversation.threadId) };
    }),
    'bots.conversations.attach': method(memoryTarget.extend({ expectedRevision: z.int().positive(), operationId: botOperationId }), p => {
      const service = conversations();
      const conversation = service.attach(p.botId, p.expectedRevision, p.threadId, p.operationId);
      return { conversation, thread: service.summary(p.threadId) };
    }),
    'bots.memory.read': method(memoryTarget, p => ({ notes: conversations().notes(p.botId, p.threadId) })),
    'bots.memory.search': method(memoryTarget.extend({ query: z.string().trim().min(1).max(300) }), p => ({ notes: conversations().search(p.botId, p.threadId, p.query) })),
    'bots.memory.add': method(memoryTarget.extend({ text: z.string(), until: z.iso.date().optional() }), p => ({ note: conversations().remember(p.botId, p.threadId, p.text, p.until) })),
    'bots.memory.edit': method(memoryTarget.extend({ entryId: z.string().min(1), text: z.string() }), p => ({ note: conversations().editNote(p.botId, p.threadId, p.entryId, p.text) })),
    'bots.memory.remove': method(memoryTarget.extend({ entryId: z.string().min(1) }), p => { conversations().removeNote(p.botId, p.threadId, p.entryId); return {}; }),
    'bots.memory.history': method(memoryTarget.extend({ before: z.uuid().optional() }), p => conversations().history(p.botId, p.threadId, p.before)),
    'bots.memory.restore': method(memoryTarget.extend({ changeId: z.uuid() }), p => { conversations().restoreNote(p.botId, p.threadId, p.changeId); return {}; }),
    'bots.memory.scopes': () => ({ scopes: conversations().scopedMemory.catalog() }),
    'bots.memory.scope.read': method(scoped, ({ scope }) => {
      const store = memory(scope, 'read');
      return { notes: store.list(now().slice(0, 10)), revision: store.revision() };
    }),
    'bots.memory.scope.search': method(scoped.extend({ query: z.string().trim().min(1).max(300) }), ({ scope, query }) => ({ notes: memory(scope, 'read').search(query, now().slice(0, 10)) })),
    'bots.memory.scope.add': method(scopeWrite.extend({ text: z.string(), until: z.iso.date().optional() }), p => change(p, { op: 'add', text: p.text, until: p.until })),
    'bots.memory.scope.edit': method(scopeWrite.extend({ entryId: z.string().min(1), text: z.string() }), p => change(p, { op: 'edit', entryId: p.entryId, text: p.text })),
    'bots.memory.scope.remove': method(scopeWrite.extend({ entryId: z.string().min(1) }), p => change(p, { op: 'remove', entryId: p.entryId })),
    'bots.memory.scope.history': method(scoped.extend({ before: z.uuid().optional() }), ({ scope, before }) => {
      const page = memory(scope, 'read').historyPage(before);
      if (scope.kind !== 'bot' && scope.kind !== 'group') return page;
      return { ...page, rows: page.rows.map(row => {
        if (row.op !== 'remove' || !row.before || row.erasedEntryId) return row;
        const [entry, ...rest] = parseMemory(row.before).entries;
        return entry && !rest.length ? { ...row, erasureTarget: entryId(entry) } : row;
      }) };
    }),
    'bots.memory.scope.restore': method(scopeWrite.extend({ changeId: z.uuid() }), p => change(p, { op: 'restore', changeId: p.changeId })),
    ...(reviews && protectFormat && { 'bots.memory.scope.tidy': method(scopeWrite.extend({ botId }), p => reviews().tidy(p.botId, () => memory(p.scope, 'write'), p.expectedRevision, p.operationId, protectFormat)) }),
    ...(makePrivate && { 'bots.settings.privacy': method(privacy, async p => ({ bot: await makePrivate(p) })) }),
    ...(reviews && {
      'bots.settings.automaticReview': setAutomation('reviewEnabled'),
      'bots.settings.automaticTidy': setAutomation('tidyEnabled'),
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
      'bots.reviews.retry': method(proposal.omit({ index: true }), async p => {
        await reviews().retry(p.botId, p.threadId, p.reportId, p.operationId);
        return {};
      }),
    }),
  };
}
