import { randomUUID } from 'node:crypto';
import type { PermissionMode } from '../protocol.ts';
import type { DeliveryReceipt, RequestReceipts } from './request-receipts.ts';
import type { RequestRow, RequestStateStore } from './request-state.ts';

export type RequestLink = { botId: string; threadId: string; conversationId: string; privateBotId?: string };
export type RequestActor = { kind: 'owner'; source: RequestLink } | { kind: 'bot'; source: RequestLink };
export type RequestDraft = { to: string; conversationId?: string; name: string; text: string; when: 'queue' | 'now'; parentRequestId?: string; rerunOf?: string };
type Dispatch = (row: RequestRow, text: string, actor: RequestActor) => Pick<DeliveryReceipt, 'turnId' | 'when'>;
type Ports = {
  receipts: RequestReceipts;
  requests: RequestStateStore;
  target: (botId: string, preferred?: string) => RequestLink;
  canSteer: (link: RequestLink) => boolean;
  dispatch: Dispatch;
  isoNow: () => string;
};

export type AuthorizeRequest = (actor: RequestActor, target: RequestLink, text: string) => Promise<void | { ceiling: PermissionMode; returnCeiling: PermissionMode }>;

export class BotRequestDispatch {
  private readonly ports: Ports;
  constructor(ports: Ports) { this.ports = ports; }

  async send(actor: RequestActor, input: RequestDraft, authorize: AuthorizeRequest): Promise<DeliveryReceipt> {
    const { receipts, requests, target, canSteer, isoNow, dispatch } = this.ports;
    const { source } = actor;
    // Fingerprint the requested destination. The previous receipt keeps the
    // chosen conversation even if that Bot now has another default.
    const identity = receipts.identity({
      caller: actor.kind === 'owner' ? 'owner' : source.botId,
      context: source.conversationId, name: input.name,
      payload: { to: input.to, conversationId: input.conversationId, text: input.text, when: input.when, parentRequestId: input.parentRequestId, rerunOf: input.rerunOf },
    });
    const previous = await receipts.known(identity);
    if (previous && 'receipt' in previous) return previous.receipt;
    if (previous !== undefined) throw new Error(this.receiptError(previous.status));
    const chosen = target(input.to, input.conversationId);
    const limits = await authorize(actor, chosen, input.text);
    const outcome = await receipts.admit(identity, async () => {
      // Revalidate the chosen conversation by id after the approval. Never
      // use a newly selected default while the owner was reading a card.
      let row: RequestRow;
      let current: RequestLink;
      try {
        current = target(chosen.botId, chosen.conversationId);
        if (current.threadId !== chosen.threadId || current.privateBotId !== chosen.privateBotId) throw new Error('The recipient changed while this request was being approved');
        row = requests.admit({
          id: randomUUID(), sourceBotId: actor.kind === 'bot' ? source.botId : undefined,
          sourceThreadId: source.threadId, sourceConversationId: source.conversationId,
          targetThreadId: current.threadId, targetConversationId: current.conversationId, targetBotId: current.botId,
          parentRequestId: input.parentRequestId, rerunOf: input.rerunOf, acceptedAt: isoNow(),
          sourcePrivateBotId: source.privateBotId, targetPrivateBotId: current.privateBotId,
          ...(limits ?? {}),
          when: input.when === 'now' && canSteer(current) ? 'now' : 'queue',
        });
      } catch (reason) {
        return { reason };
      }
      try {
        // This port commits the recipient input in ThreadStore before it
        // returns. An I/O error can mean a delivery happened; do not resend.
        const { turnId, when } = dispatch(row, input.text, actor);
        requests.acceptDelivery(row.id, row.revision, turnId, when);
        return { requestId: row.id, threadId: row.targetThreadId, turnId, when };
      } catch (error) {
        try { requests.advance(row.id, row.revision, { status: 'uncertain', reason: 'The Runner could not confirm delivery' }); }
        catch { /* The earlier durable state still needs reconciliation. */ }
        throw error;
      }
    });
    if ('receipt' in outcome) return outcome.receipt;
    if (outcome.status === 'refused') throw outcome.reason;
    throw new Error(this.receiptError(outcome.status));
  }

  private receiptError(status: 'expired' | 'conflict' | 'uncertain' | 'readonly'): string {
    switch (status) {
      case 'conflict': return 'This request name was already used for a different request';
      case 'uncertain': return 'The previous delivery is uncertain. Check its state before creating another request.';
      case 'expired': return 'The old receipt is no longer available. This request name cannot be reused.';
      case 'readonly': return 'The Runner does not own this Bot workspace';
    }
  }
}
