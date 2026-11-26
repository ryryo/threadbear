import type { EventBody } from '../protocol.ts';

export type ReviewLine = { who: 'user' | 'you'; text: string; seq: number };

function unquoted(text: string): string {
  let fence: string | undefined;
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (fence === undefined) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence === undefined && !/^\s*>/.test(line)) lines.push(line);
  }
  return lines.join('\n').trim();
}

// Adapt the source roles in DS-Bot's memory-review.js to ThreadStore events.
// An owner-looking prefix is only text. Tool results have no role here.
export function reviewLineOf(event: EventBody & { seq: number }, conversationId: string, redact: (text: string) => string): ReviewLine | undefined {
  if (event.type === 'user.message' && event.botInput?.conversationId === conversationId && event.botInput.source.kind === 'owner') {
    const text = unquoted(redact(event.text));
    if (text) return { who: 'user', text: `User: ${text}`, seq: event.seq };
  }
  if (event.type === 'assistant.text' && !event.summary && !event.narration) {
    const text = unquoted(redact(event.text));
    if (text) return { who: 'you', text, seq: event.seq };
  }
  return undefined;
}
