import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicWriteFileSync } from '../fsutil.ts';
import { PERMISSION_MODES } from '../protocol.ts';
import { bookFile, parseBook } from './group-ledger.ts';
import { callIn, type GroupRound } from './group-round.ts';
import { groupMentions } from './group-mentions.ts';
import type { Bot, BotRepository } from './repository.ts';

const id = z.uuid();
const date = z.iso.datetime();
export const groupDraft = z.object({
  title: z.string().trim().min(1).max(120),
  teamId: id,
  memberIds: z.array(id).min(1).max(12),
  adminId: id,
  mode: z.enum(['admin', 'everyone']).default('admin'),
  ceiling: z.enum(PERMISSION_MODES).default('ask'),
});
const group = groupDraft.extend({ id, revision: z.int().positive(), archivedAt: date.optional() });
const entry = z.looseObject({ seq: z.int().positive(), id: z.string(), kind: z.string(), at: date });
const schedule = z.object({ id, ceiling: z.enum(PERMISSION_MODES), settingsRevision: z.int().positive() });
export type GroupSchedule = z.infer<typeof schedule>;
const post = z.object({
  schedule: schedule.optional(),
  eventId: id, seq: z.int().positive(), operationId: z.string().min(1).max(128),
  text: z.string().min(1).max(30_000), calleeIds: z.array(id), ordered: z.boolean(),
  mentions: z.array(z.object({ start: z.int().nonnegative(), end: z.int().positive(), botIds: z.array(id) })).default([]),
});
const call = z.object({
  id, callId: id, name: z.string(), status: z.enum(['waiting', 'speaking', 'done', 'failed', 'stopped']),
  note: z.string().optional(), by: id.optional(), batch: z.int().optional(), batchKey: id.optional(),
  ordered: z.boolean().optional(), summary: z.boolean().optional(), threadId: id.optional(), turnId: z.string().optional(),
});
const roundSchema = z.object({
  id, roomId: id, schedule: schedule.optional(), sourceSeq: z.int().positive(), status: z.enum(['running', 'finalizing', 'done', 'stopped']),
  batches: z.int().nonnegative(), slots: z.array(call),
});
const batch = z.object({
  key: id, by: id, origin: id, operationId: z.string().min(1).max(128), note: z.string(),
  pending: z.array(id), doneIds: z.array(id), results: z.array(z.int().positive()),
  summary: id.optional(),
});
const snapshot = z.object({
  group, creation: z.object({ id: z.string().min(1).max(128), fingerprint: z.string() }).optional(), frozen: z.boolean(), round: roundSchema.optional(), posts: z.array(post), batches: z.array(batch), idleRelays: z.int().nonnegative().default(0),
  threads: z.record(id, z.object({ id, threadId: id, sessionId: id })),
});
export type Group = z.infer<typeof group>;
export type GroupDraft = z.input<typeof groupDraft>;
export type GroupPost = z.infer<typeof post>;
export type GroupEvent = z.infer<typeof entry>;
export type GroupBatch = z.infer<typeof batch>;
export type GroupBook = z.infer<typeof snapshot> & { events: GroupEvent[] };
type Write = (file: string, body: string, mode: number) => void;

export function readGroupBook(groupId: string, text: string): GroupBook {
  const valid = id.parse(groupId);
  const { rows, torn } = parseBook(text);
  const last = rows.pop();
  if (torn || last?.kind !== 'state' || last.id !== valid) throw new Error('The Group has no complete saved state.');
  const state = snapshot.parse(last.state);
  if (state.group.id !== valid || (state.round && state.round.roomId !== valid)) throw new Error('The Group identity changed on disk.');
  return { ...state, events: rows.map(row => entry.parse(row)) };
}

export class GroupStore {
  private readonly root: string;
  private readonly repo: BotRepository;
  private readonly protect: (keptDelegation?: true) => void;
  private readonly write: Write;
  private readonly books = new Map<string, GroupBook>();

  constructor(root: string, repo: BotRepository, protect: (keptDelegation?: true) => void, write: Write = atomicWriteFileSync) {
    this.root = join(root, 'groups');
    this.repo = repo;
    this.protect = protect;
    this.write = write;
  }

  private path(id: string): string {
    return join(this.root, bookFile(id));
  }

  private save(book: GroupBook, keptDelegation?: true): void {
    const { events, ...state } = book;
    const record = { seq: (events.at(-1)?.seq ?? 0) + 1, id: book.group.id, kind: 'state', state };
    this.protect(keptDelegation);
    this.write(this.path(book.group.id), [...events, record].map(row => JSON.stringify(row)).join('\n') + '\n', 0o600);
    this.books.set(book.group.id, book);
  }

  get(groupId: string): GroupBook {
    const valid = id.parse(groupId);
    const known = this.books.get(valid);
    if (known) return structuredClone(known);
    const file = this.path(valid);
    if (!lstatSync(file).isFile()) throw new Error('The Group book must be a regular file.');
    const book = readGroupBook(valid, readFileSync(file, 'utf8'));
    this.books.set(valid, book);
    return structuredClone(book);
  }

