import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicWriteFileSync } from '../fsutil.ts';
import { EFFORT_LEVELS, PERMISSION_MODES, PROVIDERS } from '../protocol.ts';
import { nameProblem } from './ported/mentions.js';
import { setChief } from './chief-rules.ts';
import { teamGrant, teamRecord, validateTeam, type Team, type TeamAudit, type TeamGrant } from './team-state.ts';

const id = z.uuid();
const revision = z.int().positive();
export const botOperationId = z.string().min(1).max(128);
const modelBinding = z.object({
  accountId: z.string().min(1), provider: z.enum(PROVIDERS), model: z.string().min(1), effort: z.enum(EFFORT_LEVELS).optional(),
  useModelDefaultEffort: z.literal(true).optional(),
});
const bot = z.looseObject({
  id, name: z.string().min(1), role: z.string(), instructions: z.string(), revision,
  archivedAt: z.iso.datetime().optional(),
  copyOf: id.optional(),
  copyOperation: z.object({ id: botOperationId, sourceRevision: revision }).optional(),
  modelBinding: modelBinding.loose().optional(),
  workFolder: z.string().min(1).optional(),
  permissionCeiling: z.enum(PERMISSION_MODES).optional(),
  reviewEnabled: z.boolean().optional(),
  tidyEnabled: z.boolean().optional(),
  privacy: z.looseObject({ folder: z.string().min(1), operationId: botOperationId, moving: z.array(id).optional() }).optional(),
});
// A loose stored row preserves unknown data. A paired device gets the
// declared projection, including from persisted receipts made by older builds.
export const deviceProfile = bot.pick({ id: true, name: true, role: true, instructions: true, revision: true }).strip();
const profileReceipt = z.object({ id: botOperationId, fingerprint: z.string(), bot: deviceProfile });
const conversation = z.looseObject({
  id, botId: id, threadId: id, operationId: z.string().min(1).max(128), configRevision: revision,
  attached: z.literal(true).optional(),
});
const pendingConversation = conversation.extend({ sessionId: z.string().min(1).optional() })
  .refine(link => link.attached || id.safeParse(link.sessionId).success);
const state = z.looseObject({
  workspaceId: id, ownerRunnerId: z.string().min(1), ownerEpoch: revision, formatVersion: z.literal(1),
  bots: z.array(bot), conversations: z.array(conversation), pendingConversations: z.array(pendingConversation),
  teams: z.array(teamRecord).optional(),
  profileReceipts: z.array(profileReceipt).optional(),
  reviewOperations: z.array(z.object({ id: botOperationId, enabled: z.boolean(), setting: z.enum(['reviewEnabled', 'tidyEnabled']).optional(), bot })).optional(),
});
export type Bot = z.infer<typeof bot>;
export type Conversation = z.infer<typeof conversation>;
type PendingConversation = z.infer<typeof pendingConversation>;
type State = z.infer<typeof state>;
export type BotWorkspaceIdentity = { workspaceId: string; ownerRunnerId: string; epoch: number };
type BotSettings = Pick<Bot, 'name' | 'role' | 'instructions'>;

// Name handling from DS-Bot d104d9ca18d69a35460f14e15dff4d553181433a,
// src/host/roster.js and src/host/text.js.
// Copyright 2026 Fei2411 and the DS Bot contributors. Apache-2.0.
const normalize = (value: string) => value.trim().toLowerCase();
function cleanName(name: string): string {
  const text = name.trim().slice(0, 40).toWellFormed();
  const problem = nameProblem(text);
  if (problem) throw new Error(problem);
  return text;
}

function load(file: string, ownerRunnerId: string): State {
  try {
    if (!lstatSync(file).isFile()) throw new Error('Bot state must be a regular file');
    const current = state.parse(JSON.parse(readFileSync(file, 'utf8')));
    if (current.ownerRunnerId !== ownerRunnerId) throw new Error('This Runner does not own the Bot workspace');
    const links = [...current.conversations, ...current.pendingConversations];
    const botIds = new Set(current.bots.map(entry => entry.id));
    if (botIds.size !== current.bots.length || links.some(link => !botIds.has(link.botId)) ||
        [links.map(link => link.id), links.map(link => link.threadId), links.map(link => link.operationId)].some(keys => new Set(keys).size !== keys.length)) {
      throw new Error('Bot state contains inconsistent identities');
    }
    const teams = current.teams ?? [];
    const assigned = teams.flatMap(item => item.memberIds);
    if (new Set(teams.map(team => team.id)).size !== teams.length || new Set(assigned).size !== assigned.length) {
      throw new Error('Bot workspace has duplicate team identities or membership');
    }
    for (const team of teams) validateTeam(team, botIds);
    return current;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { workspaceId: randomUUID(), ownerRunnerId, ownerEpoch: 1, formatVersion: 1, bots: [], conversations: [], pendingConversations: [] };
    }
    throw new Error('Could not read the Bot workspace', { cause: error });
  }
}

