// Derived from Fei-Craft/DS-Bot d104d9ca18d69a35460f14e15dff4d553181433a.
// Copyright 2026 Fei2411 and the DS Bot contributors.
// SPDX-License-Identifier: Apache-2.0
// Modified for Threadbear: port the own-scope manual memory operations for
// MEMORY.md. The caller supplies the Bot's scope directory and decides access.

import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanDay, cleanEntry, cleanTopic, EMPTY_MAIN, entryId, formatEntry, insertEntry, isExpired, isPinned,
  joinLines, looksSecret, MAIN, MEMORY_LIMITS, newEntryId, parseMemory, splitMeta, squash,
} from './memory-entries.js';
import { checkPath, MemoryJournal } from './memory-journal.js';
import { record } from './memory-pending.js';
import { rankEntries } from './memory-search.js';
import { draftTidy, parseTidy } from './tidy-draft.js';
import { eraseMemoryCopies } from '../memory-erasure.js';

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
  const topic = entry.file?.topic;
  return { id: entryId(entry), text: entry.text, pinned: isPinned(entry), ...(until === undefined ? {} : { until }), ...(topic ? { topic } : {}) };
}

const exactLines = (file, line) => file.entries.filter(entry => file.lines[entry.line] === line);
const entryLine = line => typeof line === 'string' && !/[\r\n]/.test(line) && /^\s*[-*]\s+\S/.test(line);
const memoryFile = file => file === MAIN || (typeof file === 'string' && cleanTopic(file) !== undefined && file === `${cleanTopic(file)}.md`);

function backupEntry(source) {
  const saved = parseMemory(source.line);
  const [entry] = saved.entries;
  if (!memoryFile(source.file) || /[\r\n]/.test(source.line) || saved.entries.length !== 1 || entryId(entry) !== source.entryId) {
    throw new Error('The backup does not contain the selected memory note');
  }
  entryText(entry.text);
  return entry;
}

export class PersonalMemory {
  constructor(root, { scope = 'own', base = root, redact = value => value } = {}) {
    this.scope = scope;
    this.base = base;
    this.redact = redact;
    this.storage = new MemoryJournal(root);
  }

  refuseSecret(text) {
    if (looksSecret(text) || this.redact(text) !== text) throw new Error('Memory cannot keep a secret');
  }

