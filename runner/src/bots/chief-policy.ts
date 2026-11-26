// Chief checks adapt the create_bot and update_bot gates in DS-Bot's
// ds-bot/src/host/tools.js at d104d9ca18d69a35460f14e15dff4d553181433a.
// Copyright 2026 Fei2411 and the DS Bot contributors. Apache-2.0.
type Bot = { id: string; name: string; private?: boolean };
type ProfileField = 'name' | 'role' | 'instructions';
type Template = {
  id: string;
  role: string;
  instructions: string;
  accountId: string;
  model: string;
  folder: string;
  permissionCeiling: 'plan' | 'ask' | 'auto' | 'full';
};
type Grants = {
  createBot: { maxCreated: number; templates: Template[] };
  updateOtherBot: { botIds: string[]; fields: ProfileField[] };
  stopOtherBot: { botIds: string[] };
  createGroup: { memberBotIds: string[]; maxCreated: number };
  updateGroup: { groupIds: string[] };
};

export type TeamAuthority = {
  chiefEnabled: boolean;
  chiefIds: readonly string[];
  revision: number;
  grantByChief: Readonly<Record<string, Partial<Grants>>>;
};

export function chiefGrant<K extends keyof Grants>(
  team: TeamAuthority,
  caller: Bot,
  operation: K,
  expectedRevision: number,
): Grants[K] {
  if (team.revision !== expectedRevision) throw new Error('The Bot team changed. Read its current settings.');
  if (caller.private || !team.chiefEnabled || !team.chiefIds.includes(caller.id)) {
    throw new Error('Only a Chief in this Bot team can do this.');
  }
  const grant = team.grantByChief[caller.id]?.[operation];
  if (!grant) throw new Error('The owner has not allowed this Chief to perform that operation.');
  return grant;
}