  list(): Group[] {
    try {
      return readdirSync(this.root, { withFileTypes: true }).filter(item => item.isFile() && item.name.endsWith('.jsonl'))
        .map(item => this.get(item.name.slice(0, -6)).group);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  member(group: Group, botId: string): Bot | undefined {
    if (!group.memberIds.includes(botId) || this.repo.teamIdForBot(botId) !== group.teamId) return undefined;
    const bot = this.repo.get(botId);
    return bot.archivedAt || bot.privacy ? undefined : bot;
  }

  private validate(group: Group): void {
    if (group.teamId !== this.repo.workspaceId()) this.repo.team(group.teamId);
    if (new Set(group.memberIds).size !== group.memberIds.length || !group.memberIds.includes(group.adminId)) {
      throw new Error('Choose distinct Group members and an admin from those members.');
    }
    for (const id of group.memberIds) {
      if (!this.member(group, id)) throw new Error('Group members must be active non-Private Bots on its team.');
    }
  }

  teams() {
    return [{ id: this.repo.workspaceId(), title: 'Workspace', memberIds: this.repo.list()
      .filter(bot => this.repo.teamIdForBot(bot.id) === this.repo.workspaceId()).map(bot => bot.id) }, ...this.repo.teams()];
  }

  create(input: GroupDraft, operationId?: string): Group {
    const draft = groupDraft.parse(input);
    const fingerprint = createHash('sha256').update(JSON.stringify(draft)).digest('hex');
    const known = operationId && this.list().map(group => this.get(group.id)).find(book => book.creation?.id === operationId);
    if (known) {
      if (known.creation?.fingerprint !== fingerprint) throw new Error('That operation ID already names a different Group.');
      return known.group;
    }
    const profile = { ...draft, id: randomUUID(), revision: 1 };
    this.validate(profile);
    this.save({ group: profile, ...(operationId && { creation: { id: operationId, fingerprint } }), frozen: false, posts: [], batches: [], idleRelays: 0, threads: {}, events: [] });
    return structuredClone(profile);
  }

  change<T>(id: string, write: (book: GroupBook) => T, keptDelegation?: true): T {
    const book = this.get(id);
    const value = write(book);
    this.save(book, keptDelegation);
    return structuredClone(value);
  }

  update(id: string, expectedRevision: number, changes: Partial<Omit<GroupDraft, 'teamId'>>): Group {
    return this.change(id, book => {
      if (book.group.revision !== expectedRevision || book.group.archivedAt) throw new Error('The Group changed.');
      const next = group.parse({ ...book.group, ...changes, revision: book.group.revision + 1 });
      this.validate(next);
      book.group = next;
      for (const slot of book.round?.slots ?? []) {
        if (!next.memberIds.includes(slot.id) && (slot.status === 'waiting' || slot.status === 'speaking')) slot.status = 'stopped';
      }
      return next;
    });
  }

  append(book: GroupBook, kind: string, at: string, fields: Record<string, unknown>): GroupEvent {
    const row = { ...fields, id: randomUUID(), seq: (book.events.at(-1)?.seq ?? 0) + 1, at, kind };
    book.events.push(row);
    return row;
  }

  post(id: string, operationId: string, text: string, at: string, scheduled?: GroupSchedule): GroupPost {
    const book = this.get(id);
    if (book.group.archivedAt) throw new Error('This Group is archived.');
    const previous = book.events.find(event => event.kind === 'post' && event.operationId === operationId);
    if (previous) {
      if (previous.text !== text || (previous.schedule as GroupSchedule | undefined)?.id !== scheduled?.id) throw new Error('That operation ID already names a different post.');
      return post.parse({ ...previous, eventId: previous.id });
    }
    const members = book.group.memberIds.flatMap(id => this.member(book.group, id) ?? []);
    const mentioned = groupMentions(text, members);
    const mentions = mentioned.map(span => ({
      start: span.start, end: span.end, botIds: 'bot' in span ? [span.bot.id] : members.map(bot => bot.id),
    }));
    const calleeIds = [...new Set(mentions.flatMap(span => span.botIds))];
    const ordered = !calleeIds.length && book.group.mode === 'everyone';
    const admin = members.find(bot => bot.id === book.group.adminId);
    const fallback = [
      ...(admin ? [admin.id] : []),
      ...(ordered ? members.filter(bot => bot.id !== book.group.adminId).map(bot => bot.id) : []),
    ];
    const fields = { operationId, text, ...(scheduled && { schedule: scheduled }), calleeIds: calleeIds.length ? calleeIds : fallback, mentions, ordered };
    const event = this.append(book, 'post', at, fields);
    const ready = post.parse({ ...event, eventId: event.id });
    book.posts.push(ready);
    book.idleRelays = 0;
    this.save(book);
    return structuredClone(ready);
  }

  startNext(id: string): GroupRound | undefined {
    const book = this.get(id);
    if (book.frozen || book.group.archivedAt || !book.posts.length || book.round?.status === 'running' || book.round?.status === 'finalizing') return undefined;
    const post = book.posts.shift()!;
    const peers = post.calleeIds.flatMap(id => this.member(book.group, id) ?? []);
    const round: GroupRound = {
      id: randomUUID(), roomId: id, sourceSeq: post.seq, status: 'running', batches: 0, slots: [],
      ...(post.schedule && { schedule: post.schedule }),
    };
    callIn(round, peers, post.text, undefined, { ordered: post.ordered });
    book.round = round;
    book.batches = [];
    this.save(book);
    return structuredClone(round);
  }

  freeze(id: string, at: string, archiveRevision?: number): GroupBook {
    return this.change(id, book => {
      if (archiveRevision !== undefined) {
        if (book.group.revision !== archiveRevision || book.group.archivedAt) throw new Error('The Group changed.');
        book.group = { ...book.group, archivedAt: at, revision: archiveRevision + 1 };
      }
      book.frozen = true;
      if (book.round && book.round.status !== 'done') {
        book.round.status = 'stopped';
        for (const slot of book.round.slots) if (slot.status === 'waiting' || slot.status === 'speaking') slot.status = 'stopped';
      }
      this.append(book, 'stopped', at, { roundId: book.round?.id });
      return book;
    });
  }
}
