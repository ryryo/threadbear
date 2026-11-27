// DS-Bot ledger primitives from src/host/ledger.js at d104d9ca18d69a35460f14e15dff4d553181433a.
// Copyright 2026 Fei2411 and the DS Bot contributors. Apache-2.0 (see ported/NOTICE).
import { createHash } from 'node:crypto';

export const bookFile = (book: string) => {
  const safe = /^[\w-]{1,160}$/.test(book) ? book : createHash('sha256').update(String(book)).digest('hex').slice(0, 32)
  return `${safe}.jsonl`
}

export type LedgerRow = { seq: number; id: string; [field: string]: unknown };

export function parseBook(text: string): { rows: LedgerRow[]; torn: boolean } {
  const rows: LedgerRow[] = [];
  const lines = text.split('\n');
  for (const [at, line] of lines.entries()) {
    if (line === '') continue;
    let record: unknown;
    try { record = JSON.parse(line); }
    catch {
      // The next append can replace a torn last line. Earlier corruption
      // prevents a round from validating its saved log or issuing new calls.
      if (at === lines.length - 1) return { rows, torn: true };
      throw new Error(`Invalid Group ledger record ${at + 1}`);
    }
    const found = record as Partial<LedgerRow> | null;
    if (!found || !Number.isSafeInteger(found.seq) || (found.seq ?? 0) < 1 ||
        typeof found.id !== 'string' || !found.id || (rows.at(-1)?.seq ?? 0) >= (found.seq ?? 0)) {
      throw new Error(`Invalid Group ledger identity in record ${at + 1}`);
    }
    rows.push(found as LedgerRow);
  }
  return { rows, torn: false };
}

export function range(records: readonly LedgerRow[], from: number, to?: number): LedgerRow[] {
  const start = Math.max(Math.ceil(from), records[0]?.seq ?? Infinity);
  const last = records.at(-1)?.seq ?? -Infinity;
  const end = to === undefined ? last : Math.min(to, last);
  // Walking the seqs finds the same records in order; a sparse book is
  // quicker to scan. The reader rejected nonascending records above.
  if (end - start > records.length) {
    return records.filter(record => record.seq >= from && (to === undefined || record.seq <= to));
  }
  const bySeq = new Map(records.map(record => [record.seq, record]));
  const rows: LedgerRow[] = [];
  for (let seq = start; seq <= end; seq += 1) {
    const record = bySeq.get(seq);
    if (record !== undefined) rows.push(record);
  }
  return rows;
}
