import { ErrorCode, RpcError } from '../protocol.ts';
import type { EventLog } from '../store.ts';

export function activeBotInput(log: Pick<EventLog, 'lastSeq' | 'read'>, turnId: string) {
  const pageSize = 200;
  for (let through = log.lastSeq; through > 0; through -= pageSize) {
    const events = log.read(Math.max(1, through - pageSize + 1), through);
    for (const event of events.reverse()) {
      if (event.turnId !== turnId) continue;
      if (event.type === 'turn.completed') throw ended();
      if (event.type === 'user.message') return event;
    }
  }
  throw ended();
}

const ended = () => new RpcError(ErrorCode.moved, 'The Bot no longer has that active turn.');
