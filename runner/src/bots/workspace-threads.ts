// A whole workspace uses the same Thread pack, placement, and adoption
// already used by MovesHost. It grants this exception only to its own
// frozen Bot Threads. Ordinary moves still cannot move one by itself.
import { z } from 'zod';
import { archive, MAX_UNPACKED_BYTES, sha256, unarchive, unpackedSize, type PackEntry } from '../move-pack.ts';
import { moveInfoFrom, type MoveRow } from '../moves.ts';
import { isThreadIdShape } from '../thread-id.ts';
import type { Runner } from '../runner.ts';
import type { ThreadRecord } from '../store.ts';
import type { BotWorkspaceIdentity } from './repository.ts';
import { assignedProjects, verifyTargetProjects, workspaceProjectId, type WorkspaceProjectChoice } from './workspace-projects.ts';
import type { BotWorkspaceTransfer, WorkspaceMoveProof } from './workspace-transfer.ts';

type Link = NonNullable<ThreadRecord['botLink']>;
export type WorkspaceThreadPack = {
  workspaceId: string; moveId: string; epoch: number; row: MoveRow; link: Link;
  entries: PackEntry[]; projectIds: string[];
};

const pathId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const threadPlan = z.object({
  workspaceId: pathId, moveId: pathId, epoch: z.number().int().positive(),
  link: z.object({ botId: pathId, conversationId: pathId, taskId: pathId.optional(), groupId: pathId.optional() }),
  projectIds: z.array(workspaceProjectId).max(512).default([]),
  row: z.object({
    moveId: z.string().regex(/^[0-9a-f]{64}$/), threadId: z.string().refine(isThreadIdShape),
    from: pathId, to: pathId, state: z.literal('unpacking'), expect: z.string(),
    info: z.unknown(), createdAt: z.number(), updatedAt: z.number(),
  }),
});

export function workspaceThreadPlan(bytes: Buffer) {
  return threadPlan.parse(JSON.parse(bytes.toString('utf8')));
}

export function workspaceThreadFiles(pack: WorkspaceThreadPack): PackEntry[] {
  const { entries, ...description } = pack;
  const folder = 'moves/' + pathId.parse(pack.row.threadId);
  return [
    { path: folder + '/plan.json', data: Buffer.from(JSON.stringify(description)) },
    { path: folder + '/files.pack', data: archive(entries) },
  ];
}

export function workspaceThreadPacks(items: PackEntry[], expected: { workspaceId: string; moveId: string; epoch: number }): WorkspaceThreadPack[] {
  if (items.length % 2) throw new Error('The Bot Thread transfer has an incomplete set of files.');
  const all = new Map(items.map(entry => [entry.path, entry.data]));
  if (all.size !== items.length) throw new Error('The Bot Thread transfer has duplicate files.');
  const out: WorkspaceThreadPack[] = [];
  let remaining = MAX_UNPACKED_BYTES;
  for (const [key, bytes] of all) {
    if (!key.endsWith('/plan.json')) continue;
    const plan = workspaceThreadPlan(bytes);
    const { workspaceId, moveId, epoch, row } = plan;
    const data = all.get('moves/' + row.threadId + '/files.pack');
    const info = moveInfoFrom(row.info);
    if (workspaceId !== expected.workspaceId || moveId !== expected.moveId || epoch !== expected.epoch ||
        key !== 'moves/' + row.threadId + '/plan.json' || !data || !info || remaining <= 0) {
      throw new Error('A Bot Thread transfer does not match the workspace manifest.');
    }
    const entries = unarchive(data, { maxUnpacked: remaining });
    remaining -= unpackedSize(entries);
    out.push({ ...plan, row: { ...row, info }, entries });
  }
  if (out.length * 2 !== items.length) throw new Error('The Bot Thread transfer contains unexpected files.');
  return out;
}

function matches(rec: ThreadRecord, threadId: string, link: Link): boolean {
  return rec.id === threadId && rec.botLink?.botId === link.botId && rec.botLink.conversationId === link.conversationId &&
    rec.botLink.groupId === link.groupId && rec.botLink.taskId === link.taskId && !rec.privateBotId && !rec.copied && !rec.botWorker;
}

