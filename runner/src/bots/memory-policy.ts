// Scope rules adapted from DS-Bot d104d9ca18d69a35460f14e15dff4d553181433a,
// src/host/memory.js: readScopes and writable. Multiple teams and Projects
// are Threadbear additions. Source: Apache-2.0, Fei2411 and contributors.
type Grant = { kind: 'bot' | 'team' | 'project'; id: string; write: boolean };
export type MemoryActor = { kind: 'owner' } | {
  kind: 'bot'; id: string; private: boolean;
  teamId?: string; groupId?: string; projectId?: string;
  grants: readonly Grant[];
};
export type MemoryScope =
  | { kind: 'bot'; id: string; private: boolean; teamId?: string }
  | { kind: 'team' | 'project'; id: string }
  | { kind: 'group'; id: string; memberIds: readonly string[] };

// The caller supplies the authenticated actor and current membership data from
// the workspace, never identities or grants taken from the tool input.
export function canUseMemory(actor: MemoryActor, scope: MemoryScope, access: 'read' | 'write', explicit = false): boolean {
  if (actor.kind === 'owner') return true;
  const writing = access === 'write';
  const granted = () => actor.grants.some(grant => grant.kind === scope.kind && grant.id === scope.id && (!writing || grant.write));
  switch (scope.kind) {
    case 'bot':
      if (actor.id === scope.id) return true;
      if (scope.private || scope.teamId === undefined || actor.teamId !== scope.teamId) return false;
      return writing ? !actor.private && granted() : explicit;
    case 'team':
      return actor.teamId === scope.id && (!writing || (!actor.private && granted()));
    case 'group':
      return !actor.private && actor.groupId === scope.id && scope.memberIds.includes(actor.id);
    case 'project':
      return actor.projectId === scope.id && (!writing || !actor.private) && granted();
  }
}
