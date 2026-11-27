// Derived from Fei-Craft/DS-Bot d104d9ca18d69a35460f14e15dff4d553181433a.
// Copyright 2026 Fei2411 and the DS Bot contributors.
// SPDX-License-Identifier: Apache-2.0
// Modified for Threadbear: extract publish/recover and journal helpers from
// ds-bot/src/host/memory.js. The Runner owns the write lock, root and atomic writes.

import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, truncateSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { atomicWriteFileSync, removeTempFiles, renameWithRetry } from '../../fsutil.ts';
import { inside, pendingPath, read as readPending, serialize } from './memory-pending.js';

const JOURNAL_TAIL_BYTES = 4096;
const digest = data => createHash('sha256').update(data).digest('hex');

function regularBytes(path) {
  const file = lstatSync(path, { throwIfNoEntry: false });
  if (!file) return undefined;
  if (!file.isFile()) throw new Error('The memory erasure needs regular journal files');
  return readFileSync(path);
}

function unreadable(path, error) {
  throw Object.assign(new Error(`Could not read the memory journal at ${path}`, { cause: error }), { code: 'memory/journal' });
}

// The end of the change log, from where it starts in bytes: at least its last whole
// row and what follows it. Every write finishes an interrupted change first, so the
// row of a change that is finished twice is the last one in its log, and a half row
// can only be at the end. The log only grows, so a write does not read all of it.
function journalTail(path) {
  let fd
  try {
    fd = openSync(path, 'r')
  } catch (error) {
    if (error?.code === 'ENOENT') return { start: 0, text: '' }
    unreadable(path, error)
  }
  try {
    const size = fstatSync(fd).size
    for (let length = JOURNAL_TAIL_BYTES; ; length *= 2) {
      const start = Math.max(0, size - length)
      const bytes = Buffer.alloc(size - start)
      for (let at = 0; at < bytes.length;) {
        const read = readSync(fd, bytes, at, bytes.length - at, start + at)
        if (read === 0) break
        at += read
      }
      const last = bytes.lastIndexOf(0x0a)
      // A newline byte is never part of a longer character, so cutting after one
      // keeps the text and its offset in bytes whole.
      if (start > 0 && !(last > 0 && bytes.lastIndexOf(0x0a, last - 1) >= 0)) {
        if (length >= 4 * 1024 * 1024) throw new Error('The memory journal tail is too large to recover');
        continue;
      }
      const from = start === 0 ? 0 : bytes.indexOf(0x0a) + 1
      return { start: start + from, text: bytes.subarray(from).toString('utf8') }
    }
  } catch (error) {
    unreadable(path, error)
  } finally {
    closeSync(fd)
  }
}

// Whether the change log already holds the row of a change. Only a row that parses
// counts: a half-written row is not proof that anything was done.
function journalled(text, id) {
  return text.split('\n').some(line => {
    if (!line.includes(id)) return false
    try { return JSON.parse(line)?.id === id } catch { return false }
  })
}

// Whether a line of the change log is a whole row.
const whole = (line) => {
  try {
    const value = JSON.parse(line)
    return value !== null && typeof value === 'object'
  } catch {
    return false
  }
}

// The row of a change in the change log, written once: a change that is finished
// twice (after an interruption) does not get a second row. The row keeps the
// fields it always had, so a later undo can still read what each change replaced.
//
// The log can end in a half-written row, when a change was interrupted while its
// row was being appended. A half row is not proof that anything was done: it is
// kept beside the log as the evidence it is, the log is cut back to the rows that
// are whole, and the row after it starts on a line of its own.
function journalRow(path, torn, row) {
  const { start, text } = journalTail(path)
  if (journalled(text, row.id)) return false
  const cut = text.lastIndexOf('\n') + 1
  const half = text.slice(cut)
  const line = JSON.stringify(row)
  mkdirSync(dirname(path), { recursive: true })
  if (half === '') {
    appendFileSync(path, `${line}\n`, { encoding: 'utf8', mode: 0o600, flush: true })
    return true
  }
  if (whole(half)) {
    // A whole row that lost its newline: it is ended, and the row after it starts
    // on a line of its own.
    appendFileSync(path, `\n${line}\n`, { encoding: 'utf8', mode: 0o600, flush: true })
    return true
  }
  appendFileSync(torn, `${half}\n`, { encoding: 'utf8', mode: 0o600, flush: true })
  truncateSync(path, start + Buffer.byteLength(text.slice(0, cut), 'utf8'))
  appendFileSync(path, `${line}\n`, { encoding: 'utf8', mode: 0o600, flush: true })
  return true
}

