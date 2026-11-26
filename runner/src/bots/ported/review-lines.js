// Derived from Fei-Craft/DS-Bot d104d9ca18d69a35460f14e15dff4d553181433a.
// Copyright 2026 Fei2411 and the DS Bot contributors.
// SPDX-License-Identifier: Apache-2.0
// Extracted from memory-review.js for ThreadStore. Count prompt line breaks too.

const REVIEW_TEXT_MAX = 16_000
const REVIEW_USER_LINE_MAX = 3_000
const REVIEW_OTHER_LINE_MAX = 800

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)} …(cut)` : text)
// A long message often ends with what the user wants of it, so both ends stay.
const ends = (text, max) => (text.length > max ? `${text.slice(0, Math.ceil(max * 2 / 3))} …(middle cut)… ${text.slice(-Math.floor(max / 3))}` : text)

// Lines say who spoke. The user's lines are kept longest: what they say is what
// the review keeps; the rest is there to make it understood.
const reviewLine = (who, text, bot) => (who === 'user'
  ? ends(text, REVIEW_USER_LINE_MAX)
  : clip(who === 'you' ? `${bot.name}: ${text.replace(/^You: /, '')}` : text, REVIEW_OTHER_LINE_MAX))

// The oldest new lines that fit; the rest waits for the next pass.
export function fitted(lines, bot) {
  const kept = []
  let used = 0
  for (const line of lines) {
    const text = line.formatted === true ? line.text : reviewLine(line.who, line.text, bot)
    const length = text.length + (kept.length === 0 ? 0 : 1)
    if (kept.length > 0 && used + length > REVIEW_TEXT_MAX) break
    kept.push(text)
    used += length
  }
  return { texts: kept, count: kept.length }
}
