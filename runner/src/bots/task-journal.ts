// Adapt the DS-Bot task draft and retention rules to Threadbear's task and
// Thread identities. Original source: ds-bot/src/host/bot-tasks.js at
// d104d9ca18d69a35460f14e15dff4d553181433a (Apache-2.0, see ported/NOTICE).
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { lstatSync, readFileSync } from 'node:fs';
import type { EffortLevel, PermissionMode } from '../protocol.ts';
import type { GroupInput } from './group-threads.ts';
import type { KeptResult } from './handoff-result.ts';

const TITLE_MAX = 80
const BRIEF_KEPT = 500
const SUMMARY_MAX = 300
const oneLine = (text: string, max: number) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

export type StartTask = {
  operationId: string;
  botId: string;
  sourceThreadId: string;
  sourceConversationId: string;
  originRequestId?: string;
  group?: GroupInput;
  folder?: string;
  requestedFolder?: string;
  privateBotId?: string;
  retryOf?: string;
  ceiling?: PermissionMode;
  settings?: { accountId: string; model?: string; effort?: EffortLevel };

  title: string;
  brief: string;
};
type TaskState =
  | { status: 'reserved' }
  | { status: 'queued' | 'running' | 'waiting_work'; turnId: string }
  | { status: 'completed' | 'failed' | 'interrupted' | 'stopped'; outcome: { summary: string; result?: KeptResult }; reply?: { id: string; sent: boolean } };
export type SavedTask = Omit<StartTask, 'brief'> & {
  id: string;
  threadId: string;
  nativeSessionId: string;
  fingerprint: string;
  briefPreview: string;
  revision: number;
  startedAt: string;
  updatedAt: string;
  state: TaskState;
};
type Writer = (file: string, body: string, mode: number) => void;

export const BOT_WORKSPACE_CONCURRENCY = 4;

const running = (task: SavedTask) => !('outcome' in task.state);
const taskFingerprint = (title: string, brief: string, folder?: string, retryOf?: string) =>
  createHash('sha256').update(JSON.stringify({ title: oneLine(title, TITLE_MAX).toWellFormed(), brief, folder, retryOf })).digest('hex');


export class TaskJournal {
  private readonly file: string;
  private readonly saveFile: Writer;
  private rows: Map<string, SavedTask>;
  private readonly protect: () => void;
  private readonly otherActive: () => number;

  constructor(root: string, saveFile: Writer, protect: () => void, otherActive = () => 0) {
    this.file = join(root, 'tasks.json');
    this.saveFile = saveFile;
    this.protect = protect;
    this.otherActive = otherActive;
    this.rows = this.read();
  }

  private read(): Map<string, SavedTask> {
    try {
      if (!lstatSync(this.file).isFile()) throw new Error('The Bot task journal must be a regular file');
      const rows = JSON.parse(readFileSync(this.file, 'utf8')) as SavedTask[];
      if (!Array.isArray(rows)) throw new Error('Invalid Bot task journal');
      const map = new Map<string, SavedTask>();
      for (const row of rows) {
        if (!row || typeof row.id !== 'string' || typeof row.threadId !== 'string' || !row.state ||
            !Number.isSafeInteger(row.revision) || row.revision < 1 || map.has(row.id)) throw new Error('Invalid Bot task record');
        map.set(row.id, row);
      }
      return map;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
      throw error;
    }
  }

  private save(row: SavedTask): SavedTask {
    const next = new Map(this.rows).set(row.id, row);
    this.protect();
    this.saveFile(this.file, JSON.stringify([...next.values()]) + '\n', 0o600);
    this.rows = next;
    return structuredClone(row);
  }

  get(id: string): SavedTask {
    const row = this.rows.get(id);
    if (!row) throw new Error('This Bot task is unavailable');
    return structuredClone(row);
  }

  operation(sourceThreadId: string, operationId: string, title: string, brief: string, folder?: string, retryOf?: string): SavedTask | undefined {
    const row = [...this.rows.values()].find(task => task.sourceThreadId === sourceThreadId && task.operationId === operationId);
    if (!row) return undefined;
    if (row.fingerprint !== taskFingerprint(title, brief, folder, retryOf)) throw new Error('This operation already belongs to a different task');
    return structuredClone(row);
  }