function readWorkspaceTransferState(raw: string, from: BotWorkspaceIdentity): State {
  const current = state.parse(JSON.parse(raw));
  if (current.ownerRunnerId !== from.ownerRunnerId || current.workspaceId !== from.workspaceId || current.ownerEpoch !== from.epoch) {
    throw new Error('The saved Bot workspace identity does not match its transfer manifest.');
  }
  return current;
}

export function workspaceTransferConversations(raw: string, from: BotWorkspaceIdentity): Conversation[] {
  const current = readWorkspaceTransferState(raw, from);
  if (current.pendingConversations.length) throw new Error('Finish the reserved Bot conversations before moving this workspace.');
  return current.conversations;
}

// This is used only on a verified transfer bundle, never the source state.
export function rehomeBotWorkspaceState(raw: string, from: BotWorkspaceIdentity, runnerId: string): string {
  const current = readWorkspaceTransferState(raw, from);
  return JSON.stringify({ ...current, ownerRunnerId: runnerId, ownerEpoch: from.epoch + 1 }) + '\n';
}

/** The owning Runner holds its normal data lock for this repository's lifetime. */
export class BotRepository {
  private readonly file: string;
  private readonly beforeSave?: () => void;
  private current: State;

  constructor(root: string, ownerRunnerId: string, beforeSave?: () => void) {
    this.file = join(root, 'state.json');
    this.beforeSave = beforeSave;
    this.current = load(this.file, ownerRunnerId);
  }

  private save(next: State): void {
    this.beforeSave?.();
    atomicWriteFileSync(this.file, JSON.stringify(next) + '\n', 0o600);
    this.current = next;
  }

  list(): Bot[] {
    return structuredClone(this.current.bots);
  }

  workspaceId(): string { return this.current.workspaceId; }

  workspaceIdentity(): BotWorkspaceIdentity {
    const { workspaceId, ownerRunnerId, ownerEpoch } = this.current;
    return { workspaceId, ownerRunnerId, epoch: ownerEpoch };
  }

  get(id: string): Bot {
    const entry = this.current.bots.find(item => item.id === id);
    if (!entry) throw new Error('Unknown Bot');
    return structuredClone(entry);
  }

  teams(): Team[] {
    return structuredClone(this.current.teams ?? []);
  }

  team(id: string): Team {
    const row = this.current.teams?.find(team => team.id === id);
    if (!row) throw new Error('Unknown Bot team');
    return structuredClone(row);
  }

  teamIdForBot(botId: string): string {
    return this.current.teams?.find(team => team.memberIds.includes(botId))?.id ?? this.workspaceId();
  }

  private checkMembership(teamId: string, memberIds: string[]): string[] {
    const members = [...new Set(memberIds)];
    for (const id of members) {
      const bot = this.get(id);
      if (bot.archivedAt) throw new Error('An archived Bot cannot join a team');
      if (this.current.teams?.some(team => team.id !== teamId && team.memberIds.includes(id))) {
        throw new Error('This Bot already belongs to another team');
      }
    }
    return members;
  }

  private checkedTeam(id: string, expectedRevision: number): Team {
    const current = this.team(id);
    if (current.revision !== expectedRevision) throw new Error('The Bot team changed. Read its current settings.');
    return current;
  }

  private saveTeam(next: Team, event: TeamAudit, bots = this.current.bots): Team {
    const stored = teamRecord.parse({ ...next, audit: [...next.audit, event] });
    validateTeam(stored, new Set(bots.map(bot => bot.id)));
    const teams = this.current.teams ?? [];
    const rows = teams.some(item => item.id === next.id) ?
      teams.map(item => item.id === stored.id ? stored : item) : [...teams, stored];
    this.save({ ...this.current, bots, teams: rows });
    return structuredClone(stored);
  }

