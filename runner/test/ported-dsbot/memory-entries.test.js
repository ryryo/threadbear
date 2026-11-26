// Derived from Fei-Craft/DS-Bot, d104d9ca18d69a35460f14e15dff4d553181433a,
// ds-bot/test/memory.test.js. Copyright 2026 Fei2411 and the DS Bot contributors.
// SPDX-License-Identifier: Apache-2.0
// Modified for Threadbear: select the standalone memory format tests and update imports.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addLink, cleanEntry, cleanTopic, formatEntry, insertEntry, looksLikeKey,
  looksSecret, matchEntries, parseMemory, removeLink, splitMeta,
} from '../../src/bots/ported/memory-entries.js';

test('entries carry their metadata at the end of the line, as Agent Memory Repo writes it', () => {
  assert.deepEqual(splitMeta('Prefers tea [source: part 2 #14; by: Chief; added: 2026-10-09]'), {
    text: 'Prefers tea', meta: { source: 'part 2 #14', by: 'Chief', added: '2026-10-09' },
  })
  // Brackets that are not metadata stay in the text.
  assert.deepEqual(splitMeta('Uses [[travel]] notes [draft]'), { text: 'Uses [[travel]] notes [draft]', meta: {} })
  assert.equal(formatEntry('Prefers tea', { source: 'part 1 #3', by: '', added: '2026-10-09' }), '- Prefers tea [source: part 1 #3; added: 2026-10-09]')
  assert.equal(formatEntry('x', { source: 'a; b [c]' }), '- x [source: a b c]')
  assert.equal(cleanEntry('  - * Likes  short\nreplies [source: forged] '), 'Likes short replies')
  assert.equal(cleanTopic(' [[Project X.md]] '), 'project-x')
  assert.equal(cleanTopic('旅行'), '旅行')
  for (const bad of ['', '../etc', 'a/b', 'memory', '-x', 'x'.repeat(49)]) assert.equal(cleanTopic(bad), undefined, bad)
})

test('the Index holds topic links; entries above it, and hand-written lines, stay put', () => {
  const text = '# Memory\n\nA note by hand.\n\n- One [added: 2026-10-01]\n\n## Index\n- [[travel]]\n'
  const parsed = parseMemory(text)
  assert.deepEqual(parsed.entries.map(entry => [entry.line, entry.text]), [[4, 'One']])
  assert.deepEqual(parsed.links, ['travel'])
  const added = insertEntry(parsed.lines, '- Two')
  assert.deepEqual(added, ['# Memory', '', 'A note by hand.', '', '- One [added: 2026-10-01]', '- Two', '', '## Index', '- [[travel]]'])
  assert.deepEqual(insertEntry(['# Memory', '', '## Index'], '- First'), ['# Memory', '', '- First', '', '## Index'])
  assert.deepEqual(insertEntry(['# travel'], '- Fly'), ['# travel', '', '- Fly'])
  assert.deepEqual(addLink(added, 'work'), [...added, '- [[work]]'])
  assert.deepEqual(addLink(['# Memory', '', '- One'], 'work'), ['# Memory', '', '- One', '', '## Index', '- [[work]]'])
  assert.deepEqual(removeLink(addLink(added, 'work'), 'travel'), [...added.slice(0, -1), '- [[work]]'])
})

test('a request names one entry by its text, or by a part only it has', () => {
  const entries = parseMemory('- Likes tea\n- Likes green tea\n- Lives in Hangzhou\n').entries
  assert.deepEqual(matchEntries(entries, 'likes tea').map(entry => entry.text), ['Likes tea'])
  assert.deepEqual(matchEntries(entries, 'tea').map(entry => entry.text), ['Likes tea', 'Likes green tea'])
  assert.deepEqual(matchEntries(entries, 'hangzhou').map(entry => entry.text), ['Lives in Hangzhou'])
  assert.deepEqual(matchEntries(entries, '  '), [])
})

test('keys are refused, while paths, names, and links are kept', () => {
  for (const key of ['sk-' + 'abcdefghijklmnopqrstuv', 'ghp_abcdefghijklmnopqrstuvwxyz12', 'AKIA' + 'ABCDEFGHIJKLMNOP', 'token aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3f']) assert.equal(looksLikeKey(key), true, key)
  for (const fine of ['The repo is ~/repos/dsbot/ds-bot/src/host', 'Doc: https://docs.example.com/d/aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3f/edit', 'Uses deepseek-v4-flash for drafts', '用户喜欢简短的回答']) assert.equal(looksLikeKey(fine), false, fine)
  // Passwords given as such, and ID or card numbers, are secrets too.
  for (const secret of ['测试服务器的 root 密码是 hunter2-prod', 'The root password is hunter2', 'pwd: x', '身份证号 330106199001011234', 'card 6222 0212 3456 7890', 'the password for root is hunter2', 'The user\'s ATM PIN is 1234', 'passcode is 654321', '验证码是 123456', 'the CVV is 123', 'staging password remains hunter2', 'root 的密码还是 hunter2', 'the db password was changed to s3cret', 'card 6222-0212-3456-7890', 'Amex 3714-496353-98431', '身份证 330106-19900101-1234', 'I use hunter2 as my password', 'Use 654321 for the PIN', 'The user uses s3cret as the staging root password', '我的密码用 hunter2', '我用 hunter2 当密码', '用 abc123 作为服务器密码', 'I use correct horse battery staple as my password', 'Use six five four three two one for the PIN', '我用 correct horse battery staple 当密码', 'The user\'s SSN is 123-45-6789', 'passport number is A12345678', '护照号E12345678', 'driver\'s license D1234567']) assert.equal(looksSecret(secret), true, secret)
  for (const fine of ['用户不想把密码存进记忆', 'Trip on 2026-11-15, back 2026-11-17', 'The user keeps passwords in a password manager, which is 1Password', '用户的密码管理器是 1Password', 'The user pins the sidebar', 'Pin the tab, it is handy', 'The user uses 1Password for passwords', 'Uses Bitwarden as the password manager', 'Use the PIN pad on the left', '密码用 1Password 管理', '密码不能告诉用户', '密码用于登录', '用 1Password 作为密码管理器', 'Uses Tab for the password field', 'The user uses Vim for editing and Rust for work', 'The user\'s passport expires 2027-05-01', 'Passport renewed 2026-11-15, flight 2026-11-17', 'ID card photo, call 138 0013 8000', '密码不能明文保存因为不安全', 'Off 2026-11-15 2026-11-17', '电话 138-0013-8000', '手机 138 0013 8000 是工作号', 'Issue https://x.test/a/1234567890123456789']) assert.equal(looksSecret(fine), false, fine)
})
