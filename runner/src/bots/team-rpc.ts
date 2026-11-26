import { z } from 'zod';
import { PERMISSION_MODES, type PermissionMode } from '../protocol.ts';
import { method } from './rpc.ts';
import { teamGrant } from './team-state.ts';
import type { BotRepository } from './repository.ts';
import type { BotTeams } from './teams.ts';

const id = z.uuid();
const identity = z.object({ teamId: id });
const expected = identity.extend({ expectedRevision: z.int().positive() });
const title = z.string().trim().min(1).max(120);
const members = z.array(id);
type Workspace = {
  repo: BotRepository;
  teams: BotTeams;
  protect: () => void;
  now: () => string;
  setCeiling: (botId: string, expectedRevision: number, ceiling: PermissionMode) => Promise<unknown>;
};

export function teamMethods(workspace: () => Workspace): Record<string, (input: Record<string, unknown>) => unknown> {
  return {
    'bots.settings.permissionCeiling': method(z.object({ botId: id, expectedRevision: z.int().positive(), ceiling: z.enum(PERMISSION_MODES) }),
      ({ botId, expectedRevision, ceiling }) => workspace().setCeiling(botId, expectedRevision, ceiling)),
    'bots.teams.list': () => ({ teams: workspace().repo.teams() }),
    'bots.teams.get': method(identity, ({ teamId }) => ({ team: workspace().repo.team(teamId) })),
    'bots.teams.create': method(z.object({ title, memberIds: members }), ({ title, memberIds }) => {
      const { repo, protect, now } = workspace();
      protect();
      return { team: repo.createTeam(title, memberIds, now()) };
    }),
    'bots.teams.update': method(expected.extend({ title: title.optional(), memberIds: members.optional(), chiefEnabled: z.boolean().optional() }),
      ({ teamId, expectedRevision, ...draft }) => {
        const { repo, protect, now } = workspace();
        protect();
        return { team: repo.updateTeam(teamId, expectedRevision, draft, now()) };
      }),
    'bots.teams.setChief': method(expected.extend({ botId: id, main: z.boolean(), primary: z.boolean().optional(), replace: id.optional() }),
      ({ teamId, botId, expectedRevision, ...role }) => {
        const { repo, protect, now } = workspace();
        protect();
        return { team: repo.setChief(teamId, expectedRevision, botId, role, now()) };
      }),
    'bots.teams.setGrants': method(expected.extend({ botId: id, grant: teamGrant }), ({ teamId, expectedRevision, botId, grant }) => ({
      team: workspace().teams.ownerSetGrants(teamId, expectedRevision, botId, grant),
    })),
  };
}
