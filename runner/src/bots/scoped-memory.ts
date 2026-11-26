import { join } from 'node:path';
import type { Projects } from '../projects.ts';
import { ErrorCode, RpcError } from '../protocol.ts';
import { canUseMemory, type MemoryActor, type MemoryScope } from './memory-policy.ts';
import { PersonalMemory } from './ported/personal-memory.js';
import type { BotRepository } from './repository.ts';

export type ScopeRef = { kind: MemoryScope['kind']; id: string };
type Group = { name: string; memberIds: readonly string[]; archived?: boolean };

export class ScopedMemory {
  private readonly options: {
    root: string; repo: BotRepository; projects?: Projects;
    group?: (id: string) => Group | undefined;
    redact?: (text: string) => string;
  };

  constructor(options: ScopedMemory['options']) { this.options = options; }

  catalog() {
    const { repo, projects } = this.options;
    return [
      ...repo.list().map(bot => ({ kind: 'bot' as const, id: bot.id, title: bot.name, archived: Boolean(bot.archivedAt) })),
      { kind: 'team' as const, id: repo.workspaceId(), title: 'Workspace team', archived: false },
      ...(projects?.list({ archived: true }) ?? []).map(project => ({ kind: 'project' as const, id: project.id, title: project.title, archived: Boolean(project.archived) })),
    ];
  }

  open(ref: ScopeRef, actor: MemoryActor, access: 'read' | 'write', explicit = false): PersonalMemory {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(ref.id)) throw new RpcError(ErrorCode.badParams, 'Invalid memory scope');
    const { root, repo, projects, group, redact } = this.options;
    const { kind, id } = ref;
    let scope: MemoryScope;
    let archived = false;
    switch (kind) {
      case 'bot': {
        const bot = repo.get(id);
        scope = { kind, id, private: Boolean(bot.privacy), teamId: repo.workspaceId() };
        archived = Boolean(bot.archivedAt);
        break;
      }
      case 'team':
        if (repo.workspaceId() !== id) throw new Error('Unknown Bot team');
        scope = { kind, id };
        break;
      case 'project': {
        const project = projects?.record(id);
        if (!project) throw new Error('Unknown project');
        scope = { kind, id };
        archived = Boolean(project.archived);
        break;
      }
      case 'group': {
        const room = group?.(id);
        if (!room) throw new Error('Unknown Bot group');
        scope = { kind, id, memberIds: room.memberIds };
        archived = room.archived === true;
        break;
      }
    }
    if ((archived && access === 'write') || !canUseMemory(actor, scope, access, explicit)) {
      throw new RpcError(ErrorCode.notAllowed, 'This actor cannot use that memory scope.');
    }
    // The original Bot folder stays exactly where P1 wrote it. All other
    // scopes are separate, with the same atomic journal and recovery rules.
    const folder = kind === 'bot' ? id : `${kind}-${id}`;
    return new PersonalMemory(join(root, 'memory', folder), { scope: kind === 'bot' ? 'own' : kind, base: root, redact });
  }
}