  createTeam(title: string, memberIds: string[], at: string): Team {
    const id = randomUUID();
    return this.saveTeam({
      id, title: title.trim(), memberIds: this.checkMembership(id, memberIds), chiefIds: [],
      chiefEnabled: false, revision: 1, grantByChief: {}, audit: [],
    }, { at, kind: 'created' });
  }

  updateTeam(id: string, expectedRevision: number, patch: { title?: string; memberIds?: string[]; chiefEnabled?: boolean }, at: string): Team {
    const current = this.checkedTeam(id, expectedRevision);
    const memberIds = patch.memberIds ? this.checkMembership(id, patch.memberIds) : current.memberIds;
    const chiefEnabled = patch.chiefEnabled ?? current.chiefEnabled;
    if (chiefEnabled && !current.chiefIds.length) throw new Error('Choose a Chief when enabling this role');
    const chiefIds = current.chiefIds.filter(chief => memberIds.includes(chief));
    if (chiefEnabled && chiefIds.length !== current.chiefIds.length) {
      throw new Error('Remove the current Chief role before removing a member');
    }
    const grantByChief = Object.fromEntries(Object.entries(current.grantByChief).filter(([chief]) => chiefIds.includes(chief)));
    return this.saveTeam({
      ...current, title: patch.title?.trim() ?? current.title, memberIds,
      chiefIds, chiefEnabled, grantByChief, revision: current.revision + 1,
    }, { at, kind: 'membership' });
  }

  setChief(id: string, expectedRevision: number, botId: string, change: { main: boolean; replace?: string; primary?: boolean }, at: string): Team {
    const current = this.checkedTeam(id, expectedRevision);
    if (!current.memberIds.includes(botId)) throw new Error('Only a Bot on this team can hold its Chief role');
    const bot = this.get(botId);
    const member = bot.archivedAt ? undefined : { id: bot.id, name: bot.name, private: Boolean(bot.privacy) };
    const chiefIds = setChief(current.chiefIds, member, change.main, change);
    const grantByChief = Object.fromEntries(Object.entries(current.grantByChief).filter(([chief]) => chiefIds.includes(chief)));
    return this.saveTeam({
      ...current, chiefIds, chiefEnabled: change.main || current.chiefEnabled,
      grantByChief, revision: current.revision + 1,
    }, { at, kind: 'chief', botId });
  }

  setTeamGrants(id: string, expectedRevision: number, chiefId: string, draft: TeamGrant, at: string): Team {
    const current = this.checkedTeam(id, expectedRevision);
    if (!current.chiefIds.includes(chiefId)) throw new Error('Only a Chief can hold team management grants');
    const grants = teamGrant.parse(draft);
    const targets = [...grants.updateOtherBot?.botIds ?? [], ...grants.stopOtherBot?.botIds ?? [], ...grants.createGroup?.memberBotIds ?? []];
    for (const botId of targets) {
      if (!current.memberIds.includes(botId) || this.get(botId).privacy) throw new Error('Management grants must refer to non-Private Bots on this team');
    }
    return this.saveTeam({ ...current, grantByChief: { ...current.grantByChief, [chiefId]: grants },
      revision: current.revision + 1 }, { at, kind: 'grants', botId: chiefId });
  }

  nameTaken(name: string, except?: string): boolean {
    return this.current.bots.some(entry => entry.id !== except && normalize(entry.name) === normalize(name));
  }

  private available(name: string, except?: string): void {
    if (this.nameTaken(name, except)) {
      throw new Error(`A Bot named ${name} already exists`);
    }
  }

  private buildBot({ name, role = '', instructions = '' }: Partial<BotSettings> & Pick<BotSettings, 'name'>): Bot {
    name = cleanName(name);
    this.available(name);
    return { id: randomUUID(), name, role: role.trim().slice(0, 24).toWellFormed(), instructions: instructions.trim(), revision: 1 };
  }

  create(settings: Partial<BotSettings> & Pick<BotSettings, 'name'>): Bot {
    // DS-Bot holds a name while its async session setup runs. This transaction
    // commits the roster synchronously. Thread setup has a separate reservation.
    const entry = this.buildBot(settings);
    this.save({ ...this.current, bots: [...this.current.bots, entry] });
    return structuredClone(entry);
  }

