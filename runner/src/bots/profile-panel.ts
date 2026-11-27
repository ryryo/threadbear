import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { z } from 'zod';
import type { BotAppearancePatch } from './repository.ts';
import { copyAppearance, MAX_AVATAR_IMAGE } from './ported/roster-copy.js';
import type { AvatarLibrary } from './ported/avatar-library.js';

type Profile = { id: string; name: string; role: string; instructions: string; revision: number; color?: unknown; avatar?: unknown };
type Patch = Pick<Profile, 'name'> | Pick<Profile, 'role'> | Pick<Profile, 'instructions'>;
type Ports = {
  read: (botId: string) => Profile | undefined;
  countMemory: (botId: string) => number;
  update: (botId: string, revision: number, patch: Patch) => Profile;
  updateAppearance?: (botId: string, revision: number, patch: BotAppearancePatch) => Profile;
  avatarLibrary?: AvatarLibrary;
  now?: () => number;
};
export type ProfileMemoryRequest = { id: string; botId: string };
type Lease = ProfileMemoryRequest & {
  expires: number; connected: () => boolean; openMemory: (request: ProfileMemoryRequest) => void; memoryOpened?: true;
};
const loopback = '127.0.0.1';
const lifetime = 30 * 60_000;
const maxBody = 64 * 1024;
const maxAppearanceBody = MAX_AVATAR_IMAGE + 1024;
const libraryPath = '/api/avatar-library';
const batchSize = 20;
const libraryPage = z.strictObject({ offset: z.coerce.number().int().min(0).max(500).optional(), limit: z.coerce.number().int().min(1).max(48).optional() });
const photos = z.strictObject({ items: z.array(z.strictObject({ name: z.string().max(1024), image: z.string().max(MAX_AVATAR_IMAGE) })).min(1).max(batchSize) });
const photoId = z.strictObject({ id: z.string().regex(/^[a-f0-9]{64}$/) });
export const openProfilePanelInput = z.strictObject({ botId: z.uuid() });
export const closeProfilePanelInput = z.strictObject({ id: z.string().regex(/^[a-f0-9]{64}$/) });
const revision = z.int().positive();
const edit = z.union([
  z.strictObject({ expectedRevision: revision, name: z.string().trim().min(1).max(40) }),
  z.strictObject({ expectedRevision: revision, role: z.string().max(24) }),
  z.strictObject({ expectedRevision: revision, instructions: z.string() }),
]);
const appearance = z.strictObject({
  expectedRevision: revision,
  color: z.string().max(32).nullable().optional(),
  avatar: z.strictObject({
    shape: z.string().regex(/^[a-z][\w-]{0,31}$/).optional(),
    image: z.string().max(MAX_AVATAR_IMAGE).optional(),
  }).refine(avatar => avatar.shape !== undefined || avatar.image !== undefined).nullable().optional(),
}).refine(patch => patch.color !== undefined || patch.avatar !== undefined);
const source = new URL('./profile-panel/', import.meta.url);
const html = '<!doctype html><meta charset="utf-8"><title>Bot profile</title><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/profile.css"><link rel="stylesheet" href="/avatar.css"><link rel="stylesheet" href="/layout.css"><div id="root"></div><script type="module" src="/profile.js"></script>';
const csp = "default-src 'none'; script-src 'self'; style-src 'self'; img-src data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

function send(res: ServerResponse, status: number, type: string, body: string | Buffer) {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

function json(res: ServerResponse, status: number, body: object) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(body));
}

function publicProfile({ id, name, role, instructions, revision, color, avatar }: Profile): Profile {
  const fields = { id, name, role, instructions, revision };
  try {
    return { ...fields, ...copyAppearance({ color, avatar }) };
  } catch {
    return { ...fields, ...copyAppearance({ color }) };
  }
}

async function jsonBody(req: IncomingMessage, limit: number): Promise<unknown> {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) return undefined;
  const size = Number(req.headers['content-length']);
  if (!Number.isSafeInteger(size) || size < 2 || size > limit) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    return undefined;
  }
}

