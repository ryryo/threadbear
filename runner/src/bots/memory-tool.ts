import { z } from 'zod';
import { MEMORY_LIMITS } from './ported/memory-entries.js';
import { botOperationId } from './repository.ts';

// bot_remember's own/Group add and expiry fields come from DS-Bot
// d104d9ca18d69a35460f14e15dff4d553181433a, src/host/memory.js.
// Apache-2.0, Fei2411 and contributors. Scope is authenticated by Threadbear.
export const rememberInput = z.object({
  text: z.string().trim().min(1).max(MEMORY_LIMITS.entry).describe('One short, lasting fact in the user’s language'),
  until: z.iso.date().optional().describe('Expiry in YYYY-MM-DD'),
  pin: z.boolean().default(false).describe('True only when the user says to always keep this'),
  operationId: botOperationId.describe('Reuse this ID if you retry the same save'),
});
export const keptRemember = z.object({ threadId: z.uuid(), turnId: z.string().min(1).max(128), input: rememberInput });
export type RememberInput = z.output<typeof rememberInput>;
