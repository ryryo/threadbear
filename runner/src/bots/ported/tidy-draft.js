// Derived from Fei-Craft/DS-Bot d104d9ca18d69a35460f14e15dff4d553181433a.
// Copyright 2026 Fei2411 and the DS Bot contributors.
// SPDX-License-Identifier: Apache-2.0
// Extracted from memory-tidy.js. The owning Runner supplies the authorized
// scope, resolves the model request, and publishes the returned file changes.


import { HEADING, MAIN, addLink, cleanEntry, cleanTopic, entryId, formatEntry, insertEntry, joinLines, parseMemory, removeLink } from './memory-entries.js'

const SHARE_MAX = 5
const NOTE_MAX = 120

export function parseTidy(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  try {
    const value = JSON.parse(text.slice(start, end + 1))
    return Array.isArray(value?.changes) ? value.changes : undefined
  } catch {
    return undefined
  }
}


export function draftTidy({ files, offered, changes, numbered, ended, batch, time, entryProblem, scrub }) {
  const byId = new Map(offered.map(entry => [entryId(entry), entry]))
  const draft = new Map(files.map(file => [file.file, [...file.lines]]))
  const main = files[0]
  const budget = { left: Math.max(1, Math.floor(offered.length / SHARE_MAX)) }
  const retired = []
  const items = []
  const counts = { merged: 0, moved: 0, retired: 0 }
  const take = (entry) => { draft.set(entry.file.file, draft.get(entry.file.file).filter(line => line !== entry.file.lines[entry.line])) }
  const retire = (entry, why, extra = {}) => retired.push({ batch, time, file: entry.file.file, line: entry.file.lines[entry.line], why, ...extra })
  const unchanged = (expected) => {
    if (expected === undefined) return undefined
    const current = byId.get(entryId(expected))
    if (current?.file.file === expected.file.file && current.file.lines[current.line] === expected.file.lines[expected.line]) return current
    return undefined
  }
  const pick = at => unchanged(numbered[Number(at) - 1])
  const used = new Set()

  for (const expected of ended) {
    const entry = unchanged(expected)
    if (entry === undefined) continue
    take(entry)
    retire(entry, 'ended')
    used.add(entry)
    counts.retired += 1
    items.push({ op: 'retired', text: entry.text })
  }

  for (const change of changes) {
    const op = String(change?.op ?? '')
    if (op === 'about') {
      const name = cleanTopic(change.topic)
      const lines = draft.get(`${name}.md`)
      const text = cleanEntry(change.text).slice(0, NOTE_MAX)
      if (name === undefined || lines === undefined || text === '' || entryProblem(text) !== undefined) continue
      const title = lines.findIndex(line => HEADING.test(line))
      const kept = lines.filter(line => !/^>\s*\S/.test(line))
      kept.splice(title + 1, 0, '', `> ${text}`)
      draft.set(`${name}.md`, kept)
      continue
    }
    if (op === 'merge') {
      const entries = [...new Set((Array.isArray(change.entries) ? change.entries : []).map(pick))]
      if (entries.some(entry => entry === undefined || used.has(entry))) continue
      const text = cleanEntry(change.text)
      if (entries.length < 2 || entries.length > budget.left || entryProblem(text) !== undefined) continue
      budget.left -= entries.length
      const [first, ...rest] = entries
      const line = formatEntry(text, { ...first.meta, id: entryId(first), merged: entries.map(entryId).join(' ') })
      draft.set(first.file.file, draft.get(first.file.file).map(item => (item === first.file.lines[first.line] ? line : item)))
      rest.forEach(take)
      entries.forEach(entry => { retire(entry, 'merged', { into: entryId(first) }); used.add(entry) })
      counts.merged += entries.length
      items.push({ op: 'merged', text })
      continue
    }
    const entry = pick(change?.entry)
    if (entry === undefined || used.has(entry) || budget.left < 1) continue
    if (op === 'retire') {
      budget.left -= 1
      take(entry)
      retire(entry, scrub(String(change.why ?? '')).slice(0, NOTE_MAX) || 'retired')
      used.add(entry)
      counts.retired += 1
      items.push({ op: 'retired', text: entry.text })
    } else if (op === 'move' && entry.file.topic === undefined) {
      const name = cleanTopic(change.topic)
      if (name === undefined) continue
      budget.left -= 1
      const line = entry.file.lines[entry.line]
      take(entry)
      const base = draft.get(`${name}.md`) ?? parseMemory(`# ${name}\n`).lines
      draft.set(`${name}.md`, insertEntry(base, line))
      if (!parseMemory(joinLines(draft.get(MAIN))).links.includes(name)) draft.set(MAIN, addLink(draft.get(MAIN), name))
      used.add(entry)
      counts.moved += 1
      items.push({ op: 'moved', text: entry.text, topic: name })
    }
  }

  const touched = []
  const before = new Map(files.map(file => [file.file, file.content]))
  for (const [file, lines] of draft) {
    const emptied = file !== MAIN && lines.every(line => line.trim() === '' || HEADING.test(line) || /^>\s/.test(line))
    const was = before.get(file) ?? null
    const now = emptied ? null : lines.length === 0 ? '' : joinLines(lines)
    if (was === now || (was === '' && lines.length === 0)) continue
    touched.push({ file, before: was, after: now })
  }
  for (const item of touched.filter(entry => entry.after === null)) {
    const name = item.file.slice(0, -3)
    const lines = removeLink(draft.get(MAIN), name)
    draft.set(MAIN, lines)
  }
  const mainNow = joinLines(draft.get(MAIN))
  const mainItem = touched.find(item => item.file === MAIN)
  if (mainItem !== undefined) mainItem.after = mainNow
  else if (main.content !== mainNow && main.lines.length > 0) touched.push({ file: MAIN, before: main.content, after: mainNow })
  return { touched, retired, items, counts }
}
