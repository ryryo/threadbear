// Adapt the full-result and missing-result checks from DS-Bot
// d104d9ca18d69a35460f14e15dff4d553181433a, ds-bot/src/host/handoffs.js.
// Copyright 2026 Fei2411 and the DS Bot contributors. Apache-2.0.
import { createHash } from 'node:crypto';
import { headOf, TEXT_KEPT } from './ported/result-text.js';

const fingerprint = (text: string) => createHash('sha256').update(text).digest('hex');
type ResultSource = { threadId: string; seq: number };
export type KeptResult = { text: string; source: ResultSource; length?: number; hash?: string };

// The existing ThreadStore owns the full event. The request journal
// only needs the event reference and the same bounded preview as DS-Bot.
export function keepResult(source: ResultSource, text: string): KeptResult {
  if (text.length <= TEXT_KEPT) return { source, text };
  return { source, text: headOf(text, TEXT_KEPT).toWellFormed(), length: text.length, hash: fingerprint(text) };
}

export function resultText(result: KeptResult, read: (source: ResultSource) => string | undefined): { text: string; whole: boolean } {
  if (result.length === undefined) return { text: result.text, whole: true };
  const text = read(result.source);
  if (text !== undefined && text.length === result.length && fingerprint(text) === result.hash) return { text, whole: true };
  return { text: result.text, whole: false };
}