  history() {
    checkPath(this.base, this.storage.root);
    this.storage.recoverPending();
    const text = read(this.storage.root, this.storage.journal, '');
    if (text === '') return [];
    return text.replace(/\n$/, '').split('\n').map((line, index) => {
      try {
        const row = JSON.parse(line);
        if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !memoryFile(row.file) || row.scope !== this.scope) {
          throw new Error('Invalid row identity');
        }
        return row;
      } catch (cause) {
        throw new Error(`Could not read memory history row ${index + 1}`, { cause });
      }
    }).reverse();
  }

  historyPage(before) {
    const rows = this.history();
    const at = before === undefined ? 0 : rows.findIndex(row => row.id === before) + 1;
    if (before !== undefined && at === 0) return { rows: [], more: null };
    const page = rows.slice(at, at + 50);
    return { rows: page, more: at + page.length < rows.length ? page.at(-1).id : null };
  }

  revision() { return this.history()[0]?.id ?? 'empty'; }

  lastErasure() { return this.history().find(row => row.op === 'erase')?.id; }

  change(mutation, operationId, expectedRevision, time, source) {
    // Steered input can add a later event to the same active turn. A replay
    // keeps the first saved source event for that operation.
    const { sourceSeq: _sourceSeq, ...identity } = source ?? {};
    const hash = createHash('sha256').update(JSON.stringify(source ? { mutation, source: identity } : mutation)).digest('hex');
    const history = this.history();
    const seen = history.find(row => row.transaction?.operationId === operationId);
    if (seen) {
      if (seen.transaction.hash !== hash) throw new Error('The operation id already belongs to a different change');
      return { revision: seen.id, ...(seen.transaction.note ? { note: seen.transaction.note } : {}) };
    }
    if ((mutation.op === 'edit' || mutation.op === 'remove') &&
        history.some(row => row.op === 'erase' && row.entryId === mutation.entryId)) {
      throw Object.assign(new Error('This memory note was permanently erased'), { code: 'memory/erased' });
    }
    if ((history[0]?.id ?? 'empty') !== expectedRevision) throw new Error('These notes changed. Reload the current notes before saving.');
    const transaction = { operationId, hash };
    let result;
    switch (mutation.op) {
      case 'add': result = this.add(mutation.text, { until: mutation.until, ...source }, time, transaction); break;
      case 'edit': result = this.replace(mutation.entryId, mutation.text, time, transaction); break;
      case 'remove': this.remove(mutation.entryId, time, transaction); break;
      case 'restore': this.restore(mutation.changeId, time, transaction); break;
      default: throw new Error('Unknown memory change');
    }
    return { revision: this.revision(), ...(result ? { note: result } : {}) };
  }

  load(file = MAIN) {
    if (!memoryFile(file)) throw new Error('Invalid memory file name');
    checkPath(this.base, this.storage.root);
    this.storage.recoverPending();
    const content = read(this.storage.root, join(this.storage.root, file), file === MAIN ? EMPTY_MAIN : null);
    return { ...parseMemory(content), file, content, ...(file === MAIN ? {} : { topic: cleanTopic(file) }) };
  }

  files() {
    const main = this.load();
    return [main, ...[...new Set(main.links)].slice(0, MEMORY_LIMITS.topics).map(topic => this.load(`${topic}.md`)).filter(file => file.content !== null)];
  }

  allEntries(files = this.files()) { return files.flatMap(file => file.entries.map(entry => ({ ...entry, file }))); }

  list(today) {
    return this.allEntries().filter(entry => !isExpired(entry, today)).map(note);
  }

  search(query, today) {
    const entries = this.allEntries().filter(entry => !isExpired(entry, today));
    return rankEntries(entries, query).slice(0, 50).map(({ entry }) => note(entry));
  }

  publish(op, lines, time, extra, file = MAIN) {
    const text = joinLines(lines);
    const scope = this.scope;
    const limit = file !== MAIN ? MEMORY_LIMITS.topic : scope === 'team' || scope === 'group' ? MEMORY_LIMITS[scope] : MEMORY_LIMITS.bot;
    if (text.length > limit) throw new Error('This scope’s main memory is full');
    this.storage.publish(record({
      id: randomUUID(), time, op, scope, steps: [{ action: 'write', path: file, text }],
      row: { op, scope, file, actor: 'user', ...extra },
    }));
  }

  nextEntryId(entries, history) {
    const erased = history.filter(row => row.op === 'erase').map(row => ({ meta: { id: row.entryId } }));
    // The original short IDs have a finite namespace. A longer ID stays
    // addressable by the existing metadata parser once that space is full.
    return entries.length + erased.length < 65_536 ? newEntryId([...entries, ...erased]) : randomUUID();
  }

  add(raw, { until, sourceThreadId, sourceTurnId, sourceSeq, actor, pin = true }, time, transaction) {
    const history = this.history();
    const text = entryText(raw);
    this.refuseSecret(raw);
    this.refuseSecret(text);
    if (until !== undefined && (typeof until !== 'string' || cleanDay(until) !== until)) {
      throw new Error('Enter an expiry date as YYYY-MM-DD');
    }
    const files = this.files();
    const file = files[0];
    const siblings = this.allEntries(files);
    const same = siblings.find(entry => squash(entry.text) === squash(text));
    if (same !== undefined) {
      if (transaction) throw new Error('This note already exists');
      return note(same);
    }
    const meta = { id: this.nextEntryId(siblings, history), pinned: pin ? 'yes' : undefined, added: time.slice(0, 10), until };
    const line = formatEntry(text, meta);
    const result = note({ text, meta });
    this.publish('add', insertEntry(file.lines, line), time, {
      after: line, sourceThreadId, sourceTurnId, sourceSeq, ...(actor === undefined ? {} : { actor }),
      ...(transaction ? { transaction: { ...transaction, note: result } } : {}),
    });
    return result;
  }

  // Apply the owner's chosen candidate through the same journal as manual
  // changes. The journal is also the receipt if the review checkpoint could
  // not be written after the note changed.
  approveReview(change, receipt, time, redact) {
    const history = this.history();
    const recorded = history.find(row => row.review?.reportId === receipt.reportId && row.review.index === receipt.index)?.review;
    if (recorded) {
      if (recorded.erased) throw new Error('This note was permanently erased');
      if (recorded.operationId !== receipt.operationId || recorded.acceptedText !== receipt.acceptedText) {
        throw new Error('This memory proposal was already applied');
      }
      return recorded;
    }
    if (history.some(row => row.review?.operationId === receipt.operationId)) throw new Error('The operation id already belongs to another proposal');
    const files = this.files();
    const entries = this.allEntries(files);
    const operation = change.op === 'edit' ? 'replace' : change.op;
    const text = change.op === 'remove' ? undefined : entryText(receipt.acceptedText ?? change.text);
    if (text !== undefined && (redact(text) !== text || (receipt.acceptedText !== undefined && redact(receipt.acceptedText) !== receipt.acceptedText))) {
      throw new Error('Memory cannot keep a secret');
    }
    const previous = change.op === 'add' ? undefined : this.find(entries, change.id);
    const file = previous?.file ?? files[0];
    if (previous && (previous.text !== change.before || isPinned(previous) || isExpired(previous, time.slice(0, 10)))) {
      throw new Error('The note changed before this proposal was applied');
    }
    if (text !== undefined && entries.some(entry => entry !== previous && squash(entry.text) === squash(text))) {
      throw new Error('This note already exists');
    }
    const before = previous && file.lines[previous.line];
    if (before && (looksSecret(before) || redact(before) !== before)) throw new Error('Memory history cannot keep a secret');
    const after = text === undefined ? undefined : formatEntry(text, previous?.meta ?? {
      id: this.nextEntryId(entries, history), added: time.slice(0, 10), until: change.until,
    });
    if (before === after) throw new Error('This proposal leaves the note unchanged');
    const lines = previous === undefined ? insertEntry(file.lines, after) : [...file.lines];
    if (previous && after === undefined) lines.splice(previous.line, 1);
    else if (previous) lines[previous.line] = after;
    this.publish(operation, lines, time, { before, after, sourceThreadId: receipt.threadId, review: receipt }, file.file);
    return receipt;
  }

  replace(id, raw, time, transaction) {
    this.history();
    const entries = this.allEntries();
    const old = this.find(entries, id);
    const file = old.file;
    const text = entryText(raw);
    this.refuseSecret(raw);
    this.refuseSecret(text);
    if (entries.some(entry => entry !== old && squash(entry.text) === squash(text))) {
      throw new Error('This note already exists');
    }
    const meta = { ...old.meta, id: entryId(old) };
    const line = formatEntry(text, meta);
    const before = file.lines[old.line];
    const result = note({ text, meta, file });
    if (line !== before) {
      this.refuseSecret(before);
      const lines = [...file.lines];
      lines[old.line] = line;
      this.publish('replace', lines, time, { before, after: line, ...(transaction ? { transaction: { ...transaction, note: result } } : {}) }, file.file);
    } else if (transaction) {
      throw new Error('This leaves the note unchanged');
    }
    return result;
  }

  find(entries, id) {
    const found = entries.filter(entry => entryId(entry) === id);
    if (found.length !== 1) throw new Error('This note no longer identifies a single memory entry');
    return found[0];
  }

  remove(id, time, transaction) {
    this.history();
    const old = this.find(this.allEntries(), id);
    const file = old.file;
    const before = file.lines[old.line];
    this.refuseSecret(before);
    const lines = file.lines.filter((_line, index) => index !== old.line);
    this.publish('remove', lines, time, { before, transaction }, file.file);
  }

  // The owning Runner authorizes its scope. A retired owner may apply a
  // confirmed erasure to its frozen copy even if it predates that entry.
  // This removes the local Markdown and journal copies together. Device
  // replicas and review checkpoints have their own owners and lifecycles.
  erase(id, operationId, expectedRevision, time, protect, allowMissing = false) {
    const history = this.history();
    const hash = createHash('sha256').update(JSON.stringify({ op: 'erase', id })).digest('hex');
    const seen = history.find(row => row.transaction?.operationId === operationId);
    if (seen) {
      if (seen.transaction.hash !== hash) throw new Error('The operation id already belongs to a different change');
      return { revision: seen.id };
    }
    if ((history[0]?.id ?? 'empty') !== expectedRevision) throw new Error('These notes changed. Reload the current notes before erasing.');
    if (history.some(row => row.op === 'erase' && row.entryId === id)) throw new Error('This note was already erased');
    let names;
    try { names = readdirSync(this.storage.root).filter(memoryFile); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      names = [];
    }
    const files = [...new Set([MAIN, ...names])].map(file => this.load(file));
    const { rows, steps } = eraseMemoryCopies(id, files, history, allowMissing);
    if (steps.length === 0) {
      // Keep the original pending-record shape even for a note already
      // absent from live Markdown. The existing index is written unchanged.
      steps.push({ action: 'write', path: MAIN, text: files[0].content });
    }
    const scope = this.scope;
    const op = 'erase';
    const receipt = record({
      id: randomUUID(), time, op, scope, steps,
      row: { op, scope, file: MAIN, actor: 'user', entryId: id, transaction: { operationId, hash } },
    });
    const replacement = [...rows.reverse(), receipt.row].map(row => JSON.stringify(row)).join('\n') + '\n';
    protect();
    this.storage.erase(receipt, replacement);
    return { revision: receipt.id };
  }

  previewBackupNotes(sources) {
    const erased = new Set(this.history().filter(row => row.op === 'erase').map(row => row.entryId));
    const files = this.files();
    const topics = new Set(files.map(file => file.file));
    const live = this.allEntries(files);
    const liveIds = new Set(live.map(entryId));
    const liveText = new Set(live.map(row => squash(row.text)));
    const counts = new Map();
    for (const { entryId: id } of sources) counts.set(id, (counts.get(id) ?? 0) + 1);
    return sources.flatMap(source => {
      const id = source.entryId;
      if (counts.get(id) !== 1 || erased.has(id) || liveIds.has(id) || !topics.has(source.file)) return [];
      try {
        const { text } = backupEntry(source);
        this.refuseSecret(source.line);
        return liveText.has(squash(text)) ? [] : [{ id, text }];
      } catch {
        return [];
      }
    });
  }

  restoreBackupNote(source, operationId, expectedRevision, time, protect) {
    const rows = this.history();
    const hash = createHash('sha256').update(JSON.stringify({
      op: 'backup-restore', entryId: source.entryId, file: source.file, checksum: source.checksum,
    })).digest('hex');
    const previous = rows.find(row => row.transaction?.operationId === operationId);
    if (previous) {
      if (previous.transaction.hash !== hash) throw new Error('The operation id already belongs to another memory change');
      return { revision: previous.id };
    }
    if ((rows[0]?.id ?? 'empty') !== expectedRevision) throw new Error('These notes changed. Reload the current notes before restoring.');
    if (rows.some(row => row.op === 'erase' && row.entryId === source.entryId)) throw new Error('This memory note was permanently erased');
    const entry = backupEntry(source);
    this.refuseSecret(source.line);
    const files = this.files();
    const file = files.find(file => file.file === source.file);
    if (!file) throw new Error('The backed-up note’s topic no longer exists');
    if (this.allEntries(files).some(row => entryId(row) === source.entryId || squash(row.text) === squash(entry.text))) {
      throw new Error('This note already exists in the current memory scope');
    }
    protect();
    this.publish('add', insertEntry(file.lines, source.line), time, {
      after: source.line, backupSource: source.checksum, transaction: { operationId, hash },
    }, file.file);
    return { revision: this.revision() };
  }

  tidyInput(today) {
    const previous = this.history()[0];
    if (!previous || (previous.op === 'tidy' && !previous.restored)) return undefined;
    const revision = previous.id;
    const files = this.files();
    const offered = this.tidyEntries(files);
    // The entire file will be kept for undo, so refuse before sending any
    // text to the model if the file contains a value learned as a secret.
    for (const file of files) this.refuseSecret(file.content);
    const ended = offered.filter(entry => isExpired(entry, today));
    const numbered = offered.filter(entry => !isExpired(entry, today)).slice(0, 100);
    if (numbered.length === 0 && ended.length === 0) return undefined;
    return { revision, numbered, ended };
  }

  tidyEntries(files) {
    return this.allEntries(this.scope === 'team' ? files.slice(1) : files).filter(entry => !isPinned(entry));
  }

  tidyResult(operationId) {
    const previous = this.history().find(row => row.tidy?.operationId === operationId);
    return previous ? { revision: previous.id, counts: previous.tidy.counts } : undefined;
  }

  tidy(input, reply, operationId, time) {
    const rows = this.history();
    const previous = rows.find(row => row.tidy?.operationId === operationId);
    if (previous) return { revision: previous.id, counts: previous.tidy.counts };
    if (rows[0]?.id !== input.revision) throw new Error('These notes changed while the model reviewed them');
    const changes = parseTidy(reply.length <= 32_000 ? reply : '');
    if (changes === undefined) throw new Error('The model did not return a readable memory tidy');
    const files = this.files();
    const id = randomUUID();
    const offered = this.tidyEntries(files);
    const draft = draftTidy({
      files, offered, changes, numbered: input.numbered, ended: input.ended, batch: id, time,
      entryProblem: text => {
        try { return entryText(text) === text && this.redact(text) === text ? undefined : 'Invalid memory note'; }
        catch { return 'Invalid memory note'; }
      },
      scrub: this.redact,
    });
    const { counts, touched, retired } = draft;
    if (touched.length === 0) return { revision: input.revision, counts };
    const limit = this.scope === 'team' || this.scope === 'group' ? MEMORY_LIMITS[this.scope] : MEMORY_LIMITS.bot;
    const main = touched.find(file => file.file === MAIN)?.after;
    if (main != null && (main.length > limit || parseMemory(main).links.length > MEMORY_LIMITS.topics)) throw new Error('The memory tidy exceeds the scope limits');
    for (const file of touched) {
      if (!memoryFile(file.file) || (file.file !== MAIN && (file.after?.length ?? 0) > MEMORY_LIMITS.topic)) throw new Error('The memory tidy targeted an invalid file');
      if (file.before !== null) this.refuseSecret(file.before);
      if (file.after !== null) this.refuseSecret(file.after);
    }
    this.publishTidy(id, touched, time, { tidy: { operationId, counts, files: touched, retired } });
    return { revision: id, counts };
  }

  publishTidy(id, files, time, extra) {
    const scope = this.scope;
    const op = 'tidy';
    const steps = files.map(({ file, after }) => after === null ? { action: 'remove', path: file } : { action: 'write', path: file, text: after });
    this.storage.publish(record({ id, time, op, scope, steps, row: { op, scope, file: MAIN, actor: 'user', ...extra } }));
  }

  undoTidy(row, time, transaction) {
    const matches = row.tidy?.files;
    if (!Array.isArray(matches) || matches.length === 0) throw new Error('This tidy cannot be restored');
    const files = matches.map(({ file, before, after }) => {
      if (!memoryFile(file) || (before !== null && typeof before !== 'string') || (after !== null && typeof after !== 'string')) {
        throw new Error('This tidy record is invalid');
      }
      const current = this.load(file).content;
      if (current !== after) throw new Error('A file changed after the tidy');
      if (before !== null) this.refuseSecret(before);
      return { file, after: before };
    });
    this.publishTidy(randomUUID(), files, time, { restored: row.id, transaction });
  }

  restore(id, time, transaction) {
    const rows = this.history();
    const row = rows.find(change => change.id === id);
    if (!row || !['add', 'replace', 'remove', 'tidy'].includes(row.op)) throw new Error('This change is not in the memory history');
    if (row.erasedEntryId) throw new Error('This memory change was permanently erased');
    if (rows.some(change => change.restored === id)) throw new Error('This change is already restored');
    if (row.op === 'tidy') return this.undoTidy(row, time, transaction);
    const file = this.load(row.file);
    if (file.content === null) throw new Error('The note’s topic no longer exists');
    let back;
    if (row.op !== 'add') {
      if (!entryLine(row.before)) throw new Error('This history row cannot be restored');
      entryText(splitMeta(row.before.replace(/^\s*[-*]\s+/, '')).text);
      this.refuseSecret(row.before);
      [back] = parseMemory(row.before).entries;
    }
    const occupied = (skip) => file.entries.some(entry => entry.line !== skip && (entryId(entry) === entryId(back) || squash(entry.text) === squash(back.text)));
    if (row.op === 'remove') {
      if (occupied(undefined)) throw new Error('The note removed by this change already exists');
      this.publish('add', insertEntry(file.lines, row.before), time, { after: row.before, restored: id, transaction }, file.file);
      return;
    }
    const found = exactLines(file, row.after);
    if (found.length !== 1) throw new Error('The note may have changed or been removed since this change');
    this.refuseSecret(row.after);
    const lines = [...file.lines];
    const index = found[0].line;
    if (row.op === 'replace') {
      if (occupied(index)) throw new Error('The note before this change already exists');
      lines[index] = row.before;
      this.publish('replace', lines, time, { before: row.after, after: row.before, restored: id, transaction }, file.file);
    } else {
      lines.splice(index, 1);
      this.publish('remove', lines, time, { before: row.after, restored: id, transaction }, file.file);
    }
  }
}
