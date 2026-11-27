import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ceilingMode, lowerMode, raises } from '../access.ts';
import { atomicWriteFileSync } from '../fsutil.ts';
import { sha256 } from '../move-pack.ts';
import { sealBytes } from '../secrets.ts';
import type { Runner } from '../runner.ts';
import type { ThreadRecord } from '../store.ts';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const scope = z.object({
  workspaceId: id, ownerRunnerId: id, epoch: z.number().int().positive(),
  botId: id, threadId: id, targetRunnerId: id, workerThread: id,
  requestId: id, profileRevision: z.number().int().positive(),
  ceiling: z.enum(['ask', 'auto', 'full']), expiresAt: z.number().int().positive(),
});
const grant = scope.extend({ sealed: z.base64().max(96_000) });
const payload = scope.extend({ title: z.string().min(1).max(200), instructions: z.string().max(40_000), text: z.string().trim().min(1).max(30_000) });
const record = z.object({ payload, digest: z.string().regex(/^[a-f0-9]{64}$/) });
export type BotWorkerGrant = z.infer<typeof grant>;
export type BotWorkerLink = Pick<BotWorkerGrant, 'workspaceId' | 'requestId' | 'botId' | 'ceiling'>;
type Work = z.infer<typeof record>;

export function workerSealInfo(input: z.infer<typeof scope>): string {
  // The existing sealing primitive derives the key with this exact scope.
  return 'threadbear Bot worker v1 ' + JSON.stringify(scope.parse(input));
}

function messageId(work: Work): string {
  return `bot-worker:${work.payload.workspaceId}:${work.payload.requestId}`;
}

type Options = {
  home: string; runner: Runner; runnerId: string;
  canWrite: () => boolean; protect: () => void;
  open: (bytes: Buffer, info: string) => Buffer;
};

export class BotWorkers {
  private readonly options: Options;

  constructor(options: Options) { this.options = options; }

  private path(idValue: string): string {
    return join(this.options.home, 'bot-workers', `${id.parse(idValue)}.json`);
  }

  private read(id: string): Work | undefined {
    const file = this.path(id);
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat) return undefined;
    if (!stat.isFile()) throw new Error('The Bot worker receipt must be a regular file.');
    return record.parse(JSON.parse(readFileSync(file, 'utf8')));
  }

  private thread(rec: ThreadRecord, work: Work): void {
    const link = rec.botWorker;
    const expected = work.payload;
    if (rec.copied || rec.id !== expected.workerThread || link?.requestId !== expected.requestId ||
        link.workspaceId !== expected.workspaceId || link.botId !== expected.botId || link.ceiling !== expected.ceiling) {
      throw new Error('This Thread does not match its saved Bot worker.');
    }
  }

  admit(raw: unknown): { threadId: string } {
    const received = grant.parse(raw);
    const { options } = this;
    if (!options.canWrite() || received.targetRunnerId !== options.runnerId || received.ownerRunnerId === options.runnerId) {
      throw new Error('This Runner cannot take the Bot worker request.');
    }
    const bytes = Buffer.from(received.sealed, 'base64');
    const digest = sha256(bytes);
    let work = this.read(received.workerThread);
    if (work && (work.digest !== digest || workerSealInfo(work.payload) !== workerSealInfo(received))) {
      throw new Error('This Bot worker does not match its original grant.');
    }
    if (!work) {
      if (received.expiresAt <= Date.parse(options.runner.isoNow())) throw new Error('The Bot worker grant has expired.');
      if (options.runner.store.load(received.workerThread)) throw new Error('The worker Thread is already in use.');
      const opened = this.open(bytes, received);
      if (workerSealInfo(opened) !== workerSealInfo(received)) throw new Error('The sealed work does not match the Bot grant.');
      work = { digest, payload: opened };
      options.protect();
      atomicWriteFileSync(this.path(received.workerThread), JSON.stringify(work) + '\n', 0o600);
    }
    const { runner } = options;
    const known = runner.store.load(received.workerThread);
    if (known) this.thread(known, work);
    const already = this.hasInput(work);
    if (already) return { threadId: received.workerThread };
    if (received.expiresAt <= Date.parse(runner.isoNow())) throw new Error('The Bot worker grant has expired before admission.');
    const { botId, workspaceId, requestId, ceiling } = received;
    if (!known) {
      const effective = ceilingMode(lowerMode(ceiling, runner.cfg.defaults.permissionMode ?? 'full'));
      runner.makeThread({
        text: '', title: work.payload.title, worktree: false, permissionMode: effective,
        startedBy: { kind: 'runner', label: 'Bot worker' },
      }, {
        id: received.workerThread, sessionId: received.workerThread,
        botLink: { botId, conversationId: requestId }, botWorker: { workspaceId, botId, requestId, ceiling },
      });
    }
    runner.send(received.workerThread, work.payload.text, [], {
      queue: true, origin: 'runner', ceiling, messageId: messageId(work),
      botWorker: requestId, botSource: { kind: 'runner' },
    });
    return { threadId: received.workerThread };
  }

  private open(bytes: Buffer, expected: BotWorkerGrant): Work['payload'] {
    try {
      return payload.parse(JSON.parse(this.options.open(bytes, workerSealInfo(expected)).toString('utf8')));
    } catch (cause) {
      throw new Error('The sealed work does not match the Bot grant.', { cause });
    }
  }

  private hasInput(work: Work): boolean {
    const threadId = work.payload.workerThread;
    const st = this.options.runner.threads.get(threadId);
    if (st?.rt.turn?.turnId === messageId(work) || st?.rec.queue.some(item => item.turnId === messageId(work))) return true;
    return this.options.runner.store.load(threadId) !== undefined && this.savedEvents(threadId).some(event =>
      event.type === 'user.message' && event.turnId === messageId(work));
  }

  private savedEvents(threadId: string) {
    const log = this.options.runner.store.log(threadId);
    return log.read(1, log.lastSeq);
  }

  context(rec: ThreadRecord): string {
    const work = this.read(rec.id);
    if (!work) throw new Error('This Bot worker has no saved grant.');
    this.thread(rec, work);
    return work.payload.instructions;
  }

  queue(threadId: string, requestId: string): 'allow' | 'drop' | 'wait' {
    if (!this.options.canWrite()) return 'wait';
    const work = this.read(threadId);
    const rec = this.options.runner.store.load(threadId);
    if (!work || !rec || work.payload.requestId !== requestId) return 'drop';
    this.thread(rec, work);
    return work.payload.expiresAt > Date.parse(this.options.runner.isoNow()) ? 'allow' : 'drop';
  }

  completed(): string[] {
    const root = join(this.options.home, 'bot-workers');
    const file = lstatSync(root, { throwIfNoEntry: false });
    if (!file?.isDirectory()) return [];
    const names = readdirSync(root);
    return names.filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)).filter(name => id.safeParse(name).success);
  }

  result(threadId: string): { workspaceId: string; requestId: string; threadId: string; seq: number } | undefined {
    const work = this.read(threadId);
    const rec = this.options.runner.store.load(threadId);
    if (!work || !rec) return undefined;
    this.thread(rec, work);
    const events = this.savedEvents(threadId).filter(event => 'turnId' in event && event.turnId === messageId(work));
    const done = events.findLast(event => event.type === 'turn.completed');
    if (!done) return undefined;
    const answer = done.outcome === 'completed' ? events.findLast(event => event.type === 'assistant.text' && event.text.trim()) ?? done : done;
    return { workspaceId: work.payload.workspaceId, requestId: work.payload.requestId, threadId, seq: answer.seq };
  }
}

