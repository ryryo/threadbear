import { join } from 'node:path';
import type { Runner } from '../runner.ts';
import type { ThreadRecord } from '../store.ts';
import { PersonalMemory, type MemoryNote } from './ported/personal-memory.js';
import type { BotRepository, Conversation } from './repository.ts';

export class BotConversations {
  private readonly runner: Runner;
  private readonly repo: BotRepository;
  private readonly root: string;

  constructor(runner: Runner, repo: BotRepository, root: string) {
    this.runner = runner;
    this.repo = repo;
    this.root = root;
  }

  create(botId: string, operationId: string): Conversation {
    const reserved = this.repo.reserveConversation(botId, operationId);
    const existing = this.runner.store.load(reserved.threadId);
    if (existing) {
      if (existing.botLink?.botId !== botId || existing.botLink.conversationId !== reserved.id) {
        throw new Error('The saved Thread does not match its Bot conversation');
      }
    } else {
      if (typeof reserved.sessionId !== 'string') throw new Error('This Bot conversation’s Thread is gone');
      this.runner.makeThread({ text: '', title: this.repo.get(botId).name }, {
        id: reserved.threadId,
        sessionId: reserved.sessionId,
        botLink: { botId, conversationId: reserved.id },
      });
    }
    return this.repo.confirmConversation(operationId, reserved.threadId);
  }

  private memoryFor(botId: string, threadId: string): PersonalMemory {
    const saved = this.runner.store.load(threadId)?.botLink;
    if (saved?.botId !== botId || !this.repo.conversations(botId).some(link => link.threadId === threadId && link.id === saved.conversationId)) {
      throw new Error('This Thread does not belong to this Bot');
    }
    return new PersonalMemory(join(this.root, 'memory', botId));
  }

  notes(botId: string, threadId: string): MemoryNote[] {
    return this.memoryFor(botId, threadId).list(this.runner.isoNow().slice(0, 10));
  }

  remember(botId: string, threadId: string, text: string): MemoryNote {
    return this.memoryFor(botId, threadId).add(text, { sourceThreadId: threadId }, this.runner.isoNow());
  }

  context(rec: ThreadRecord): string {
    const link = rec.botLink;
    if (!link) throw new Error('This Thread has no Bot link');
    const bot = this.repo.get(link.botId);
    if (bot.archivedAt) throw new Error('This Bot is archived');
    const notes = this.notes(bot.id, rec.id);
    return [
      `Bot name: ${bot.name}`,
      bot.role ? `Role: ${bot.role}` : '',
      bot.instructions ? `Bot instructions:\n${bot.instructions}` : '',
      notes.length ? `Notes saved by the user for this Bot:\n${notes.map(note => `- ${note.text}`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
  }
}
