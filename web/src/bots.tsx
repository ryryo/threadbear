import { useEffect, useRef, useState } from 'react';
import { msg, T, useMessages } from 'gt-react';
import { useConvex, useMutation } from 'convex/react';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { useLiveQuery } from './live';
import { go, threadPath } from './route';
import { CommandNote, useCommand } from './command-state';
import { clearErasedDrafts, dropManagedNoteDraft, managedNoteStoreId, managedNoteWasErased, matchesManagedNoteDraft, matchesNoteTarget, noteDraftTarget,
  readNoteDraft, removeManagedNoteDrafts, savedNoteDrafts, saveManagedNoteDraft, withManagedNoteStorage, type ErasureTarget } from './bot-note-drafts';

type Settings = { name: string; role: string; instructions: string };
type Profile = Settings & { id: string; revision: number };
type Draft = { base: Profile; settings: Settings; operationId: string; commandId?: Id<'commands'> };
type Result = { outcome: 'saved'; bot: Profile } | { outcome: 'conflict'; current: Profile };
const fields = ['name', 'role', 'instructions'] as const;

function load(key: string): Draft | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? 'null') as Draft | null;
    if (!saved || typeof saved.operationId !== 'string' || !Number.isInteger(saved.base?.revision) ||
        fields.some(field => typeof saved.base[field] !== 'string' || typeof saved.settings?.[field] !== 'string')) return null;
    return saved;
  } catch {
    return null;
  }
}

function persist(key: string, draft: object | null) {
  try {
    if (draft) sessionStorage.setItem(key, JSON.stringify(draft));
    else sessionStorage.removeItem(key);
  } catch {
    // The open tab keeps the draft if the browser has no available storage.
  }
}