/** Dedicated local origin for the first-party Bot profile view. Its lease
 * belongs to the visible Bot and is never put into Thread or patch metadata. */
export class ProfilePanelServer {
  private server?: Server;
  private binding?: Promise<string>;
  private origin?: string;
  private lease?: Lease;
  private readonly ports: Ports;
  private readonly now: () => number;

  constructor(ports: Ports) {
    this.ports = ports;
    this.now = ports.now ?? Date.now;
  }

  async open(botId: string, connected: () => boolean, openMemory: Lease['openMemory']): Promise<{ id: string; url: string }> {
    if (!connected() || !this.read(botId)) throw new Error('This Bot profile cannot be edited now.');
    const origin = await (this.binding ??= this.listen());
    if (!connected() || !this.read(botId)) throw new Error('This Bot profile cannot be edited now.');
    const id = randomBytes(32).toString('hex');
    this.lease = { id, botId, expires: this.now() + lifetime, connected, openMemory };
    return { id, url: `${origin}/#${id}` };
  }

  close(id: string) {
    if (this.lease?.id === id) this.lease = undefined;
  }

  async dispose() {
    this.lease = undefined;
    const server = this.server;
    this.server = undefined;
    this.binding = undefined;
    this.origin = undefined;
    if (server) {
      await new Promise<void>(resolve => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  }

  private listen(): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = createServer({ requestTimeout: 6_000, headersTimeout: 5_000, keepAliveTimeout: 1_000 }, (req, res) => {
        this.serve(req, res).catch(() => {
          if (!res.headersSent) json(res, 500, { error: 'Could not open the Bot profile.' });
          else res.end();
        });
      });
      this.server = server;
      server.unref();
      server.once('error', error => {
        if (this.server === server) {
          this.server = undefined;
          this.binding = undefined;
        }
        reject(error);
      });
      server.listen(0, loopback, () => {
        const address = server.address();
        if (!address || typeof address === 'string') { reject(new Error('The Bot profile listener is unavailable.')); return; }
        this.origin = `http://${loopback}:${address.port}`;
        resolve(this.origin);
      });
    });
  }

  private read(botId: string): Profile | undefined {
    try {
      return this.ports.read(botId);
    } catch {
      return undefined;
    }
  }

  private approved(req: IncomingMessage): Lease | undefined {
    const current = this.lease;
    if (current && current.id === req.headers['x-threadbear-profile'] && current.expires > this.now() && current.connected()) return current;
    return undefined;
  }

  private async serve(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (req.socket.remoteAddress !== loopback || `http://${req.headers.host}` !== this.origin) {
      return json(res, 403, { error: 'Open the Bot profile from Threadbear.' });
    }
    if (req.method === 'GET') {
      if (req.url === '/' || /^\/\?lang=(?:en|ja)&theme=(?:light|dark)$/.test(req.url ?? '')) return send(res, 200, 'text/html; charset=utf-8', html);
      if (req.url === '/profile.css') return send(res, 200, 'text/css; charset=utf-8', readFileSync(new URL('profile-cards.css', source)));
      if (req.url === '/avatar.css') return send(res, 200, 'text/css; charset=utf-8', readFileSync(new URL('avatar.css', source)));
      if (req.url === '/layout.css') return send(res, 200, 'text/css; charset=utf-8', readFileSync(new URL('profile-layout.css', source)));
      if (req.url === '/profile.js') {
        res.setHeader('Content-Encoding', 'gzip');
        return send(res, 200, 'text/javascript; charset=utf-8', readFileSync(new URL('profile.js.gz', source)));
      }
    }
    const count = req.method === 'GET' && req.url === '/api/memory-count';
    const navigate = req.method === 'POST' && req.url === '/api/open-memory';
    const profileRequest = req.url === '/api/profile' && (req.method === 'GET' || req.method === 'PATCH');
    const setAppearance = req.url === '/api/appearance' && req.method === 'PATCH' ? this.ports.updateAppearance : undefined;
    const library = req.url?.split('?')[0] === libraryPath ? this.ports.avatarLibrary : undefined;
    if (!profileRequest && !count && !navigate && !setAppearance && !library) {
      return json(res, 404, { error: 'There is no such Bot profile resource.' });
    }
    const lease = this.approved(req);
    const profile = lease && this.read(lease.botId);
    const forbidden = () => json(res, 403, { error: 'Reopen this Bot profile in Threadbear.' });
    if (!lease || !profile) return forbidden();
    if (library) return this.serveLibrary(req, res, library, () => this.approved(req) === lease && this.read(lease.botId) !== undefined);
    if (count) return json(res, 200, { count: this.ports.countMemory(lease.botId) });
    if (req.method === 'GET') return json(res, 200, publicProfile(profile));
    if (req.headers.origin !== this.origin) return forbidden();
    if (navigate) {
      if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? '0') !== 0) {
        return json(res, 400, { error: 'Choose Manage on the selected Bot.' });
      }
      if (!lease.memoryOpened) {
        lease.memoryOpened = true;
        lease.openMemory({ id: lease.id, botId: lease.botId });
      }
      return json(res, 200, {});
    }
    const raw = await jsonBody(req, setAppearance ? maxAppearanceBody : maxBody);
    if (this.approved(req) !== lease || !this.read(lease.botId)) return forbidden();
    try {
      if (setAppearance) {
        const fields = appearance.safeParse(raw).data;
        if (!fields) return json(res, 400, { error: 'Choose a valid Bot character, photo, or color.' });
        const { expectedRevision, ...patch } = fields;
        return json(res, 200, { bot: publicProfile(setAppearance(lease.botId, expectedRevision, patch)) });
      }
      const body = edit.safeParse(raw).data;
      if (!body) return json(res, 400, { error: 'Choose one valid profile field to save.' });
      const { expectedRevision, ...field } = body;
      const saved = this.ports.update(lease.botId, expectedRevision, field);
      return json(res, 200, { bot: publicProfile(saved) });
    } catch (error) {
      return json(res, 409, { error: error instanceof Error ? error.message : 'Could not save that profile.' });
    }
  }

  private async serveLibrary(req: IncomingMessage, res: ServerResponse, library: AvatarLibrary, isCurrent: () => boolean) {
    const forbidden = () => json(res, 403, { error: 'Reopen this Bot profile in Threadbear.' });
    const authorize = () => {
      if (!isCurrent()) throw new Error('Reopen this Bot profile in Threadbear.');
    };
    try {
      if (req.method === 'GET') {
        const search = new URLSearchParams(req.url?.slice(libraryPath.length + 1));
        const query = libraryPage.safeParse(Object.fromEntries(search));
        if (search.size !== new Set(search.keys()).size || !query.success) return json(res, 400, { error: 'Choose a valid page of photos.' });
        const page = await library.avatarLibraryView(query.data, authorize);
        authorize();
        return json(res, 200, page);
      }
      if (req.headers.origin !== this.origin) return forbidden();
      if (req.url !== libraryPath || (req.method !== 'POST' && req.method !== 'DELETE')) {
        return json(res, 404, { error: 'There is no such photo library operation.' });
      }
      const body = await jsonBody(req, req.method === 'POST' ? batchSize * maxAppearanceBody : 1024);
      authorize();
      if (req.method === 'DELETE') {
        const selected = photoId.safeParse(body);
        if (!selected.success) return json(res, 400, { error: 'Choose a photo from the library.' });
        const removed = await library.avatarLibraryDelete(selected.data.id, authorize);
        authorize();
        return json(res, 200, { removed });
      }
      const batch = photos.safeParse(body);
      if (!batch.success) return json(res, 400, { error: 'Choose a valid batch of photos.' });
      const report = await library.avatarLibraryImport(batch.data.items, authorize);
      authorize();
      return json(res, 200, report);
    } catch (error) {
      if (!isCurrent()) return forbidden();
      return json(res, 409, { error: error instanceof Error ? error.message : 'Could not use the Bot photo library.' });
    }
  }
}
