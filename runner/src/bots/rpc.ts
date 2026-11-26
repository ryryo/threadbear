import { z } from 'zod';
import { ErrorCode, RpcError } from '../protocol.ts';
import type { BotConversations } from './conversations.ts';
import type { BotRepository } from './repository.ts';

const botId = z.uuid();
const identity = z.object({ botId });
const settings = z.object({ name: z.string().min(1), role: z.string().optional(), instructions: z.string().optional() });
const memoryTarget = identity.extend({ threadId: z.uuid() });

function method<T>(schema: z.ZodType<T>, run: (p: T) => unknown): (p: Record<string, unknown>) => unknown {
  return (p) => {
    const input = schema.safeParse(p);
    if (!input.success) throw new RpcError(ErrorCode.badParams, `Invalid Bot parameters: ${input.error.issues.map(issue => issue.path.join('.')).join(', ')}`);
    return run(input.data);
  };
}

export function botMethods(repo: BotRepository, conversations: BotConversations): Record<string, (p: Record<string, unknown>) => unknown> {
  return {
    'bots.list': () => ({ bots: repo.list() }),
    'bots.get': method(identity, ({ botId }) => ({ bot: repo.get(botId), conversations: repo.conversations(botId) })),
    'bots.create': method(settings, p => ({ bot: repo.create(p) })),
    'bots.update': method(settings.partial().extend({ botId, expectedRevision: z.int().positive() }), ({ botId, expectedRevision, ...p }) => ({ bot: repo.update(botId, expectedRevision, p) })),
    'bots.archive': method(identity.extend({ expectedRevision: z.int().positive() }), p => ({ bot: conversations.archive(p.botId, p.expectedRevision) })),
    'bots.conversations.create': method(identity.extend({ operationId: z.string().min(1).max(128) }), p => ({ conversation: conversations.create(p.botId, p.operationId) })),
    'bots.memory.read': method(memoryTarget, p => ({ notes: conversations.notes(p.botId, p.threadId) })),
    'bots.memory.add': method(memoryTarget.extend({ text: z.string(), until: z.iso.date().optional() }), p => ({ note: conversations.remember(p.botId, p.threadId, p.text, p.until) })),
    'bots.memory.edit': method(memoryTarget.extend({ entryId: z.string().min(1), text: z.string() }), p => ({ note: conversations.editNote(p.botId, p.threadId, p.entryId, p.text) })),
    'bots.memory.remove': method(memoryTarget.extend({ entryId: z.string().min(1) }), p => { conversations.removeNote(p.botId, p.threadId, p.entryId); return {}; }),
    'bots.memory.history': method(memoryTarget.extend({ before: z.uuid().optional() }), p => conversations.history(p.botId, p.threadId, p.before)),
    'bots.memory.restore': method(memoryTarget.extend({ changeId: z.uuid() }), p => { conversations.restoreNote(p.botId, p.threadId, p.changeId); return {}; }),
  };
}
