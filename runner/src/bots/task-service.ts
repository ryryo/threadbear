// Task service with the stable, independent execution identity of DS-Bot's
// startTask. The Runner supplies its native Thread creation, queue and stop.
import { reconcileActiveTask, stopTask, type TaskEvidence } from './task-lifecycle.ts';
import type { SavedTask, StartTask, TaskJournal } from './task-journal.ts';

type Source = { botId: string; threadId: string; conversationId: string; folder: string; privateBotId?: string; taskId?: string; settings?: StartTask['settings'] };
type Request = Pick<StartTask, 'title' | 'brief' | 'operationId' | 'retryOf'> & { folder?: string };
type RecipientState = { kind: 'new' | 'unknown' } | { kind: 'accepted'; turnId: string };
type Ports = {
  journal: TaskJournal;
  source: (id: string) => Source;
  authorize: (source: Source, request: Request) => Promise<{ folder: string; ceiling?: StartTask['ceiling'] }>;
  parent: (source: Source) => string | undefined;
  admitted: (task: SavedTask) => RecipientState;
  openThread: (task: SavedTask, source: Source, folder: string) => void;
  enqueue: (task: SavedTask, text: string) => { turnId: string };
  stop: (task: SavedTask) => Promise<void>;
  clock: () => string;
};

export class BackgroundBotTasks {
  private readonly ports: Ports;
  private readonly inFlight = new Map<string, Promise<SavedTask>>();

  constructor(ports: Ports) { this.ports = ports; }

  async start(sourceId: string, input: Request): Promise<SavedTask> {
    const { source, authorize, parent, journal, clock, admitted, openThread, enqueue } = this.ports;
    const known = journal.operation(sourceId, input.operationId, input.title, input.brief, input.folder, input.retryOf);
    if (known && known.state.status !== 'reserved') return known;
    const origin = source(sourceId);
    if (origin.taskId) throw new Error('Background tasks cannot start nested background tasks.');
    const { folder, ceiling } = await authorize(origin, known?.folder ? { ...input, folder: known.folder } : input);
    const current = source(sourceId);
    if (current.botId !== origin.botId || current.conversationId !== origin.conversationId ||
        current.privateBotId !== origin.privateBotId || current.folder !== origin.folder) {
      throw new Error('The original conversation changed while its task was being approved.');
    }
    const task = journal.reserve({
      operationId: input.operationId, botId: origin.botId, sourceThreadId: origin.threadId,
      sourceConversationId: origin.conversationId, originRequestId: parent(origin),
      title: input.title, brief: input.brief, folder, requestedFolder: input.folder, ceiling,
      retryOf: input.retryOf, privateBotId: origin.privateBotId, settings: current.settings,
    }, clock());
    if (task.state.status !== 'reserved') return task;
    const existing = this.inFlight.get(task.id);
    if (existing) return existing;
    const run = Promise.resolve().then(() => {
      const saved = journal.get(task.id);
      if (saved.state.status !== 'reserved') return saved;
      const known = admitted(saved);
      if (known.kind === 'unknown') throw new Error('The previous task input could not be confirmed');
      if (known.kind === 'accepted') return journal.progress(saved.id, saved.revision, clock(), { status: 'queued', turnId: known.turnId });
      if (saved.folder && saved.folder !== folder) throw new Error('The task folder changed while the request was pending.');
      openThread(saved, current, saved.folder ?? folder);
      const { turnId } = enqueue(saved, input.brief);
      return journal.progress(saved.id, saved.revision, clock(), { status: 'queued', turnId });
    });
    this.inFlight.set(task.id, run);
    try { return await run; }
    finally { this.inFlight.delete(task.id); }
  }

  async cancel(taskId: string, expectedRevision: number, notifyParent = true): Promise<{ stopped: boolean; saved: boolean }> {
    const { journal, stop, clock } = this.ports;
    const task = journal.get(taskId);
    if (task.revision !== expectedRevision) throw new Error('The task changed before it was stopped.');
    if ('outcome' in task.state) return { stopped: false, saved: true };
    let durable = true;
    const stopped = await stopTask(true, async () => {
      try {
        journal.finish(task.id, task.revision, clock(), 'stopped', 'Stopped by the owner.', undefined, notifyParent && task.originRequestId !== undefined);
      } catch {
        durable = false;
      }
    }, () => stop(task));
    return { stopped, saved: durable };
  }

  recover(task: SavedTask, evidence: TaskEvidence): SavedTask {
    const { journal, clock } = this.ports;
    if ('outcome' in task.state) return task;
    if (task.state.status === 'reserved') {
      const admitted = this.ports.admitted(task);
      if (admitted.kind !== 'accepted') return task;
      task = journal.progress(task.id, task.revision, clock(), { status: 'queued', turnId: admitted.turnId });
    }
    const next = reconcileActiveTask(evidence);
    if (next === 'active' || next === task.state.status) return task;
    if (next === 'waiting_work' && 'turnId' in task.state) {
      return journal.progress(task.id, task.revision, clock(), { status: next, turnId: task.state.turnId });
    }
    return journal.finish(task.id, task.revision, clock(), 'interrupted', 'The Runner stopped before this task finished.', undefined, true);
  }
}
