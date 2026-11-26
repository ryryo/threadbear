// Adapt DS-Bot's create_bot and update_bot authorization from src/host/tools.js
// at d104d9ca18d69a35460f14e15dff4d553181433a, using authenticated Thread links
// and owner-defined grants. Apache-2.0, see ported/NOTICE.
import { realpathSync, statSync } from 'node:fs';
import { lowerMode, raises } from '../access.ts';
import { ErrorCode, RpcError } from '../protocol.ts';
import type { Runner } from '../runner.ts';
import { chiefGrant } from './chief-policy.ts';
import type { Bot, BotRepository } from './repository.ts';
import type { Team, TeamGrant } from './team-state.ts';

type Profile = Partial<Pick<Bot, 'name' | 'role' | 'instructions'>>;
type Template = NonNullable<TeamGrant['createBot']>['templates'][number];

export class BotTeams {
  private readonly ports: {
    repo: BotRepository;
    runner: Runner;
    protect: () => void;
    redact?: (text: string) => string;
    tasks: (threadId: string) => Promise<void>;
  };

  constructor(ports: BotTeams['ports']) { this.ports = ports; }

  private actor(threadId: string) {
    const { runner, repo } = this.ports;
    const st = runner.threads.get(threadId);
    const link = st?.rec.botLink;
    if (!st || st.rt.deleted || st.rec.copied || !st.rt.turn || !link || link.taskId ||
        !repo.matchesConversation(link.botId, link.conversationId, threadId)) {
      throw new RpcError(ErrorCode.notAllowed, 'An active Bot conversation is required.');
    }
    const bot = repo.get(link.botId);
    if (bot.archivedAt || bot.privacy) throw new RpcError(ErrorCode.notAllowed, 'This Bot cannot use team management tools.');
    return { bot, team: repo.team(repo.teamIdForBot(bot.id)), ceiling: lowerMode(st.rec.permissionMode, runner.accessOf(threadId)) };
  }

  private nonPrivateMember(team: Team, id: string): Bot {
    const bot = this.ports.repo.get(id);
    if (!team.memberIds.includes(id) || bot.archivedAt || bot.privacy) {
      throw new RpcError(ErrorCode.notAllowed, 'Choose an active, non-Private Bot on this team.');
    }
    return bot;
  }

  private binding(template: Template) {
    const { runner } = this.ports;
    const folder = realpathSync.native(template.folder);
    if (folder !== template.folder || !statSync(folder).isDirectory()) throw new Error('The permitted template folder changed.');
    runner.checkBotFolder(folder);
    const account = runner.accounts.get(template.accountId);
    if (!account) throw new Error('The permitted template login is no longer available.');
    const { model } = runner.checkSettings(account, template.model, undefined);
    if (model !== template.model) throw new Error('The permitted template model is no longer available.');
    return { modelBinding: { accountId: account.id, provider: account.provider, model }, workFolder: folder, permissionCeiling: template.permissionCeiling };
  }

  ownerSetGrants(teamId: string, revision: number, chiefId: string, grants: TeamGrant): Team {
    const { repo, runner, protect } = this.ports;
    const templates = grants.createBot?.templates ?? [];
    if (new Set(templates.map(entry => entry.id)).size !== templates.length) throw new Error('Template names must be unique within one grant.');
    for (const template of templates) this.binding(template);
    protect();
    return repo.setTeamGrants(teamId, revision, chiefId, grants, runner.isoNow());
  }

  read(threadId: string) {
    const { repo } = this.ports;
    const { bot, team } = this.actor(threadId);
    const members = team.memberIds.map(id => repo.get(id)).filter(entry => !entry.archivedAt)
      .map(({ id, name, role, revision }) => ({ id, name, role, revision }));
    return { teamId: team.id, title: team.title, revision: team.revision, members,
      grant: team.chiefEnabled && team.chiefIds.includes(bot.id) ? team.grantByChief[bot.id] : undefined };
  }

  createBot(threadId: string, revision: number, templateId: string, name: string) {
    const { repo, runner, protect } = this.ports;
    const { bot, team, ceiling } = this.actor(threadId);
    const grant = chiefGrant(team, bot, 'createBot', revision);
    const template = grant.templates.find(entry => entry.id === templateId);
    if (!template || raises(template.permissionCeiling, ceiling)) {
      throw new RpcError(ErrorCode.notAllowed, 'Use one permitted Bot template within your current permission.');
    }
    if (team.audit.filter(event => event.kind === 'bot-created' && event.actorId === bot.id).length >= grant.maxCreated) {
      throw new RpcError(ErrorCode.notAllowed, 'This Chief has reached its permitted number of created Bots.');
    }
    const binding = this.binding(template);
    protect();
    return repo.createManagedBot(team.id, revision, bot.id, runner.isoNow(), {
      name, role: template.role, instructions: template.instructions, ...binding,
    });
  }

  editBot(threadId: string, revision: number, botId: string, botRevision: number, update: Profile) {
    const { repo, runner, protect } = this.ports;
    const { bot, team } = this.actor(threadId);
    const grant = chiefGrant(team, bot, 'updateOtherBot', revision);
    if (!grant.botIds.includes(botId) || Object.keys(update).some(field => !grant.fields.some(allowed => allowed === field))) {
      throw new RpcError(ErrorCode.notAllowed, 'This Chief cannot update those settings on that Bot.');
    }
    this.nonPrivateMember(team, botId);
    protect();
    return repo.updateManagedBot(team.id, revision, bot.id, botId, botRevision, update, runner.isoNow());
  }

  async stopBot(threadId: string, revision: number, botId: string, reason: string) {
    const { bot, team } = this.actor(threadId);
    const { repo, runner, protect, tasks } = this.ports;
    const grant = chiefGrant(team, bot, 'stopOtherBot', revision);
    if (botId === bot.id || !grant.botIds.includes(botId)) {
      throw new RpcError(ErrorCode.notAllowed, 'This Chief cannot stop that Bot.');
    }
    this.nonPrivateMember(team, botId);
    const affected = [...runner.threads.values()].filter(st => st.rec.botLink?.botId === botId && !st.rec.copied && !st.rt.deleted);
    protect();
    const safeReason = this.ports.redact?.(reason) ?? 'Team management request';
    const next = repo.noteManagedStop(team.id, revision, bot.id, botId, safeReason, runner.isoNow());
    for (const st of affected) {
      const current = this.actor(threadId);
      if (current.team.id !== next.id || current.team.revision !== next.revision) {
        throw new Error('The Bot team changed before every requested Thread could be stopped.');
      }
      const taskId = st.rec.botLink?.taskId;
      if (taskId) await tasks(taskId);
      else runner.interrupt(st.rec.id);
      runner.emit(st, { type: 'system.note', text: `Stopped by ${bot.name}: ${safeReason}` });
    }
    return { team: next, stoppedThreads: affected.map(st => st.rec.id) };
  }
}
