import { mentionSpans } from './ported/mentions.js';

// Omit quoted mentions without changing UTF-16 offsets. The imported parser
// still makes every name, boundary, link, path and code decision.
const QUOTED = /^ {0,3}>[^\n]*|"[^"\n]*"|“[^”\n]*”|「[^」\n]*」|『[^』\n]*』/gm;

export function groupMentions<T extends { name: string }>(text: string, members: readonly T[]) {
  const quotes = [...text.matchAll(QUOTED)].map(quote => ({ start: quote.index, end: quote.index + quote[0].length }));
  return mentionSpans(text, members).filter(span => !quotes.some(quote => quote.start < span.end && span.start < quote.end));
}
