import { v } from 'convex/values';

const botProfile = v.object({
  id: v.string(), name: v.string(), role: v.string(), instructions: v.string(), revision: v.number(),
});

export const botWorkspaceProjection = v.object({
  ownerRunnerId: v.string(), workspaceId: v.string(), epoch: v.number(), profiles: v.array(botProfile),
  notes: v.array(v.object({
    scope: v.union(v.literal('bot'), v.literal('group')), scopeId: v.string(), revision: v.string(),
    rows: v.array(v.object({ id: v.string(), text: v.string(), pinned: v.boolean() })),
  })),
  tasks: v.array(v.object({ botId: v.string(), id: v.string(), threadId: v.string(), title: v.string(), status: v.string(), revision: v.number() })),
  requests: v.array(v.object({ id: v.string(), threadId: v.string(), targetThreadId: v.string(), status: v.string() })),
  groups: v.array(v.object({ id: v.string(), title: v.string(), status: v.string(), queued: v.number(),
    events: v.array(v.object({ id: v.string(), text: v.string() })),
  })),
});

export const botProfileEdit = v.object({
  workspaceId: v.string(), epoch: v.number(), botId: v.string(), expectedRevision: v.number(), operationId: v.string(),
  settings: v.object({ name: v.optional(v.string()), role: v.optional(v.string()), instructions: v.optional(v.string()) }),
});

export const botNoteScope = v.object({ kind: v.union(v.literal('bot'), v.literal('group')), id: v.string() });
export const botNoteReceipt = v.object({ workspaceId: v.string(), scope: botNoteScope, entryId: v.optional(v.string()) });
export const botNoteTarget = v.object({ workspaceId: v.string(), scope: botNoteScope, entryId: v.string() });
const noteChange = { scope: botNoteScope, expectedRevision: v.string() };

export const botDeviceAction = v.object({
  workspaceId: v.string(), epoch: v.number(), operationId: v.string(),
  action: v.union(
    v.object({ kind: v.literal('note.add'), ...noteChange, text: v.string() }),
    v.object({ kind: v.literal('note.edit'), ...noteChange, text: v.string(), entryId: v.string() }),
    v.object({ kind: v.literal('note.remove'), ...noteChange, entryId: v.string() }),
    v.object({ kind: v.literal('group.post'), groupId: v.string(), text: v.string() }),
    v.object({ kind: v.literal('task.stop'), taskId: v.string(), expectedRevision: v.number() }),
  ),
});