  copiedBot(copyOf: string, sourceRevision: number, operationId: string): Bot | undefined {
    botOperationId.parse(operationId);
    const prior = this.current.bots.find(item => item.copyOperation?.id === operationId);
    if (!prior) return undefined;
    if (prior.copyOf !== copyOf || prior.copyOperation?.sourceRevision !== sourceRevision) {
      throw new Error('This operation already belongs to another Bot copy');
    }
    return structuredClone(prior);
  }

  duplicateBot(copyOf: string, sourceRevision: number, operationId: string, settings: BotSettings &
    Pick<Bot, 'modelBinding' | 'workFolder'> & { color?: unknown; avatar?: unknown; sectionId?: unknown },
    protect?: () => void): Bot {
    const prior = this.copiedBot(copyOf, sourceRevision, operationId);
    if (prior) return prior;
    const source = this.get(copyOf);
    if (source.privacy) throw new Error(`${source.name} is private, so it cannot be copied`);
    this.editable(copyOf, sourceRevision);
    const { modelBinding, workFolder, color, avatar, sectionId } = settings;
    const entry: Bot = {
      ...this.buildBot(settings), copyOf, copyOperation: { id: operationId, sourceRevision },
      ...(modelBinding ? { modelBinding } : {}),
      ...(workFolder ? { workFolder } : {}),
      ...(typeof color === 'string' ? { color } : {}),
      ...(avatar && typeof avatar === 'object' ? { avatar } : {}),
      ...(typeof sectionId === 'string' ? { sectionId } : {}),
    };
    protect?.();
    this.save({ ...this.current, bots: [...this.current.bots, entry] });
    return structuredClone(entry);
  }

  createManagedBot(
    teamId: string, expectedRevision: number, actorId: string, at: string,
    settings: BotSettings & Required<Pick<Bot, 'modelBinding' | 'workFolder' | 'permissionCeiling'>>,
  ): { bot: Bot; team: Team } {
    const team = this.checkedTeam(teamId, expectedRevision);
    const { modelBinding, workFolder, permissionCeiling } = settings;
    const bot = { ...this.buildBot(settings), modelBinding, workFolder, permissionCeiling };
    const next = this.saveTeam({ ...team, memberIds: [...team.memberIds, bot.id], revision: team.revision + 1 },
      { at, kind: 'bot-created', actorId, botId: bot.id }, [...this.current.bots, bot]);
    return { bot: structuredClone(bot), team: next };
  }

  noteManagedStop(teamId: string, expectedRevision: number, actorId: string, botId: string, reason: string, at: string): Team {
    const team = this.checkedTeam(teamId, expectedRevision);
    return this.saveTeam({ ...team, revision: team.revision + 1 }, { at, kind: 'bot-stopped', actorId, botId, reason });
  }

  private editable(id: string, expectedRevision: number): Bot {
    const entry = this.get(id);
    if (entry.revision !== expectedRevision) throw new Error('This Bot changed. Reload its current settings before saving.');
    if (entry.archivedAt) throw new Error('This Bot is archived');
    return entry;
  }

  private saveBot(entry: Bot): Bot {
    entry.revision++;
    this.save({ ...this.current, bots: this.current.bots.map(item => item.id === entry.id ? entry : item) });
    return structuredClone(entry);
  }

  update(id: string, expectedRevision: number, settings: Partial<BotSettings>): Bot {
    return this.saveBot(this.editProfile(id, expectedRevision, settings));
  }

  updateWithReceipt(
    id: string, expectedRevision: number, draft: Partial<BotSettings>, operationId: string,
    protect?: () => void,
  ): { outcome: 'saved'; bot: z.output<typeof deviceProfile> } |
     { outcome: 'conflict'; current: z.output<typeof deviceProfile>; draft: Partial<BotSettings> } {
    botOperationId.parse(operationId);
    const current = this.get(id);
    if (current.privacy || current.archivedAt) throw new Error('This Bot is not editable from a connected device.');
    const fingerprint = createHash('sha256').update(JSON.stringify([
      id, expectedRevision, draft.name, draft.role, draft.instructions,
    ])).digest('hex');
    const all = this.current.profileReceipts ?? [];
    const known = all.find(receipt => receipt.id === operationId);
    if (known) {
      if (known.fingerprint !== fingerprint) throw new Error('That operation ID belongs to a different edit.');
      return { outcome: 'saved', bot: structuredClone(known.bot) };
    }
    if (current.revision !== expectedRevision) return { outcome: 'conflict', current: deviceProfile.parse(current), draft };
    const entry = this.editProfile(id, expectedRevision, draft);
    entry.revision++;
    const profile = deviceProfile.parse(entry);
    protect?.();
    this.save({
      ...this.current,
      bots: this.current.bots.map(item => item.id === id ? entry : item),
      profileReceipts: [...all, { id: operationId, fingerprint, bot: profile }],
    });
    return { outcome: 'saved', bot: profile };
  }

