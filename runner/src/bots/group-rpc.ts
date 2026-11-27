import { z } from 'zod';
import { groupDraft } from './group-store.ts';
import type { BotGroups } from './groups.ts';
import { botOperationId } from './repository.ts';
import { method } from './rpc.ts';
import { MEMORY_LIMITS } from './ported/memory-entries.js';

const id = z.object({ groupId: z.uuid() });
const write = id.extend({ expectedRevision: z.int().positive() });
const seq = z.int().positive();

export function groupMethods(groups: () => BotGroups,
  review: (groupId: string, seq: number, operationId: string, text: string) => unknown): Record<string, (input: Record<string, unknown>) => unknown> {
  return {
    'bots.groups.list': method(z.object({}), () => ({ groups: groups().store.list(), teams: groups().store.teams() })),
    'bots.groups.create': method(groupDraft.extend({ operationId: botOperationId.optional() }), ({ operationId, ...draft }) => ({ group: groups().create(draft, operationId) })),
    'bots.groups.update': method(write.extend({ changes: groupDraft.omit({ teamId: true }).partial() }),
      ({ groupId, expectedRevision, changes }) => groups().update(groupId, expectedRevision, changes)),
    'bots.groups.archive': method(write, ({ groupId, expectedRevision }) => groups().archive(groupId, expectedRevision)),
    'bots.groups.read': method(id.extend({ from: seq.optional(), to: seq.optional() }),
      ({ groupId, from, to }) => groups().read(groupId, from, to)),
    'bots.groups.find': method(id.extend({ query: z.string().trim().min(1).max(500) }),
      ({ groupId, query }) => ({ events: groups().find(groupId, query) })),
    'bots.groups.result': method(id.extend({ seq }), ({ groupId, seq }) => groups().result(groupId, seq)),
    'bots.groups.memory.approve': method(id.extend({ seq, operationId: botOperationId, text: z.string().trim().min(1).max(MEMORY_LIMITS.entry) }),
      ({ groupId, seq, operationId, text }) => review(groupId, seq, operationId, text)),
    'bots.groups.post': method(id.extend({ text: z.string().trim().min(1).max(30_000), operationId: botOperationId }),
      ({ groupId, operationId, text }) => ({ post: groups().post(groupId, operationId, text) })),
    'bots.groups.stop': method(id, ({ groupId }) => groups().stop(groupId)),
    'bots.groups.resume': method(id, ({ groupId }) => groups().resume(groupId)),
  };
}
