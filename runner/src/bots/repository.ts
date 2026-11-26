import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicWriteFileSync } from '../fsutil.ts';
import { EFFORT_LEVELS, PROVIDERS } from '../protocol.ts';
import { nameProblem } from './ported/mentions.js';

const id = z.uuid();
const revision = z.int().positive();
const modelBinding = z.object({
  accountId: z.string().min(1), provider: z.enum(PROVIDERS), model: z.string().min(1), effort: z.enum(EFFORT_LEVELS).optional(),
});
const bot = z.looseObject({
  id, name: z.string().min(1), role: z.string(), instructions: z.string(), revision,
  archivedAt: z.iso.datetime().optional(),
  modelBinding: modelBinding.optional(),
  reviewEnabled: z.boolean().optional(),
  privacy: z.object({ folder: z.string().min(1), operationId: z.uuid() }).optional(),
});
const conversation = z.looseObject({
  id, botId: id, threadId: id, operationId: z.string().min(1).max(128), configRevision: revision,
});
const pendingConversation = conversation.extend({ sessionId: id });
const state = z.looseObject({
  workspaceId: id, ownerRunnerId: z.string().min(1), ownerEpoch: revision, formatVersion: z.literal(1),
  bots: z.array(bot), conversations: z.array(conversation), pendingConversations: z.array(pendingConversation),
});
export type Bot = z.infer<typeof bot>;
export type Conversation = z.infer<typeof conversation>;
type PendingConversation = z.infer<typeof pendingConversation>;
type State = z.infer<typeof state>;
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
    return current;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { workspaceId: randomUUID(), ownerRunnerId, ownerEpoch: 1, formatVersion: 1, bots: [], conversations: [], pendingConversations: [] };
    }
    throw new Error('Could not read the Bot workspace', { cause: error });
  }
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

  get(id: string): Bot {
    const entry = this.current.bots.find(item => item.id === id);
    if (!entry) throw new Error('Unknown Bot');
    return structuredClone(entry);
  }

  private available(name: string, except?: string): void {
    if (this.current.bots.some(entry => entry.id !== except && normalize(entry.name) === normalize(name))) {
      throw new Error(`A Bot named ${name} already exists`);
    }
  }

  create({ name, role = '', instructions = '' }: Partial<BotSettings> & Pick<BotSettings, 'name'>): Bot {
    // DS-Bot holds a name while its async session setup runs. This transaction
    // commits the roster synchronously. Thread setup has a separate reservation.
    name = cleanName(name);
    this.available(name);
    const entry: Bot = { id: randomUUID(), name, role: role.trim().slice(0, 24).toWellFormed(), instructions: instructions.trim(), revision: 1 };
    this.save({ ...this.current, bots: [...this.current.bots, entry] });
    return structuredClone(entry);
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
    const entry = this.editable(id, expectedRevision);
    if (settings.name !== undefined && settings.name !== entry.name) {
      entry.name = cleanName(settings.name);
      this.available(entry.name, id);
    }
    if (settings.role !== undefined) entry.role = settings.role.trim().slice(0, 24).toWellFormed();
    if (settings.instructions !== undefined) entry.instructions = settings.instructions.trim();
    return this.saveBot(entry);
  }

  archive(id: string, expectedRevision: number, at: string): Bot {
    return this.saveBot({ ...this.editable(id, expectedRevision), archivedAt: at });
  }

  setModelBinding(id: string, expectedRevision: number, binding: Bot['modelBinding']): Bot {
    const entry = this.editable(id, expectedRevision);
    if (binding) entry.modelBinding = modelBinding.parse(binding);
    else delete entry.modelBinding;
    return this.saveBot(entry);
  }

  setReviewEnabled(id: string, expectedRevision: number, enabled: boolean): Bot {
    const entry = this.editable(id, expectedRevision);
    if ((entry.reviewEnabled ?? false) === enabled) return entry;
    return this.saveBot({ ...entry, reviewEnabled: enabled });
  }

  setPrivate(id: string, expectedRevision: number, folder: string, operationId: string, authorize: () => void): Bot {
    const current = this.get(id);
    if (current.privacy?.operationId === operationId) {
      if (current.privacy.folder !== folder) throw new Error('The operation id already names a different private folder');
      return current;
    }
    const entry = this.editable(id, expectedRevision);
    if (entry.privacy) throw new Error('This Bot already has a private folder');
    if (this.current.bots.some(bot => bot.privacy?.operationId === operationId)) throw new Error('The operation id already belongs to another Bot');
    if ([...this.current.conversations, ...this.current.pendingConversations].some(link => link.botId === id)) {
      throw new Error('This Bot already has conversations. Its shared history must be removed before it can become private.');
    }
    authorize();
    return this.saveBot({ ...entry, privacy: { folder, operationId } });
  }

  conversations(botId: string): Conversation[] {
    return structuredClone(this.current.conversations.filter(link => link.botId === botId));
  }

  reserveConversation(botId: string, operationId: string): Conversation | PendingConversation {
    const entry = this.get(botId);
    if (entry.archivedAt) throw new Error('This Bot is archived');
    const previous = this.current.conversations.find(link => link.operationId === operationId) ??
      this.current.pendingConversations.find(link => link.operationId === operationId);
    if (previous) {
      if (previous.botId !== botId) throw new Error('This operation already belongs to another Bot');
      return structuredClone(previous);
    }
    const pending = pendingConversation.parse({
      operationId, botId, configRevision: entry.revision, id: randomUUID(), threadId: randomUUID(), sessionId: randomUUID(),
    });
    this.save({ ...this.current, pendingConversations: [...this.current.pendingConversations, pending] });
    return structuredClone(pending);
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
