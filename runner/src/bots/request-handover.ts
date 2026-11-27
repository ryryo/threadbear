import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PrimaryLink } from '../handover.ts';
import { ErrorCode, PERMISSION_MODES, RpcError, type PermissionMode } from '../protocol.ts';
import { lowerMode } from '../access.ts';
import { NAME_MAX } from './ported/requests.js';
import type { BotRequests, PublicDraft, RequestApproval } from './request-service.ts';
import type { DeliveryReceipt } from './request-receipts.ts';
import { method } from './rpc.ts';

const link = z.object({ threadId: z.uuid(), turnId: z.string().min(1).max(128), callId: z.uuid() });
const target = z.object({ threadId: z.uuid(), botId: z.uuid(), conversationId: z.uuid(), privateBotId: z.uuid().optional() });
const brief = z.string().min(1).max(30_000);
const draft = z.object({
  to: z.string().min(1).max(128), conversationId: z.uuid().optional(),
  name: z.string().min(1).max(NAME_MAX), text: brief, when: z.enum(['queue', 'now']),
});
const approval = z.object({ ceiling: z.enum(PERMISSION_MODES), sourceAccess: z.enum(PERMISSION_MODES) });

// Keep the tool's original approval callback on the process that owns its
// turn. The primary can call it only via the drain connection for this call.
export class BotRequestHandover {
  private readonly calls = new Map<string, {
    threadId: string; turnId: string; body: string; approve: RequestApproval; access: () => PermissionMode;
  }>();

  readonly authorize = method(link.extend({ target, text: brief }), async ({ threadId, turnId, callId, target: recipient, text }) => {
    const call = this.calls.get(callId);
    if (!call || call.threadId !== threadId || call.turnId !== turnId || call.body !== text) {
      throw new RpcError(ErrorCode.notAllowed, 'No matching Bot approval is outstanding for the kept turn.');
    }
    const before = call.access();
    const ceiling = await call.approve(recipient, text);
    return { ceiling, sourceAccess: lowerMode(before, call.access()) };
  });

  async send(primary: PrimaryLink, threadId: string, turnId: string, input: PublicDraft, approve: RequestApproval, access: () => PermissionMode): Promise<DeliveryReceipt> {
    const callId = randomUUID();
    this.calls.set(callId, { threadId, turnId, body: input.text, approve, access });
    try {
      return await primary.call<DeliveryReceipt>('drain.bots.request', { threadId, turnId, callId, input });
    } finally {
      this.calls.delete(callId);
    }
  }
}

export function acceptKeptBotRequest(
  requests: () => BotRequests,
  call: (threadId: string, method: string, params: Record<string, unknown>) => Promise<unknown>,
) {
  return method(link.extend({ input: draft }), ({ threadId, turnId, callId, input }) =>
    requests().sendKeptBot(threadId, turnId, input, async (recipient, text) => {
      const reply = await call(threadId, 'drain.bots.authorizeRequest', { threadId, turnId, callId, target: recipient, text });
      const permitted = approval.safeParse(reply);
      if (!permitted.success) throw new RpcError(ErrorCode.notAllowed, 'The kept Bot did not return an approval.');
      return permitted.data;
    }),
  );
}