  private editProfile(id: string, expectedRevision: number, settings: Partial<BotSettings>): Bot {
    const entry = this.editable(id, expectedRevision);
    if (settings.name !== undefined && settings.name !== entry.name) {
      entry.name = cleanName(settings.name);
      this.available(entry.name, id);
    }
    if (settings.role !== undefined) entry.role = settings.role.trim().slice(0, 24).toWellFormed();
    if (settings.instructions !== undefined) entry.instructions = settings.instructions.trim();
    return entry;
  }

  updateManagedBot(
    teamId: string, expectedTeamRevision: number, actorId: string, botId: string, expectedBotRevision: number,
    settings: Partial<BotSettings>, at: string,
  ): { bot: Bot; team: Team } {
    const team = this.checkedTeam(teamId, expectedTeamRevision);
    const bot = this.editProfile(botId, expectedBotRevision, settings);
    bot.revision++;
    const next = this.saveTeam({ ...team, revision: team.revision + 1 },
      { at, kind: 'bot-updated', actorId, botId }, this.current.bots.map(item => item.id === botId ? bot : item));
    return { bot: structuredClone(bot), team: next };
  }

  setPermissionCeiling(id: string, expectedRevision: number, ceiling: Bot['permissionCeiling']): Bot {
    return this.saveBot({ ...this.editable(id, expectedRevision), permissionCeiling: ceiling });
  }

  archive(id: string, expectedRevision: number, at: string): Bot {
    if (this.current.teams?.some(team => team.chiefIds.includes(id))) throw new Error('Remove the Chief role before archiving this Bot');
    return this.saveBot({ ...this.editable(id, expectedRevision), archivedAt: at });
  }

  setModelBinding(id: string, expectedRevision: number, binding: Bot['modelBinding']): Bot {
    const entry = this.editable(id, expectedRevision);
    if (binding) entry.modelBinding = modelBinding.parse(binding);
    else delete entry.modelBinding;
    return this.saveBot(entry);
  }

  setAutomation(id: string, expectedRevision: number, setting: 'reviewEnabled' | 'tidyEnabled', enabled: boolean, operationId: string, authorize: () => void = () => {}): Bot {
    const prior = this.current.reviewOperations ?? [];
    const previous = prior.find(operation => operation.id === operationId);
    if (previous) {
      if (previous.bot.id !== id || previous.enabled !== enabled || (previous.setting ?? 'reviewEnabled') !== setting) throw new Error('The operation id already belongs to different memory settings');
      return structuredClone(previous.bot);
    }
    const entry = this.editable(id, expectedRevision);
    authorize();
    const updated = { ...entry, [setting]: enabled, revision: entry.revision + 1 };
    this.save({
      ...this.current, bots: this.current.bots.map(item => item.id === id ? updated : item),
      reviewOperations: [...prior, { id: operationId, enabled, setting, bot: updated }],
    });
    return structuredClone(updated);
  }

  setPrivate(id: string, expectedRevision: number, folder: string, operationId: string, moving: string[], authorize: () => void): Bot {
    const current = this.get(id);
    if (current.privacy?.operationId === operationId) {
      if (current.privacy.folder !== folder) throw new Error('The operation id already names a different private folder');
      return current;
    }
    const entry = this.editable(id, expectedRevision);
    if (entry.privacy) throw new Error('This Bot already has a private folder');
    if (this.current.teams?.some(team => team.chiefIds.includes(id))) throw new Error('Remove the Chief role before making this Bot private');
    if (this.current.bots.some(bot => bot.privacy?.operationId === operationId)) throw new Error('The operation id already belongs to another Bot');
    if (this.current.pendingConversations.some(link => link.botId === id)) {
      throw new Error('Finish creating this Bot’s conversation before changing its privacy.');
    }
    authorize();
    return this.saveBot({ ...entry, privacy: { folder, operationId, ...(moving.length ? { moving } : {}) } });
  }