function ProfileEditor({ token, workspaceId, runnerId, epoch, profile }: {
  token: string; workspaceId: string; runnerId: string; epoch: number; profile: Profile;
}) {
  const key = `bot-device-draft:${runnerId}:${workspaceId}:${epoch}:${profile.id}`;
  const translate = useMessages();
  const mutation = useMutation(api.phone.editBotProfile);
  const [editState, setEditState] = useState<Draft | 'saved' | null>(() => load(key));
  const draft = editState === 'saved' ? null : editState;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const report = useLiveQuery(api.phone.command, draft?.commandId ? { token, commandId: draft.commandId } : 'skip');
  const answer = report?.state === 'done' ? report.result as Result | undefined : undefined;
  const confirmed = answer?.outcome === 'saved';
  if (draft && confirmed && profile.revision >= answer.bot.revision) {
    setEditState('saved');
  }
  const settings = draft?.settings ?? profile;
  const conflict = answer?.outcome === 'conflict' ? answer.current : undefined;
  const changed = draft ? fields.filter(field => draft.base[field] !== settings[field]) : [];
  const waiting = saving || !!draft?.commandId &&
    (report === undefined || report?.state === 'pending' || report?.state === 'taken' || confirmed);
  const labels = {
    name: translate(msg('Bot name')),
    role: translate(msg('Role')),
    instructions: translate(msg('Instructions')),
  };

  useEffect(() => {
    persist(key, draft);
  }, [key, draft]);

  function edit(field: keyof Settings, value: string) {
    const base = draft?.base ?? profile;
    setEditState({
      base,
      settings: { name: settings.name, role: settings.role, instructions: settings.instructions, [field]: value },
      operationId: crypto.randomUUID(),
    });
    setError('');
  }

  async function save() {
    if (!draft || !changed.length || waiting || conflict) return;
    const partial = Object.fromEntries(changed.map(field => [field, draft.settings[field]]));
    setSaving(true);
    setError('');
    try {
      const commandId = await mutation({ token, runnerId,
        edit: { workspaceId, epoch, botId: profile.id, expectedRevision: draft.base.revision, operationId: draft.operationId, settings: partial },
      });
      setEditState({ ...draft, commandId });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return <article className="bot-device-profile">
    <h2>{profile.name}</h2>
    <form onSubmit={e => { e.preventDefault(); void save(); }}>
      <label>{labels.name}<input value={settings.name} onChange={e => edit('name', e.target.value)} disabled={waiting} required /></label>
      <label>{labels.role}<input value={settings.role} onChange={e => edit('role', e.target.value)} disabled={waiting} /></label>
      <label>{labels.instructions}<textarea value={settings.instructions} onChange={e => edit('instructions', e.target.value)} disabled={waiting} rows={4} /></label>
      <button type="submit" disabled={!changed.length || waiting || !!conflict}>{waiting ? <T>Waiting for Runner…</T> : <T>Save settings</T>}</button>
      {error || report?.state === 'failed' ? <p role="alert">{error || report?.note || <T>The Runner could not confirm the edit.</T>}</p> : null}
      {editState === 'saved' ? <p role="status"><T>Settings saved.</T></p> : null}
      {conflict && draft ? <div role="status">
        <h3><T>Settings changed on the Runner</T></h3>
        {changed.map(field => <div key={field}>
          <strong>{labels[field]}</strong>
          <p>{translate(msg('Saved: {value}'), { value: conflict[field] })}</p>
          <p>{translate(msg('Draft: {value}'), { value: settings[field] })}</p>
        </div>)}
        <button type="button" onClick={() => setEditState(null)}><T>Use saved settings</T></button>
        <button type="button" onClick={() => setEditState({
          base: conflict,
          settings: { ...conflict, ...Object.fromEntries(changed.map(field => [field, settings[field]])) },
          operationId: crypto.randomUUID(),
        })}><T>Continue editing my draft</T></button>
      </div> : null}
    </form>
  </article>;
}

type Workspace = FunctionReturnType<typeof api.phone.botWorkspaces>[number];
type Action = FunctionArgs<typeof api.phone.actOnBotWorkspace>['input']['action'];

function useWorkspaceAction(token: string, workspace: Workspace) {
  const mutation = useMutation(api.phone.actOnBotWorkspace);
  const command = useCommand<Action>(token, { keepDone: true });
  const [retry, setRetry] = useState<{ operationId: string; action: Action }>();
  const id = 'id' in command.state ? command.state.id : undefined;
  const reply = useLiveQuery(api.phone.command, id ? { token, commandId: id as Id<'commands'> } : 'skip');
  const result = reply?.state === 'done' ? reply.result as {
    outcome?: string; rows?: { id: string; text: string }[]; revision?: string; draft?: string;
  } | undefined : undefined;
  const send = (action: Action) => {
    const prior = retry && JSON.stringify(retry.action) === JSON.stringify(action) ? retry : undefined;
    const operationId = prior?.operationId ?? crypto.randomUUID();
    setRetry({ operationId, action });
    return command.run(() => mutation({ token, runnerId: workspace.ownerRunnerId,
      input: { workspaceId: workspace.workspaceId, epoch: workspace.epoch, operationId, action },
    }), action);
  };
  return { command, result, send };
}

type ActionDraft = { operationId: string; action: Action; commandId?: Id<'commands'> };
type ActionResult = { outcome: string; rows?: { id: string; text: string }[]; revision?: string; draft?: string };

function useActionDraft(token: string, workspace: Workspace, scopeKey: string, checkErasure = false, registerDrafts = false) {
  const convex = useConvex();
  const key = `bot-action-draft:${workspace.ownerRunnerId}:${workspace.workspaceId}:${workspace.epoch}:${scopeKey}`;
  const translate = useMessages();
  const mutation = useMutation(api.phone.actOnBotWorkspace);
  const [draft, setDraft] = useState<ActionDraft | null>(() => {
    try {
      const stored = readNoteDraft(localStorage, sessionStorage, key) as ActionDraft | null;
      return typeof stored?.operationId === 'string' && typeof stored.action?.kind === 'string' ? stored : null;
    } catch {
      return null;
    }
  });
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState('');
  const ownedSlot = useRef<string | undefined>(undefined);
  const registration = useRef<{ token: string; storeId: string; target: ErasureTarget; answer: Promise<boolean> } | undefined>(undefined);
  const reply = useLiveQuery(api.phone.command, draft?.commandId ? { token, commandId: draft.commandId } : 'skip');
  const result = reply?.state === 'done' ? reply.result as ActionResult | undefined : undefined;
  const waiting = sending || !!draft?.commandId && (reply === undefined || reply?.state === 'pending' || reply?.state === 'taken');

  useEffect(() => {
    if (!registerDrafts) { persist(key, draft); return; }
    const target = noteDraftTarget(workspace.workspaceId, draft?.action);
    let closed = false;
    async function keep() {
      if (!draft || !target) {
        if (!navigator.locks) {
          persist(key, draft);
          return;
        }
        await withManagedNoteStorage(() => {
          if (closed) return;
          dropManagedNoteDraft(localStorage, sessionStorage, key, ownedSlot.current);
          persist(key, draft);
        });
        return;
      }
      const storeId = await withManagedNoteStorage(() => managedNoteStoreId(localStorage, () => crypto.randomUUID()));
      if (closed) return;
      let checked = registration.current;
      if (!checked || checked.token !== token || checked.storeId !== storeId || !matchesNoteTarget(checked.target, target)) {
        checked = { token, storeId, target, answer: convex.mutation(api.phone.registerBotNoteDraft, { token, storeId, target }) };
        registration.current = checked;
      }
      let allowed;
      try { allowed = await checked.answer; }
      catch (error) {
        if (registration.current === checked) registration.current = undefined;
        throw error;
      }
      await withManagedNoteStorage(() => {
        if (closed) return;
        if (allowed && !ownedSlot.current && matchesManagedNoteDraft(localStorage, sessionStorage, key, draft)) return;
        const slot = ownedSlot.current ??= crypto.randomUUID();
        if (!allowed) removeManagedNoteDrafts(localStorage, sessionStorage, [target]);
        if (!allowed || !saveManagedNoteDraft(localStorage, sessionStorage, key, slot, draft)) {
          setDraft(current => matchesNoteTarget(noteDraftTarget(workspace.workspaceId, current?.action), target) ? null : current);
        }
      });
    }
    keep().catch(() => { /* Unregistered changes stay in this tab until the backend is available. */ });
    return () => { closed = true; };
  }, [convex, draft, key, registerDrafts, token, workspace.workspaceId]);

  const target = noteDraftTarget(workspace.workspaceId, draft?.action);
  const entryId = target?.entryId;
  const kind = target?.scope.kind;
  const scopeId = target?.scope.id;
  useEffect(() => {
    if (!checkErasure || !entryId || !kind || !scopeId) return;
    const target = { workspaceId: workspace.workspaceId, scope: { kind, id: scopeId }, entryId };
    const watch = convex.watchQuery(api.phone.botNoteErasures, { token, targets: [target] });
    function check() {
      try {
        if (!(registerDrafts && managedNoteWasErased(localStorage, target)) && watch.localQueryResult()?.[0] !== true) return;
        setDraft(current => matchesNoteTarget(noteDraftTarget(workspace.workspaceId, current?.action), target) ? null : current);
        clearErasedDrafts(sessionStorage, [{ key, target }], [true]);
        if (registerDrafts && !managedNoteWasErased(localStorage, target)) {
          withManagedNoteStorage(() => removeManagedNoteDrafts(localStorage, sessionStorage, [target])).catch(() => {});
        }
      } catch {
        // An unavailable backend provides no evidence that a draft was erased.
      }
    }
    const stop = watch.onUpdate(check);
    if (registerDrafts) window.addEventListener('storage', check);
    check();
    return () => {
      stop();
      if (registerDrafts) window.removeEventListener('storage', check);
    };
  }, [checkErasure, convex, entryId, key, kind, registerDrafts, scopeId, token, workspace.workspaceId]);

  function edit(action: Action | null) {
    setDraft(action ? { operationId: crypto.randomUUID(), action } : null);
    setProblem('');
  }

  async function submit(action?: Action) {
    if (waiting) return;
    const matchingRemoval = action?.kind === 'note.remove' && draft?.action.kind === 'note.remove' &&
      draft.action.entryId === action.entryId;
    const next = action && !matchingRemoval ? { action, operationId: crypto.randomUUID() } : draft;
    if (!next) return;
    setSending(true);
    setProblem('');
    setDraft(next);
    try {
      const commandId = await mutation({ token, runnerId: workspace.ownerRunnerId,
        input: { workspaceId: workspace.workspaceId, epoch: workspace.epoch, operationId: next.operationId, action: next.action },
      });
      setDraft(current => current?.operationId === next.operationId ? { ...next, commandId } : current);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  }

  return { draft: draft?.action, result, waiting, edit, submit,
    problem: problem || (reply?.state === 'failed' ? reply.note || translate(msg('The Runner refused the action.')) : '') };
}

function Notes({ token, workspace, scope, checkErasure, registerDrafts }: {
  token: string; workspace: Workspace; scope: Workspace['notes'][number]; checkErasure: boolean; registerDrafts: boolean;
}) {
  const translate = useMessages();
  const action = useActionDraft(token, workspace, `notes:${scope.scope}:${scope.scopeId}`, checkErasure, registerDrafts);
  const initial = { scope: { kind: scope.scope, id: scope.scopeId }, expectedRevision: scope.revision };
  const draft = action.draft?.kind === 'note.edit' || action.draft?.kind === 'note.add' ? action.draft : undefined;
  const saved = action.result?.outcome === 'saved';
  const conflict = action.result?.outcome === 'conflict';
  const disabled = action.waiting || conflict;
  const removal = action.draft?.kind === 'note.remove' ? action.draft : undefined;
  return <details>
    <summary><T>Notes</T></summary>
    {scope.rows.map(row => <p key={row.id}>{row.text}{row.pinned ? null : <>
      {' '}<button disabled={disabled} onClick={() => action.edit({ kind: 'note.edit', ...initial, entryId: row.id, text: row.text })}><T>Edit</T></button>
      {' '}<button disabled={disabled || !!draft && !saved} onClick={() => void action.submit({ kind: 'note.remove', ...initial, entryId: row.id })}><T>Remove</T></button>
    </>}</p>)}
    {removal && !saved && !scope.rows.some(row => row.id === removal.entryId) ?
      <button type="button" disabled={disabled} onClick={() => void action.submit()}><T>Retry removal</T></button> : null}
    <form onSubmit={event => {
      event.preventDefault();
      if (draft?.text.trim() && !disabled && !saved) void action.submit();
    }}>
      <label>{draft?.kind === 'note.edit' ? <T>Edit note</T> : <T>Add note</T>}<textarea value={draft?.text ?? ''} onChange={event => {
        const text = event.target.value;
        action.edit(draft && !saved ? { ...draft, text } : { kind: 'note.add', ...initial, text });
      }} rows={3} maxLength={300} disabled={disabled} /></label>
      <button disabled={disabled || saved || !draft?.text.trim()} type="submit"><T>Save note</T></button>
    </form>
    {action.waiting ? <p role="status"><T>Waiting for Runner…</T></p> : null}
    {action.problem ? <p role="alert">{action.problem}</p> : null}
    {saved ? <button onClick={() => action.edit(null)}><T>Clear saved draft</T></button> : null}
    {conflict ? <div role="status">
      <h3><T>Notes changed on the Runner</T></h3>
      {action.result?.rows?.map(row => <p key={row.id}>{translate(msg('Saved: {value}'), { value: row.text })}</p>)}
      {draft?.text ? <p>{translate(msg('Draft: {value}'), { value: draft.text })}</p> : null}
      <button onClick={() => action.edit(null)}><T>Use saved notes</T></button>
      {draft ? <button onClick={() => {
        if (action.result?.revision) action.edit({ ...draft, expectedRevision: action.result.revision });
      }}><T>Continue editing my draft</T></button> : null}
    </div> : null}
  </details>;
}

function GroupView({ token, workspace, group, checkErasure, registerDrafts }: {
  token: string; workspace: Workspace; group: Workspace['groups'][number]; checkErasure: boolean; registerDrafts: boolean;
}) {
  const translate = useMessages();
  const action = useActionDraft(token, workspace, `group:${group.id}`);
  const text = action.draft?.kind === 'group.post' ? action.draft.text : '';
  const saved = action.result?.outcome === 'saved';
  const scope = workspace.notes.find(row => row.scope === 'group' && row.scopeId === group.id);
  return <details className="bot-device-profile">
    <summary>{group.title}</summary>
    <p>{group.status}{group.queued ? <> · {translate(msg('{count} queued'), { count: group.queued })}</> : null}</p>
    {group.events.map(row => <p key={row.id}>{row.text}</p>)}
    {scope ? <Notes token={token} workspace={workspace} scope={scope} checkErasure={checkErasure} registerDrafts={registerDrafts} /> : null}
    <form onSubmit={event => { event.preventDefault(); if (text.trim() && !saved) void action.submit(); }}>
      <label><T>Message the Group</T><textarea value={text} rows={3} maxLength={30_000} onChange={event => {
        action.edit({ kind: 'group.post', groupId: group.id, text: event.target.value });
      }} disabled={action.waiting} /></label>
      <button type="submit" disabled={!text.trim() || action.waiting || saved}><T>Post to Group</T></button>
    </form>
    {action.waiting ? <p role="status"><T>Waiting for Runner…</T></p> : null}
    {action.problem ? <p role="alert">{action.problem}</p> : null}
    {saved ? <button onClick={() => action.edit(null)}><T>Clear sent draft</T></button> : null}
  </details>;
}

function TaskView({ token, workspace, task }: { token: string; workspace: Workspace; task: Workspace['tasks'][number] }) {
  const action = useWorkspaceAction(token, workspace);
  const busy = ['reserved', 'queued', 'running', 'waiting_work'].includes(task.status);
  return <div>
    <a href={threadPath(task.threadId)}>{task.title}</a> · {task.status}
    {busy ? <button disabled={action.command.busy} onClick={() => void action.send({
      kind: 'task.stop', taskId: task.id, expectedRevision: task.revision,
    })}><T>Stop task</T></button> : null}
    <CommandNote command={action.command} />
  </div>;
}

function StoredNoteSweep({ token }: { token: string }) {
  const convex = useConvex();
  useEffect(() => {
    const stops: (() => void)[] = [];
    try {
      const drafts = savedNoteDrafts(sessionStorage);
      for (let offset = 0; offset < drafts.length; offset += 32) {
        const batch = drafts.slice(offset, offset + 32);
        const watch = convex.watchQuery(api.phone.botNoteErasures, { token, targets: batch.map(draft => draft.target) });
        function check() {
          try {
            const answer = watch.localQueryResult();
            if (answer) clearErasedDrafts(sessionStorage, batch, answer);
          } catch {
            // Keep drafts if storage or the backend is unavailable.
          }
        }
        stops.push(watch.onUpdate(check));
        check();
      }
    } catch {
      // A tab with storage disabled has nothing to sweep.
    }
    return () => { for (const stop of stops) stop(); };
  }, [convex, token]);
  return null;
}

function ManagedNoteSweep({ token }: { token: string }) {
  const convex = useConvex();
  useEffect(() => {
    let closed = false;
    let checking = false;
    async function sweep() {
      if (checking || closed) return;
      checking = true;
      try {
        const storeId = await withManagedNoteStorage(() => managedNoteStoreId(localStorage, () => crypto.randomUUID()));
        let cursor: string | null = null;
        const visited = new Set<string>();
        do {
          if (closed) return;
          const page: FunctionReturnType<typeof api.phone.botNoteDraftErasures> = await convex.query(
            api.phone.botNoteDraftErasures, { token, storeId, ...(cursor === null ? {} : { cursor }) },
          );
          if (closed) return;
          if (page.targets.length) {
            const cleared = await withManagedNoteStorage(() => removeManagedNoteDrafts(localStorage, sessionStorage, page.targets));
            if (!closed && cleared.length) {
              await convex.mutation(api.phone.confirmBotNoteDraftErasures, { token, storeId, targets: cleared });
            }
          }
          cursor = page.cursor;
          if (cursor !== null && visited.has(cursor)) break;
          if (cursor !== null) visited.add(cursor);
        } while (cursor !== null);
      } catch {
        // A failed query or write stays pending until the next sweep.
      } finally {
        checking = false;
      }
    }
    void sweep();
    const timer = window.setInterval(() => { void sweep(); }, 10_000);
    return () => { closed = true; window.clearInterval(timer); };
  }, [convex, token]);
  return null;
}

export default function BotsPage({ token }: { token: string }) {
  const me = useLiveQuery(api.phone.me, { token });
  const capable = (me?.apiVersion ?? 0) >= 106;
  const checkErasure = (me?.apiVersion ?? 0) >= 108;
  const registerDrafts = (me?.apiVersion ?? 0) >= 110;
  const workspaces = useLiveQuery(api.phone.botWorkspaces, capable ? { token } : 'skip');
  return <main className="bot-device-page">
    <a href="/" onClick={e => { e.preventDefault(); go('/'); }}><T>Threads</T></a>
    <h1><T>Bots</T></h1>
    {checkErasure ? <StoredNoteSweep token={token} /> : null}
    {registerDrafts && navigator.locks ? <ManagedNoteSweep token={token} /> : null}
    {me && !capable ? <p><T>This backend needs an update to show Bots.</T></p> : null}
    {capable && workspaces === undefined ? <p><T>Loading Bots…</T></p> : null}
    {workspaces?.length === 0 ? <p><T>No Bot workspace is available on this device.</T></p> : null}
    {workspaces?.map(workspace => <section key={workspace.workspaceId}>
      {workspace.profiles.map(profile => <div key={`${workspace.epoch}:${profile.id}`}>
        <ProfileEditor token={token} workspaceId={workspace.workspaceId} runnerId={workspace.ownerRunnerId} epoch={workspace.epoch} profile={profile} />
        {workspace.notes.filter(scope => scope.scope === 'bot' && scope.scopeId === profile.id)
          .map(scope => <Notes key={scope.scopeId} token={token} workspace={workspace} scope={scope} checkErasure={checkErasure} registerDrafts={registerDrafts} />)}
      </div>)}
      {workspace.groups.map(group => <GroupView key={`${workspace.ownerRunnerId}:${workspace.epoch}:${group.id}`} token={token} workspace={workspace} group={group} checkErasure={checkErasure} registerDrafts={registerDrafts} />)}
      {workspace.tasks.map(task => <TaskView key={task.id} token={token} workspace={workspace} task={task} />)}
      {workspace.requests.map(request => <p key={request.id}><a href={threadPath(request.targetThreadId)}><T>Bot request</T></a> · {request.status}</p>)}
    </section>)}
  </main>;
}
