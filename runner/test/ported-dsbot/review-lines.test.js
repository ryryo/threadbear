// Derived from Fei-Craft/DS-Bot d104d9ca18d69a35460f14e15dff4d553181433a.
// Copyright 2026 Fei2411 and the DS Bot contributors.
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test'
import assert from 'node:assert/strict'
import { writtenIn } from '../../src/bots/ported/memory-copy.js'
import { fitted } from '../../src/bots/ported/review-lines.js'

test('the memory review writes entries in the language of the user\'s lines', () => {
  assert.equal(writtenIn(['帮我写个函数。我们项目用 TypeScript，包管理只用 pnpm，别给我 npm 命令。'], 'x'), 'Chinese (简体中文)')
  assert.equal(writtenIn(['Use pnpm, not npm'], 'x'), 'English')
  assert.equal(writtenIn(['Rename it to 订单 service please, the old one is wrong'], 'x'), 'x')
  assert.equal(writtenIn(['👍'], 'x'), 'x')
})

test('the memory review keeps Japanese with English project names', () => {
  assert.equal(writtenIn(['Threadbearでは見出しを短くする。'], 'x'), 'Japanese (日本語)')
  assert.equal(writtenIn(['Switch to the み view; the current screen needs updating'], 'x'), 'English')
})

test('a long user message keeps both ends for the review', () => {
  const long = `User: Background ${'x'.repeat(5000)} From now on, always answer in English.`
  const { texts } = fitted([{ who: 'user', text: long }], { name: 'Writer' })
  assert.match(texts[0], /^User: Background x+ …\(middle cut\)… x+ From now on, always answer in English\.$/)
  assert.ok(texts[0].length < 3_400)
})

test('a backlog past the text limit leaves the newest lines for the next pass', () => {
  const lines = Array.from({ length: 8 }, (_, i) => ({ who: 'user', text: `User ${i}: ${'x'.repeat(3_500)}` }))
  const { texts, count } = fitted(lines, { name: 'Writer' })
  assert.equal(count, 5)
  assert.equal(texts.length, count)
  assert.match(texts[0], /^User 0:/)
  assert.match(texts[count - 1], /^User 4:/)
  assert.ok(texts.join('\n').length <= 16_000)
})
