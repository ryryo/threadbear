import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { BotRepository } from '../../../src/bots/repository.ts';

const at = '2026-11-27T00:00:00Z';
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'threadbear-bot-teams-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const open = () => new BotRepository(dir, 'native-runner');
  return { open, repo: open() };
}

test('another Bot takes the Chief place in one saved step and does not inherit management grants', t => {
  const { open, repo } = fixture(t);
  const chief = repo.create({ name: 'Chief' });
  const writer = repo.create({ name: 'Writer' });
  const team = repo.createTeam('Editorial', [chief.id, writer.id], at);
  assert.deepEqual(team.chiefIds, []);
  const assigned = repo.setChief(team.id, team.revision, chief.id, { main: true }, at);
  const granted = repo.setTeamGrants(team.id, assigned.revision, chief.id, { updateOtherBot: { botIds: [writer.id], fields: ['role'] } }, at);
  const next = repo.setChief(team.id, granted.revision, writer.id, { main: true, replace: chief.id }, at);
  assert.deepEqual(next.chiefIds, [writer.id]);
  assert.equal(next.chiefIds[0], writer.id);
  assert.deepEqual(next.grantByChief, {});
  assert.deepEqual(open().team(team.id), next);
});

test('a team keeps one active Chief and the role cannot be given to a private or outside Bot', t => {
  const { repo } = fixture(t);
  const chief = repo.create({ name: 'Chief' });
  const writer = repo.create({ name: 'Writer' });
  const reader = repo.create({ name: 'Reader' });
  repo.setPrivate(writer.id, writer.revision, '/private', 'private-writer', [], () => {});
  const team = repo.createTeam('Editorial', [chief.id, writer.id], at);
  const assigned = repo.setChief(team.id, team.revision, chief.id, { main: true }, at);
  assert.throws(() => repo.setChief(team.id, assigned.revision, chief.id, { main: false }, at), /at least one Chief/);
  assert.throws(() => repo.setChief(team.id, assigned.revision, writer.id, { main: true }, at), /private/);
  assert.throws(() => repo.setChief(team.id, assigned.revision, reader.id, { main: true }, at), /team/);
  assert.throws(() => repo.setTeamGrants(team.id, team.revision, chief.id, {}, at), /changed/);
  assert.throws(() => repo.archive(chief.id, chief.revision, at), /Chief/);
  assert.throws(() => repo.setPrivate(chief.id, chief.revision, '/private', 'private-chief', [], () => {}), /Chief/);
  assert.deepEqual(repo.team(team.id).chiefIds, [chief.id]);
});

test('membership controls cannot add one Bot to two teams or remove a current Chief', t => {
  const { repo } = fixture(t);
  const chief = repo.create({ name: 'Chief' });
  const writer = repo.create({ name: 'Writer' });
  const team = repo.createTeam('Editorial', [chief.id], at);
  const separate = repo.createTeam('Research', [writer.id], at);
  const assigned = repo.setChief(team.id, team.revision, chief.id, { main: true }, at);
  assert.throws(() => repo.updateTeam(team.id, assigned.revision, { memberIds: [] }, at), /current Chief/);
  assert.throws(() => repo.updateTeam(team.id, assigned.revision, { memberIds: [chief.id, writer.id] }, at), /already belongs/);
  assert.equal(repo.teamIdForBot(writer.id), separate.id);
  assert.equal(repo.teamIdForBot(chief.id), team.id);
});