const originRequest = z.object({
  threadId: id, targetRunnerId: id, operationId: id, text: z.string().trim().min(1).max(30_000),
});
export const workerResultParams = z.object({ requestId: id });
const originReceipt = z.object({ fingerprint: z.string(), request: grant });

type Source = Pick<BotWorkerGrant, 'workspaceId' | 'ownerRunnerId' | 'epoch' | 'botId' | 'profileRevision' | 'threadId' | 'ceiling'> & {
  title: string; instructions: string;
};
type Origin = {
  home: string; now: () => number; protect: () => void; source: (threadId: string) => Source;
  target: (workspaceId: string, epoch: number, runnerId: string) => Promise<string>;
  issue: (request: BotWorkerGrant) => Promise<unknown>;
};

export async function requestBotWorker(ports: Origin, raw: unknown): Promise<unknown> {
  const { threadId, targetRunnerId, operationId, text } = originRequest.parse(raw);
  const initial = ports.source(threadId);
  if (targetRunnerId === initial.ownerRunnerId) throw new Error('Choose another Runner for the Bot worker.');
  const path = join(ports.home, 'bot-worker-requests', initial.workspaceId, `${operationId}.json`);
  const fingerprint = sha256(Buffer.from(JSON.stringify([threadId, targetRunnerId, operationId, text])));
  const existing = (source: Source) => {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) return undefined;
    if (!stat.isFile()) throw new Error('The saved Bot worker request must be a regular file.');
    const prior = originReceipt.parse(JSON.parse(readFileSync(path, 'utf8')));
    if (prior.fingerprint !== fingerprint || prior.request.epoch !== source.epoch) {
      throw new Error('This operation already belongs to a different Bot worker request.');
    }
    if (prior.request.botId !== source.botId || raises(prior.request.ceiling, source.ceiling)) {
      throw new Error('The Bot worker scope changed after this request was saved.');
    }
    return prior.request;
  };
  const previous = existing(initial);
  if (previous) return ports.issue(previous);
  const key = await ports.target(initial.workspaceId, initial.epoch, targetRunnerId);
  const current = ports.source(threadId);
  if (current.workspaceId !== initial.workspaceId || current.epoch !== initial.epoch) throw new Error('The Bot workspace changed while the Runner was selected.');
  const arrived = existing(current);
  if (arrived) return ports.issue(arrived);
  const details = payload.parse({
    ...current, targetRunnerId, workerThread: randomUUID(), requestId: operationId,
    expiresAt: ports.now() + 5 * 60_000, text,
  });
  const sealed = sealBytes(key, Buffer.from(JSON.stringify(details)), workerSealInfo(details)).toString('base64');
  const request = grant.parse({ ...details, sealed });
  ports.protect();
  atomicWriteFileSync(path, JSON.stringify({ fingerprint, request }) + '\n', 0o600);
  return ports.issue(request);
}