  activeCount(): number {
    return [...this.rows.values()].filter(running).length;
  }

  reserve(input: StartTask, at: string): SavedTask {
    const { brief, title, operationId, ...scope } = input;
    const clean = oneLine(title, TITLE_MAX).toWellFormed();
    if (!clean || !brief.trim()) throw new Error('A task needs both a title and a brief.');
    const fingerprint = taskFingerprint(title, brief, input.requestedFolder, input.retryOf);
    const all = [...this.rows.values()];
    const known = this.operation(input.sourceThreadId, operationId, title, brief, input.requestedFolder, input.retryOf);
    if (known) return known;
    const active = all.filter(running);
    if (active.length + this.otherActive() >= BOT_WORKSPACE_CONCURRENCY || active.filter(row => row.botId === input.botId).length >= 2) {
      throw new Error('The workspace or Bot has reached its background task limit');
    }
    return this.save({
      ...scope, title: clean, operationId, fingerprint, briefPreview: oneLine(brief, BRIEF_KEPT).toWellFormed(),
      id: randomUUID(), threadId: randomUUID(), nativeSessionId: randomUUID(), startedAt: at, updatedAt: at, revision: 1, state: { status: 'reserved' },
    });
  }

  progress(id: string, revision: number, at: string, state: Extract<TaskState, { turnId: string }>): SavedTask {
    const row = this.current(id, revision);
    if (!running(row)) throw new Error('This task already ended');
    return this.save({ ...row, updatedAt: at, revision: revision + 1, state });
  }

  finish(id: string, revision: number, at: string, status: Extract<TaskState, { outcome: unknown }>['status'],
    text: string, result: KeptResult | undefined, notify: boolean): SavedTask {
    const row = this.current(id, revision);
    if (!running(row)) throw new Error('This task already ended');
    if (result && result.source.threadId !== row.threadId) throw new Error('The result belongs to another task');
    return this.save({
      ...row, updatedAt: at, revision: revision + 1,
      state: { status, outcome: { summary: oneLine(text, SUMMARY_MAX).toWellFormed(), result },
        ...(notify ? { reply: { id: `bot-task-reply:${id}`, sent: false } } : {}) },
    });
  }

  returned(id: string, revision: number, at: string, replyId: string): SavedTask {
    const row = this.current(id, revision);
    if (!('outcome' in row.state) || row.state.reply?.id !== replyId) throw new Error('The result does not match its return receipt');
    if (row.state.reply.sent) return row;
    return this.save({ ...row, updatedAt: at, revision: revision + 1, state: { ...row.state, reply: { id: replyId, sent: true } } });
  }

  byThread(threadId: string): SavedTask | undefined {
    const row = [...this.rows.values()].find(task => task.threadId === threadId);
    return row && structuredClone(row);
  }

  children(requestId: string): SavedTask[] {
    return structuredClone([...this.rows.values()].filter(row => row.originRequestId === requestId));
  }

  groupTasks(groupId: string, roundId?: string): SavedTask[] {
    return structuredClone([...this.rows.values()].filter(row =>
      row.group?.groupId === groupId && (roundId === undefined || row.group.roundId === roundId)));
  }

  hasActive(botId: string): boolean {
    return [...this.rows.values()].some(row => row.botId === botId && running(row));
  }

  pending(): SavedTask[] {
    return structuredClone([...this.rows.values()].filter(row =>
      !('outcome' in row.state) || (row.state.reply && !row.state.reply.sent)));
  }

  list(botId: string, before?: string): { rows: SavedTask[]; more?: string } {
    const all = [...this.rows.values()].filter(row => row.botId === botId).reverse();
    const index = before ? all.findIndex(row => row.id === before) : -1;
    if (before && index < 0) throw new Error('Invalid task history cursor');
    const rows = all.slice(index + 1, index + 51);
    const more = all.length > index + 51 ? rows.at(-1)?.id : undefined;
    return { rows: structuredClone(rows), more };
  }

  private current(id: string, revision: number): SavedTask {
    const row = this.get(id);
    if (row.revision !== revision) throw new Error('The Bot task changed');
    return row;
  }
}
