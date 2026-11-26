// Derived from Fei-Craft/DS-Bot d104d9ca18d69a35460f14e15dff4d553181433a.
// Copyright 2026 Fei2411 and the DS Bot contributors.
// SPDX-License-Identifier: Apache-2.0
// Modified for Threadbear: port the own-scope manual memory operations for
// MEMORY.md. The caller supplies the Bot's scope directory and decides access.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanDay, cleanEntry, EMPTY_MAIN, entryId, formatEntry, insertEntry, isExpired, isPinned,
  joinLines, looksSecret, MAIN, MEMORY_LIMITS, newEntryId, parseMemory, splitMeta, squash,
} from './memory-entries.js';
import { checkPath, MemoryJournal } from './memory-journal.js';
import { record } from './memory-pending.js';
import { rankEntries } from './memory-search.js';

function read(root, path, empty) {
  checkPath(root, path);
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return empty;
    throw error;
  }
}

function entryText(raw) {
  const text = cleanEntry(raw);
  if (!text || text.length > MEMORY_LIMITS.entry) throw new Error(`Enter a memory note up to ${MEMORY_LIMITS.entry} characters long`);
  if (looksSecret(text) || looksSecret(String(raw))) throw new Error('Memory cannot keep a value that looks like a secret');
  return text;
}

function note(entry) {
  const until = entry.meta.until;
  return { id: entryId(entry), text: entry.text, pinned: isPinned(entry), ...(until === undefined ? {} : { until }) };
}

const exactLines = (file, line) => file.entries.filter(entry => file.lines[entry.line] === line);
const entryLine = line => typeof line === 'string' && !/[\r\n]/.test(line) && /^\s*[-*]\s+\S/.test(line);

export class PersonalMemory {
  constructor(root) {
    this.storage = new MemoryJournal(root);
    this.file = join(this.storage.root, MAIN);
  }

  history() {
    this.storage.recoverPending();
    const text = read(this.storage.root, this.storage.journal, '');
    if (text === '') return [];
    return text.replace(/\n$/, '').split('\n').map((line, index) => {
      try {
        const row = JSON.parse(line);
        if (!row || typeof row !== 'object' || typeof row.id !== 'string' || row.file !== MAIN || row.scope !== 'own') {
          throw new Error('Invalid row identity');
        }
        return row;
      } catch (cause) {
        throw new Error(`Could not read memory history row ${index + 1}`, { cause });
      }
    }).reverse();
  }

  load() {
    this.storage.recoverPending();
    return parseMemory(read(this.storage.root, this.file, EMPTY_MAIN));
  }

  list(today) {
    return this.load().entries.filter(entry => !isExpired(entry, today)).map(note);
  }

  search(query, today) {
    const entries = this.load().entries.filter(entry => !isExpired(entry, today));
    return rankEntries(entries, query).slice(0, 50).map(({ entry }) => note(entry));
  }

  publish(op, lines, time, extra) {
    const text = joinLines(lines);
    if (text.length > MEMORY_LIMITS.bot) throw new Error('This Bot’s main memory is full');
    const scope = 'own';
    this.storage.publish(record({
      id: randomUUID(), time, op, scope, steps: [{ action: 'write', path: MAIN, text }],
      row: { op, scope, file: MAIN, actor: 'user', ...extra },
    }));
  }

  add(raw, { until, sourceThreadId }, time) {
    this.history();
    const text = entryText(raw);
    if (until !== undefined && (typeof until !== 'string' || cleanDay(until) !== until)) {
      throw new Error('Enter an expiry date as YYYY-MM-DD');
    }
    const file = this.load();
    const same = file.entries.find(entry => squash(entry.text) === squash(text));
    if (same !== undefined) return note(same);
    const meta = { id: newEntryId(file.entries), pinned: 'yes', added: time.slice(0, 10), until };
    const line = formatEntry(text, meta);
    this.publish('add', insertEntry(file.lines, line), time, { after: line, sourceThreadId });
    return note({ text, meta });
  }

  replace(id, raw, time) {
    this.history();
    const file = this.load();
    const old = this.find(file, id);
    const text = entryText(raw);
    if (file.entries.some(entry => entry.line !== old.line && squash(entry.text) === squash(text))) {
      throw new Error('This note already exists');
    }
    const meta = { ...old.meta, id: entryId(old) };
    const line = formatEntry(text, meta);
    const before = file.lines[old.line];
    if (line !== before) {
      if (looksSecret(before)) throw new Error('Memory history cannot keep a value that looks like a secret');
      const lines = [...file.lines];
      lines[old.line] = line;
      this.publish('replace', lines, time, { before, after: line });
    }
    return note({ text, meta });
  }

  find(file, id) {
    const found = file.entries.filter(entry => entryId(entry) === id);
    if (found.length !== 1) throw new Error('This note no longer identifies a single memory entry');
    return found[0];
  }

  remove(id, time) {
    this.history();
    const file = this.load();
    const old = this.find(file, id);
    const before = file.lines[old.line];
    if (looksSecret(before)) throw new Error('Memory history cannot keep a value that looks like a secret');
    const lines = file.lines.filter((_line, index) => index !== old.line);
    this.publish('remove', lines, time, { before });
  }

  restore(id, time) {
    const rows = this.history();
    const row = rows.find(change => change.id === id);
    if (!row || !['add', 'replace', 'remove'].includes(row.op)) throw new Error('This change is not in the memory history');
    if (rows.some(change => change.restored === id)) throw new Error('This change is already restored');
    const file = this.load();
    let back;
    if (row.op !== 'add') {
      if (!entryLine(row.before)) throw new Error('This history row cannot be restored');
      entryText(splitMeta(row.before.replace(/^\s*[-*]\s+/, '')).text);
      if (looksSecret(row.before)) throw new Error('Memory cannot restore a value that looks like a secret');
      [back] = parseMemory(row.before).entries;
    }
    const occupied = (skip) => file.entries.some(entry => entry.line !== skip && (entryId(entry) === entryId(back) || squash(entry.text) === squash(back.text)));
    if (row.op === 'remove') {
      if (occupied(undefined)) throw new Error('The note removed by this change already exists');
      this.publish('add', insertEntry(file.lines, row.before), time, { after: row.before, restored: id });
      return;
    }
    const found = exactLines(file, row.after);
    if (found.length !== 1) throw new Error('The note may have changed or been removed since this change');
    if (looksSecret(row.after)) throw new Error('Memory history cannot keep a value that looks like a secret');
    const lines = [...file.lines];
    const index = found[0].line;
    if (row.op === 'replace') {
      if (occupied(index)) throw new Error('The note before this change already exists');
      lines[index] = row.before;
      this.publish('replace', lines, time, { before: row.after, after: row.before, restored: id });
    } else {
      lines.splice(index, 1);
      this.publish('remove', lines, time, { before: row.after, restored: id });
    }
  }
}
