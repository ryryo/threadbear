import { v } from 'convex/values';

export const botScheduleTarget = v.union(
  v.object({ kind: v.literal('conversation'), botId: v.string(), conversationId: v.string(), threadId: v.string() }),
  v.object({ kind: v.literal('newConversation'), botId: v.string() }),
  v.object({ kind: v.literal('group'), groupId: v.string() }),
);