// A pending record is validated completely before it can change files.
// Do not allow recovered paths to redirect through a symlink.
export function checkPath(root, path) {
  let at = root;
  for (const part of ['', ...relative(root, path).split(sep)]) {
    at = join(at, part);
    try {
      if (lstatSync(at).isSymbolicLink()) throw new Error('A memory path points through a symbolic link');
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
  }
}

export class MemoryJournal {
  constructor(root) {
    this.root = resolve(root);
    this.pending = pendingPath(this.root);
    this.journal = join(this.root, 'journal.jsonl');
    this.torn = join(this.root, 'journal-torn.jsonl');
    this.erasure = join(this.root, 'journal-erasure.jsonl');
  }

  stepsFor(change) {
    if (change.id !== change.row.id || change.scope !== change.row.scope || change.op !== change.row.op) {
      throw new Error('The pending memory record and its journal row do not match');
    }
    if (change.op === 'erase') {
      const { before, after } = change.rewrite ?? {};
      if (![before, after].every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))) {
        throw new Error('The pending memory erasure does not name both journal checksums');
      }
    } else if (change.rewrite !== undefined) {
      throw new Error('Only a pending memory erasure can replace the journal');
    }
    const steps = change.steps.map(step => {
      const path = inside(this.root, step.path);
      if (path === this.root || path === this.pending || path === this.journal || path === this.torn || path === this.erasure) {
        throw new Error('A pending memory step targets a reserved path');
      }
      checkPath(this.root, path);
      return { ...step, path };
    });
    checkPath(this.root, this.journal);
    checkPath(this.root, this.torn);
    return steps;
  }

  // The journal can be larger than pending.json. Stage only its sanitized
  // replacement and bind both versions to the existing, bounded intent.
  verifyRewrite({ before, after }) {
    checkPath(this.root, this.erasure);
    const staged = regularBytes(this.erasure);
    const current = digest(regularBytes(this.journal) ?? '');
    if (staged === undefined ? current !== after : digest(staged) !== after || current !== before) {
      throw new Error('The memory erasure journal checksum did not match');
    }
    return staged !== undefined;
  }

  installRewrite(staged) {
    if (staged) renameWithRetry(this.erasure, this.journal);
  }

  finish(change, steps) {
    const staged = change.rewrite === undefined ? undefined : this.verifyRewrite(change.rewrite);
    for (const step of steps) {
      if (step.action === 'remove') rmSync(step.path, { force: true });
      else atomicWriteFileSync(step.path, step.text, 0o600);
    }
    if (staged === undefined) journalRow(this.journal, this.torn, change.row);
    else {
      this.installRewrite(staged);
      // A stopped Runner can leave an older atomic write in the same
      // folder. Use the existing generated-file and process checks.
      removeTempFiles(this.root);
    }
    rmSync(this.pending, { force: true });
  }

  erase(change, sanitizedJournal) {
    this.recoverPending();
    if (change.op !== 'erase' || !sanitizedJournal.endsWith(JSON.stringify(change.row) + '\n')) {
      throw new Error('The memory erasure journal is missing its receipt');
    }
    checkPath(this.root, this.journal);
    checkPath(this.root, this.torn);
    if (regularBytes(this.torn)?.length) throw new Error('Repair the torn memory journal before erasing a note');
    const rewrite = { before: digest(regularBytes(this.journal) ?? ''), after: digest(sanitizedJournal) };
    const accepted = { ...change, rewrite };
    const steps = this.stepsFor(accepted);
    const intent = serialize(accepted);
    checkPath(this.root, this.erasure);
    atomicWriteFileSync(this.erasure, sanitizedJournal, 0o600);
    try {
      atomicWriteFileSync(this.pending, intent, 0o600);
    } catch (error) {
      rmSync(this.erasure, { force: true });
      throw error;
    }
    this.finish(accepted, steps);
  }

  publish(change) {
    this.recoverPending();
    if (change.op === 'erase' || change.rewrite !== undefined) throw new Error('Memory erasure needs a journal replacement');
    const steps = this.stepsFor(change);
    atomicWriteFileSync(this.pending, serialize(change), 0o600);
    this.finish(change, steps);
  }

  recoverPending() {
    checkPath(this.root, this.pending);
    const change = readPending(this.root);
    if (change !== undefined) {
      this.finish(change, this.stepsFor(change));
    } else if (lstatSync(this.erasure, { throwIfNoEntry: false })) {
      checkPath(this.root, this.erasure);
      rmSync(this.erasure);
    }
  }
}
