import { z } from 'zod';

const id = z.uuid();
const revision = z.int().positive();
const fields = z.enum(['name', 'role', 'instructions']);
const template = z.object({
  id: z.string().trim().min(1),
  role: z.string(),
  instructions: z.string(),
  accountId: z.string().min(1),
  model: z.string().min(1),
  folder: z.string().min(1),
  permissionCeiling: z.enum(['plan', 'ask', 'auto', 'full']),
});
export const teamGrant = z.object({
  createBot: z.object({ maxCreated: z.int().positive(), templates: z.array(template).min(1) }).optional(),
  updateOtherBot: z.object({ botIds: z.array(id), fields: z.array(fields) }).optional(),
  stopOtherBot: z.object({ botIds: z.array(id) }).optional(),
  createGroup: z.object({ memberBotIds: z.array(id), maxCreated: z.int().positive() }).optional(),
  updateGroup: z.object({ groupIds: z.array(id) }).optional(),
});
export const teamRecord = z.object({
  id,
  title: z.string().min(1),
  memberIds: z.array(id),
  chiefIds: z.array(id),
  chiefEnabled: z.boolean(),
  revision,
  grantByChief: z.record(id, teamGrant),
  audit: z.array(z.object({
    at: z.iso.datetime(),
    kind: z.enum(['created', 'membership', 'chief', 'grants', 'bot-created', 'bot-updated', 'bot-stopped']),
    botId: id.optional(),
    actorId: id.optional(),
    reason: z.string().optional(),
  })),
});
export type Team = z.infer<typeof teamRecord>;
export type TeamGrant = z.infer<typeof teamGrant>;
export type TeamAudit = Team['audit'][number];

export function validateTeam(team: Team, botIds: ReadonlySet<string>): void {
  const members = new Set(team.memberIds);
  if (members.size !== team.memberIds.length || team.memberIds.some(id => !botIds.has(id)) ||
      new Set(team.chiefIds).size !== team.chiefIds.length || team.chiefIds.some(id => !members.has(id)) ||
      (team.chiefEnabled && !team.chiefIds.length) ||
      Object.keys(team.grantByChief).some(id => !team.chiefIds.includes(id))) {
    throw new Error('Bot team has inconsistent member, Chief or grant identities');
  }
}