  movingPrivateBot(threadId: string): string | undefined {
    return this.current.bots.find(bot => bot.privacy?.moving?.includes(threadId))?.id;
  }

  confirmPrivate(id: string, operationId: string): Bot {
    const entry = this.get(id);
    if (!entry.privacy || entry.privacy.operationId !== operationId) throw new Error('Unknown Private conversion');
    if (!entry.privacy.moving) return entry;
    const { moving: _moving, ...privacy } = entry.privacy;
    return this.saveBot({ ...entry, privacy });
  }

  conversations(botId: string): Conversation[] {
    return structuredClone(this.current.conversations.filter(link => link.botId === botId));
  }

  // A Thread owns its conversation across CLI session switches. A Bot's ID
  // cannot stand in for either identity (DS-Bot threads.js used that fallback).
  matchesConversation(botId: string, conversationId: string, threadId: string): boolean {
    return this.current.conversations.some(link => link.botId === botId && link.id === conversationId && link.threadId === threadId);
  }

  reserveConversation(botId: string, operationId: string): Conversation | PendingConversation {
    const entry = this.get(botId);
    if (entry.archivedAt) throw new Error('This Bot is archived');
    if (entry.privacy?.moving) throw new Error('Finish moving this Bot to its private folder first');
    const previous = this.current.conversations.find(link => link.operationId === operationId) ??
      this.current.pendingConversations.find(link => link.operationId === operationId);
    if (previous) {
      if (previous.botId !== botId || previous.attached) throw new Error('This operation already belongs to another Bot conversation');
      return structuredClone(previous);
    }
    const pending = pendingConversation.parse({
      operationId, botId, configRevision: entry.revision, id: randomUUID(), threadId: randomUUID(), sessionId: randomUUID(),
    });
    this.save({ ...this.current, pendingConversations: [...this.current.pendingConversations, pending] });
    return structuredClone(pending);
  }

  attachment(operationId: string, botId: string, threadId: string): Conversation | PendingConversation | undefined {
    botOperationId.parse(operationId);
    const previous = this.current.conversations.find(link => link.operationId === operationId) ??
      this.current.pendingConversations.find(link => link.operationId === operationId);
    if (!previous) return undefined;
    if (!previous.attached || previous.botId !== botId || previous.threadId !== threadId) {
      throw new Error('This operation already belongs to another Bot conversation');
    }
    return structuredClone(previous);
  }

  reserveAttachment(botId: string, expectedRevision: number, threadId: string, sessionId: string | undefined, operationId: string,
    protect?: () => void): PendingConversation {
    const bot = this.editable(botId, expectedRevision);
    if (bot.privacy) throw new Error('A Private Bot cannot attach an existing Thread');
    if (this.current.conversations.some(link => link.threadId === threadId) ||
        this.current.pendingConversations.some(link => link.threadId === threadId)) {
      throw new Error('This Thread already belongs to a Bot conversation or has an unfinished attachment');
    }
    const pending = pendingConversation.parse({
      id: randomUUID(), botId, threadId, sessionId, configRevision: bot.revision, operationId, attached: true,
    });
    protect?.();
    this.save({ ...this.current, pendingConversations: [...this.current.pendingConversations, pending] });
    return structuredClone(pending);
  }

  pendingAttachment(threadId: string): PendingConversation | undefined {
    const reservation = this.current.pendingConversations.find(link => link.attached && link.threadId === threadId);
    return reservation && structuredClone(reservation);
  }

  // The caller confirms only after the normal ThreadStore has written the link.
  confirmConversation(operationId: string, threadId: string): Conversation {
    const saved = this.current.conversations.find(link => link.operationId === operationId);
    if (saved?.threadId === threadId) return structuredClone(saved);
    const pending = this.current.pendingConversations.find(link => link.operationId === operationId);
    if (!pending || pending.threadId !== threadId) throw new Error('The Thread does not match the conversation reservation');
    const { sessionId: _sessionId, ...link } = pending;
    this.save({
      ...this.current,
      conversations: [...this.current.conversations, link],
      pendingConversations: this.current.pendingConversations.filter(item => item.operationId !== operationId),
    });
    return structuredClone(link);
  }
}