export async function packWorkspaceThread(
  runner: Runner, transfer: BotWorkspaceTransfer, identity: BotWorkspaceIdentity, threadId: string,
  layout: { moveId: string; target: string; projects: WorkspaceProjectChoice },
  ownsLink: (link: Link) => boolean,
): Promise<WorkspaceThreadPack> {
  const frozen = transfer.progress();
  const rec = runner.threads.get(threadId)?.rec;
  const link = rec?.botLink;
  if (!frozen || frozen.state !== 'preparing' || frozen.moveId !== layout.moveId || frozen.target !== layout.target ||
      frozen.identity.workspaceId !== identity.workspaceId || frozen.identity.epoch !== identity.epoch ||
      frozen.identity.ownerRunnerId !== identity.ownerRunnerId || !rec || !link || !ownsLink(link) || !matches(rec, threadId, link)) {
    throw new Error('This Bot Thread does not belong to the frozen workspace.');
  }
  const projectIds = assignedProjects((rec.projects ?? []).map(project => project.id), layout.projects);
  if (!runner.moveIdle(threadId) || rec.queue.length) throw new Error('Wait for the Bot Thread to finish before moving it.');
  const permit = (candidate: ThreadRecord) => matches(candidate, threadId, link);
  const info = await runner.describeForMove(threadId, 0, permit);
  if (!info) throw new Error('The Bot Thread disappeared before it was packed.');
  const stable = sha256(Buffer.from(JSON.stringify([identity.workspaceId, identity.epoch, layout.moveId, threadId])));
  const row: MoveRow = {
    moveId: stable, threadId, from: identity.ownerRunnerId, to: layout.target, state: 'unpacking',
    expect: stable, info,
    createdAt: Date.parse(runner.isoNow()), updatedAt: Date.parse(runner.isoNow()),
  };
  const { entries, leftBehind } = await runner.packForMove(threadId, row, permit);
  entries.push({ path: 'move.json', data: Buffer.from(JSON.stringify({ leftBehind })) });
  return { workspaceId: identity.workspaceId, moveId: layout.moveId, epoch: identity.epoch, row, link, entries, projectIds };
}

export async function placeWorkspaceThread(
  runner: Runner, localRunnerId: string, pack: WorkspaceThreadPack,
  localChoice?: { cwd?: string; accountId?: string },
): Promise<MoveRow> {
  if (pack.row.to !== localRunnerId) throw new Error('This Bot Thread does not belong to the received workspace.');
  verifyTargetProjects(runner.projects, pack.projectIds);
  // A source can describe its machine. Only the target's own confirmed
  // placement can supply explicit local folder and login choices.
  const proposed = { ...pack.row, cwd: localChoice?.cwd, accountId: localChoice?.accountId };
  const plan = await runner.planMove(proposed);
  if ('problem' in plan) throw new Error(plan.problem);
  const row = { ...proposed, plan };
  if (runner.threads.has(row.threadId) || runner.store.load(row.threadId)) throw new Error('Another Thread already uses this identity.');
  if (!runner.movePlaced(row)) {
    const entries = pack.entries.map(entry => {
      if (entry.path !== 'thread/thread.json') return entry;
      const record = JSON.parse(entry.data.toString('utf8')) as ThreadRecord;
      // Only the separately verified destination mapping sets membership.
      delete record.projects;
      delete record.projectsLeft;
      delete record.projectsTold;
      return { ...entry, data: Buffer.from(JSON.stringify(record)) };
    });
    await runner.placeMove(row, entries, candidate => matches(candidate, row.threadId, pack.link));
  }
  return row;
}

export async function adoptWorkspaceThread(
  runner: Runner, pack: WorkspaceThreadPack, row: MoveRow, proof: WorkspaceMoveProof,
): Promise<void> {
  if (proof.state !== 'claimed' || proof.workspaceId !== pack.workspaceId || proof.moveId !== pack.moveId ||
      proof.ownerRunnerId !== row.to || proof.epoch !== pack.epoch + 1 || pack.row.moveId !== row.moveId ||
      pack.row.threadId !== row.threadId) throw new Error('The Bot workspace claim does not match this Thread.');
  const live = runner.store.load(row.threadId);
  if (live && !matches(live, row.threadId, pack.link)) throw new Error('Another Thread already uses this identity.');
  if (!live || !runner.threads.has(row.threadId)) {
    const moved = await runner.adoptMoved(row);
    if (!moved.adopted) throw new Error('The claimed Bot Thread could not be loaded.');
  }
  const memberships = runner.threads.get(row.threadId)?.rec.projects ?? [];
  const missing = pack.projectIds.filter(id => runner.projects?.record(id) && !memberships.some(project => project.id === id));
  if (missing.length) {
    // Reapply after a restart between adopting the Thread and saving its membership.
    // The destination may have deliberately removed a Project after claim.
    runner.projects?.changeMembership(row.threadId, { add: missing, by: 'mike' });
  }
}
