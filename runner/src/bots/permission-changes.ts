// Adapt the per-Bot request ordering and guarded restore from DS-Bot
// src/host/permissions.js at d104d9ca18d69a35460f14e15dff4d553181433a, L49–119.
// Copyright 2026 Fei2411 and the DS Bot contributors. Apache-2.0.
import type { PermissionMode as Mode } from '../protocol.ts';
type Revision = { revision: number; ceiling: Mode };
type Ports = {
  read: (botId: string) => Revision;
  threads: (botId: string) => readonly string[];
  apply: (threadId: string, readMode: () => Mode | undefined) => Promise<void>;
  snapshot?: (threadId: string) => (() => void) | undefined;
  commit: (botId: string, expectedRevision: number, mode: Mode) => void;
  warn: (threadId: string, error: unknown) => void;
};

export class PermissionChanges {
  private readonly ports: Ports;
  private readonly requests = new Map<string, { seq: number; applied: Mode }>();

  constructor(ports: Ports) { this.ports = ports; }

  async set(botId: string, expectedRevision: number, wanted: Mode): Promise<void> {
    const { read, threads, apply, commit, warn } = this.ports;
    const initial = read(botId);
    if (initial.revision !== expectedRevision) throw new Error('The Bot changed before applying its permission.');
    const request = this.requests.get(botId) ?? { seq: 0, applied: initial.ceiling };
    const mine = ++request.seq;
    this.requests.set(botId, request);
    const current = () => request.seq === mine;
    const applyTo = (threadId: string) => apply(threadId, () => current() ? wanted : undefined);
    const snapshots = new Map<string, () => void>();
    try {
      for (const threadId of threads(botId)) {
        if (!current()) break;
        const restore = this.ports.snapshot?.(threadId);
        if (restore) snapshots.set(threadId, restore);
        await applyTo(threadId);
      }
      if (!current()) throw new Error('The Bot permission was superseded.');
      commit(botId, expectedRevision, wanted);
      request.applied = wanted;
    } catch (error) {
      if (current()) {
        const fallback = request.applied;
        const restoreTo = (threadId: string) => apply(threadId, () => current() ? fallback : undefined);
        for (const threadId of threads(botId)) {
          if (!current()) break;
          try {
            const restore = snapshots.get(threadId);
            if (this.ports.snapshot) restore?.();
            else await restoreTo(threadId);
          } catch (failure) {
            warn(threadId, failure);
          }
        }
      }
      throw error;
    } finally {
      if (current()) this.requests.delete(botId);
    }
  }
}
