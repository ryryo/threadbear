import { createHash } from 'node:crypto';
import { entryId, parseMemory } from './ported/memory-entries.js';

function scrub(body, id) {
  if (body == null) return { body, count: 0 };
  if (typeof body !== 'string') throw new Error('A memory snapshot has an unknown format');
  const selected = new Set();
  for (const entry of parseMemory(body).entries) {
    const identity = entryId(entry);
    if (entry.meta.merged && (identity === id || entry.meta.merged.split(/\s+/).includes(id))) {
      throw new Error('This note was merged with another note; its copies cannot be identified separately');
    }
    if (identity === id) selected.add(entry.line);
  }
  if (!selected.size) return { body, count: 0 };
  // parseMemory supplies the line identities. Keep the original bytes on
  // unrelated lines, including snapshots stored before newline normalization.
  const lines = body.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? [];
  return { body: lines.filter((_, index) => !selected.has(index)).join(''), count: selected.size };
}

function scrubTidy(tidy, id) {
  if (tidy === undefined) return { tidy, affected: false };
  if (!Array.isArray(tidy.files) || !Array.isArray(tidy.retired)) throw new Error('A memory tidy has an unknown format');
  let affected = false;
  const files = tidy.files.map(file => {
    const before = scrub(file.before, id);
    const after = scrub(file.after, id);
    if (!before.count && !after.count) return file;
    if (before.count > 1 || after.count > 1) throw new Error('This identity belongs to multiple notes');
    affected = true;
    return { ...file, before: before.body, after: after.body };
  });
  const retired = tidy.retired.filter(row => {
    const selected = scrub(row.line, id).count > 0;
    if (row.into === id || (selected && row.into !== undefined)) {
      throw new Error('This note was merged with another note; its copies cannot be identified separately');
    }
    if (selected) affected = true;
    return !selected;
  });
  return { tidy: affected ? { ...tidy, files, retired } : tidy, affected };
}

export function eraseMemoryCopies(id, files, history, allowMissing = false) {
  let live = 0;
  let births = 0;
  let known = false;
  const steps = [];
  for (const { file, content } of files) {
    const after = scrub(content, id);
    if (!after.count) continue;
    live += after.count;
    steps.push({ path: file, action: 'write', text: after.body });
  }
  const rows = history.map(row => {
    const before = scrub(row.before, id);
    const after = scrub(row.after, id);
    if (before.count > 1 || after.count > 1 ||
        (row.op === 'replace' && Boolean(before.count) !== Boolean(after.count))) {
      throw new Error('This identity belongs to multiple notes');
    }
    if (after.count && row.op === 'add' && row.restored === undefined && row.backupSource === undefined) births++;
    const receipt = row.transaction?.note?.id === id;
    const { tidy, affected } = scrubTidy(row.tidy, id);
    const copiedReview = row.erasedEntryId === id && row.review?.acceptedText !== undefined;
    if (!before.count && !after.count && !receipt && !affected && !copiedReview) return row;
    known = true;
    const direct = before.count || after.count || receipt || copiedReview;
    return {
      ...row,
      ...(affected && { tidy }),
      ...(before.count && { before: undefined }),
      ...(after.count && { after: undefined }),
      ...(receipt && { transaction: { ...row.transaction, note: undefined } }),
      ...(direct && row.review && { review: { ...row.review, acceptedText: undefined, erased: true } }),
      ...(direct && { erasedEntryId: id }),
    };
  });
  if (live > 1 || births > 1) throw new Error('This identity belongs to multiple notes');
  if (!live && !known && !allowMissing) throw new Error('This note is not in the memory scope or its history');
  return { rows, steps };
}

function assertErasedReviews(history, reviews, id) {
  const receipts = history.filter(row => row.erasedEntryId === id && row.review?.erased).map(row => row.review);
  for (const { conversationId, reports } of reviews) {
    for (const report of reports) {
      for (const [index, change] of report.changes.entries()) {
        const receipt = receipts.find(row => row.conversationId === conversationId && row.reportId === report.id && row.index === index);
        if ((change.op === 'edit' || change.op === 'remove') && change.id === id ||
            receipt && (change.op !== 'erased' || change.operationId !== receipt.operationId)) {
          throw new Error('The workspace still contains a copy of an erased memory review.');
        }
      }
    }
  }
}

// Validate before installing a pack or restoring a managed copy. The
// authority confirms the ID and scope; the candidate also has to keep the
// original journal operation and have removed its local copies.
export function assertWorkspaceMemoryErased(entries, requirements) {
  if (!requirements.length) return;
  const paths = new Map(entries.map(entry => [entry.path, entry.data]));
  const state = paths.get('bots/state.json');
  const links = state ? JSON.parse(state.toString('utf8')).conversations : [];
  const scopes = new Map();
  for (const { scope, entryId: id } of requirements) {
    const prefix = 'bots/memory/' + (scope.kind === 'bot' ? scope.id : 'group-' + scope.id) + '/';
    let saved = scopes.get(prefix);
    if (!saved) {
      const content = entries.filter(file => file.path.startsWith(prefix));
      if (content.some(file => {
        const name = file.path.slice(prefix.length);
        return name === 'pending.json' || name === 'journal-erasure.jsonl' ||
          (name === 'journal-torn.jsonl' && file.data.length > 0) || /^\..+\.\d+\.[0-9a-f]{8}\.tmp$/.test(name);
      })) throw new Error('Recover the memory journal before checking its required erasures.');
      const journal = content.find(file => file.path === prefix + 'journal.jsonl');
      if (!journal) throw new Error('The workspace is missing a required memory erasure.');
      const history = journal.data.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
      const files = content.flatMap(file => {
        const name = file.path.slice(prefix.length);
        return /^[^/]+\.md$/i.test(name) ? [{ file: name, content: file.data.toString('utf8') }] : [];
      });
      const reviews = scope.kind === 'bot' ? links.filter(link => link.botId === scope.id).flatMap(link => {
        const body = paths.get('bots/reviews/' + link.id + '.json');
        if (!body) return [];
        const saved = JSON.parse(body.toString('utf8'));
        if (saved.conversationId !== link.id || !Array.isArray(saved.reports) ||
            saved.reports.some(row => row.source.botId !== scope.id || row.source.threadId !== link.threadId)) {
          throw new Error('A backed-up review does not match its Bot and Thread.');
        }
        return [saved];
      }) : [];
      saved = { files, history, reviews };
      scopes.set(prefix, saved);
    }
    const hash = createHash('sha256').update(JSON.stringify({ op: 'erase', id })).digest('hex');
    if (!saved.history.some(row => row.op === 'erase' && row.entryId === id && row.transaction?.operationId && row.transaction.hash === hash)) {
      throw new Error('The workspace is missing a required memory erasure.');
    }
    const { rows, steps } = eraseMemoryCopies(id, saved.files, saved.history, true);
    if (steps.length || rows.some((row, index) => row !== saved.history[index])) {
      throw new Error('The workspace still contains a copy of an erased memory note.');
    }
    assertErasedReviews(saved.history, saved.reviews, id);
  }
}
