// check.sh skips code typechecks and unrelated runner unit tests when a change
// touches only agent skills (.agents/skills/, .claude/skills/) or
// documentation (docs/, top-level *.md), while still running doc-specific
// checks (site build, feature pairing, and the targeted doc unit tests).
//
// This runs the real check.sh --local in a throwaway checkout whose steps are
// stand-ins, so only what check.sh picks to run is under test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function checkout() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tb-check-docs-'));
  const ranLog = path.join(root, 'ran.log');
  const put = (rel: string, text: string, mode?: number) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
    if (mode) fs.chmodSync(path.join(root, rel), mode);
  };
  const copy = (rel: string, mode?: number) => put(rel, fs.readFileSync(path.join(repo, rel), 'utf8'), mode);
  const logCmd = (tag: string) => `printf '%s\\n' '${tag}' >> '${ranLog}'`;
  const testFile = (label: string, fail = false) =>
    `import { test } from 'node:test';\n` +
    `import fs from 'node:fs';\n` +
    `test(${JSON.stringify(label)}, () => {\n` +
    `  fs.appendFileSync(${JSON.stringify(ranLog)}, ${JSON.stringify(`unit:${label}\n`)});\n` +
    (fail ? `  throw new Error(${JSON.stringify(`${label} failed`)});\n` : '') +
    `});\n`;

  copy('check.sh', 0o755);
  copy('scripts/swift-freeze.sh', 0o755);
  copy('runner/scripts/find-node.sh');
  copy('scripts/limit-step.mjs');
  copy('runner/test/helpers/failed-files-reporter.mjs');

  put('runner/package.json', JSON.stringify({
    scripts: { typecheck: logCmd('runner-typecheck') },
  }));
  put('runner/node_modules/.keep', '');
  put('runner/test/helpers/clean-env.ts', '');
  put('runner/test/unit/ok.test.ts', testFile('ok'));
  for (const name of ['agents-md', 'experiment-docs', 'forking-doc', 'parity', 'machine-docs', 'protocol-split', 'runner-access']) {
    put(`runner/test/unit/${name}.test.ts`, testFile(name));
  }

  put('package.json', JSON.stringify({
    scripts: {
      'convex:typecheck': logCmd('convex-typecheck'),
      'web:typecheck': logCmd('web-typecheck'),
      'web:test': logCmd('web-tests'),
      lint: 'true',
      'lint:files': 'true',
    },
  }));
  put('node_modules/.keep', '');
  put('app/Tools/ok.mjs', '');
  put('mock-runner/ok.mjs', '');
  put('mock-runner/node_modules/.keep', '');
  put('site/scripts/build.mjs', `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(ranLog)}, 'site-build\\n');\n`);
  put('features/verify-pairing.mjs', `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(ranLog)}, 'feature-pairing\\n');\n`);
  put('features/package.json', JSON.stringify({ scripts: { typecheck: 'true' } }));
  put('features/node_modules/.keep', '');
  put('scripts/build-bot-profile-panel.mjs', '');
  put('scripts/i18n-check.ts', '');
  put('scripts/i18n.test.ts', "import { test } from 'node:test';\ntest('ok', () => {});\n");
  put('desktop/.keep', '');
  put('ios/ThreadbearKit/.keep', '');
  put('bin/swift', '#!/bin/bash\n', 0o755);
  put('bin/cargo', '#!/bin/bash\n', 0o755);

  return {
    root,
    ranLog,
    put,
    testFile,
    ran: () => (fs.existsSync(ranLog) ? fs.readFileSync(ranLog, 'utf8').trim().split('\n').filter(Boolean) : []),
    remove: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function run(c: ReturnType<typeof checkout>, changed: string[], flags: string[] = ['--quick'], extra: NodeJS.ProcessEnv = {}) {
  fs.rmSync(c.ranLog, { force: true });
  const list = path.join(c.root, '.changed');
  fs.writeFileSync(list, changed.join('\n') + (changed.length ? '\n' : ''));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${path.join(c.root, 'bin')}:${process.env.PATH}`,
    THREADBEAR_CHECK_CHANGED_FILE: list,
    THREADBEAR_NODE: process.execPath,
    TMPDIR: c.root,
    HOME: c.root,
  };
  for (const k of Object.keys(env)) {
    if (/^THREAD(BEAR|BARE)_(CHECK_|HOME$)/.test(k) && k !== 'THREADBEAR_CHECK_CHANGED_FILE') delete env[k];
  }
  delete env.NODE_TEST_CONTEXT;
  Object.assign(env, extra);
  const r = spawnSync('bash', [path.join(c.root, 'check.sh'), ...flags, '--local'], {
    env,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), ran: c.ran() };
}

const stepLine = (out: string, name: string): string | undefined =>
  out.split('\n').find((l) => new RegExp(`^(ok|FAIL|skip)\\s+${name}\\b`).test(l));

test('skill-only and plain root doc changes skip heavy code checks and runner unit tests', () => {
  const c = checkout();
  try {
    for (const changed of [
      ['.agents/skills/threadbear-feature-port/SKILL.md', '.agents/skills/threadbear-feature-port/references/roadmap-template.md'],
      ['.claude/skills/my-skill/SKILL.md'],
      ['README.md', 'CLAUDE.md'],
    ]) {
      const r = run(c, changed);
      assert.equal(r.status, 0, `${changed.join(',')}: ${r.out}`);
      assert.deepEqual(r.ran, [], `${changed.join(',')}: expected no heavy step to execute`);
      for (const name of ['runner typecheck', 'app tools parse', 'convex typecheck', 'web typecheck', 'web tests', 'runner unit tests']) {
        assert.match(stepLine(r.out, name) ?? '', /^skip .*only skills or docs changed/, `${name}: ${r.out}`);
      }
    }
  } finally {
    c.remove();
  }
});

test('doc-only changes still run their matching fast doc checks and targeted doc unit tests', () => {
  const c = checkout();
  try {
    const guide = run(c, ['docs/guide.md']);
    assert.equal(guide.status, 0, guide.out);
    assert.deepEqual(guide.ran.sort(), ['site-build', 'unit:agents-md']);

    const featuresDoc = run(c, ['docs/gpui-port/features.md']);
    assert.equal(featuresDoc.status, 0, featuresDoc.out);
    assert.deepEqual(featuresDoc.ran.sort(), ['feature-pairing', 'unit:agents-md']);

    const experimentsDoc = run(c, ['docs/experiments.md']);
    assert.equal(experimentsDoc.status, 0, experimentsDoc.out);
    assert.deepEqual(experimentsDoc.ran.sort(), ['site-build', 'unit:agents-md', 'unit:experiment-docs']);

    const protocolDoc = run(c, ['docs/protocol/threads.md']);
    assert.equal(protocolDoc.status, 0, protocolDoc.out);
    assert.deepEqual(protocolDoc.ran.sort(), ['unit:agents-md', 'unit:protocol-split', 'unit:runner-access']);

    const otherDocs = run(c, ['docs/forking.md', 'docs/parity.md', 'docs/machines.md']);
    assert.equal(otherDocs.status, 0, otherDocs.out);
    assert.deepEqual(otherDocs.ran.sort(), ['unit:agents-md', 'unit:forking-doc', 'unit:machine-docs', 'unit:parity']);

    // A failing AGENTS.md check still fails the run.
    c.put('runner/test/unit/agents-md.test.ts', c.testFile('agents-md', true));
    const brokenAgents = run(c, ['AGENTS.md']);
    assert.equal(brokenAgents.status, 1, brokenAgents.out);
    // check.sh retries a single failing unit test file once before failing.
    assert.deepEqual([...new Set(brokenAgents.ran)], ['unit:agents-md']);
    assert.match(stepLine(brokenAgents.out, 'runner unit tests') ?? '', /^FAIL/, brokenAgents.out);
  } finally {
    c.remove();
  }
});

test('mixed changes, runtime markdown, non-skill .claude files, check.sh, and empty diff still run full checks', () => {
  const c = checkout();
  try {
    for (const changed of [
      ['.agents/skills/foo/SKILL.md', 'runner/src/x.ts'],
      ['runner/src/experiments/archive.md'],
      ['runner/src/recipes/daily-brief/RECIPE.md'],
      ['.claude/settings.json'],
      ['check.sh'],
      [],
    ]) {
      const r = run(c, changed);
      assert.equal(r.status, 0, `${changed.join(',') || '<empty>'}: ${r.out}`);
      assert.ok(r.ran.includes('runner-typecheck'), `${changed.join(',')}: expected runner typecheck`);
      assert.ok(r.ran.includes('web-tests'), `${changed.join(',')}: expected web tests`);
      assert.ok(r.ran.includes('unit:ok'), `${changed.join(',')}: expected full runner unit tests`);
    }
  } finally {
    c.remove();
  }
});

test('--all, --fresh, --runner, and --only override the docs/skills fast path', () => {
  const c = checkout();
  try {
    const skillOnly = ['.agents/skills/foo/SKILL.md'];

    const all = run(c, skillOnly, ['--quick', '--all']);
    assert.equal(all.status, 0, all.out);
    assert.ok(all.ran.includes('runner-typecheck') && all.ran.includes('unit:ok'), all.out);

    const fresh = run(c, skillOnly, ['--quick', '--fresh']);
    assert.equal(fresh.status, 0, fresh.out);
    assert.ok(fresh.ran.includes('runner-typecheck') && fresh.ran.includes('unit:ok'), fresh.out);

    const freshEnv = run(c, skillOnly, ['--quick'], { THREADBEAR_CHECK_FRESH: '1' });
    assert.equal(freshEnv.status, 0, freshEnv.out);
    assert.ok(freshEnv.ran.includes('runner-typecheck') && freshEnv.ran.includes('unit:ok'), freshEnv.out);

    const runnerOnly = run(c, skillOnly, ['--runner']);
    assert.equal(runnerOnly.status, 0, runnerOnly.out);
    assert.ok(runnerOnly.ran.includes('runner-typecheck') && runnerOnly.ran.includes('unit:ok'), runnerOnly.out);

    const only = run(c, skillOnly, ['--quick', '--only', 'runner typecheck']);
    assert.equal(only.status, 0, only.out);
    assert.deepEqual(only.ran, ['runner-typecheck']);
  } finally {
    c.remove();
  }
});
