import { z } from 'zod';
import { botOperationId } from './repository.ts';

const scope = z.object({ kind: z.enum(['bot', 'group']), id: z.uuid() });
const note = z.string().trim().min(1).max(300);
const revision = z.int().positive();
const draft = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('note.add'), scope, expectedRevision: z.string().min(1).max(128), text: note }),
  z.object({ kind: z.literal('note.edit'), scope, expectedRevision: z.string().min(1).max(128), text: note, entryId: z.string().min(1).max(128) }),
  z.object({ kind: z.literal('note.remove'), scope, expectedRevision: z.string().min(1).max(128), entryId: z.string().min(1).max(128) }),
  z.object({ kind: z.literal('group.post'), groupId: z.uuid(), text: z.string().trim().min(1).max(30_000) }),
  z.object({ kind: z.literal('task.stop'), taskId: z.uuid(), expectedRevision: revision }),
]);

export const deviceAction = z.object({
  workspaceId: z.uuid(), epoch: revision, operationId: botOperationId, action: draft,
});
