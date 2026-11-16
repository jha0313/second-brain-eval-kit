// S6: scripts/sandbox-setup.mjs only prints. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, render } from '../../scripts/sandbox-setup.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'sandbox-setup.mjs');
const run = (args, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });

test('the script cannot run anything: no process, network or file-write module', () => {
  const text = readFileSync(SCRIPT, 'utf8');
  assert.deepEqual([...text.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]), ['node:url']);
  assert.doesNotMatch(text, /\bfetch\(|\bimport\(|\brequire\(['"]child/);
});

test('dry run: the env values never reach the output, secrets go on stdin, the gate is not opened before the bootstrap step', () => {
  const fake = ['fake', 'project', 'id'].join('-'), key = ['fake', 'api', 'key'].join('-');
  const r = run(['--owner', 'someone'], { NEON_PROJECT_ID: fake, NEON_API_KEY: key });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^# DRY RUN: nothing was run/);
  assert.ok(!r.stdout.includes(fake) && !r.stdout.includes(key));
  assert.match(r.stdout, /--project-id "\$NEON_PROJECT_ID"/);
  const lines = r.stdout.split('\n');
  for (const l of lines.filter((x) => /gh secret set/.test(x))) assert.doesNotMatch(l, /--body|-b /, l);
  const gate = lines.findIndex((l) => /gh variable set BRAIN_BOOTSTRAP_UNTIL/.test(l));
  assert.ok(gate > lines.findIndex((l) => /gh secret set BRAIN_WRITER_URL/.test(l)));
  assert.ok(lines.findIndex((l) => /gh variable delete BRAIN_BOOTSTRAP_UNTIL/.test(l)) > gate);
  assert.match(r.stdout, /BRAIN_SOURCE_REPO:\\s\*\)\\S\+#\$\{1\}someone\/brain-sandbox-source#/);
});

test('every value a printed node command reads from process.env is handed to it (on its command or exported before)', () => {
  const cmds = [], exported = new Set();
  let cur = '';
  // one command = lines joined by a trailing backslash or by a newline inside single quotes (a node -e program)
  for (const l of render(parseArgs(['--owner', 'o']).opts).split('\n')) {
    cur += `${l}\n`;
    if (!/\\$/.test(l) && cur.split("'").length % 2 === 1) { cmds.push(cur); cur = ''; }
  }
  assert.equal(cur, '', 'every quote is closed');
  let checked = 0;
  for (const c of cmds) {
    for (const m of c.matchAll(/^export ([A-Z_]+)=/gm)) exported.add(m[1]);
    for (const [, name] of c.matchAll(/process\.env\.([A-Z_]+)/g)) {
      checked += 1;
      assert.ok(exported.has(name) || new RegExp(`(^|\\s)${name}=`).test(c), `${name} is not handed to:\n${c}`);
    }
  }
  assert.ok(checked >= 6, `${checked} env reads checked`);
});

test('arguments: no apply mode, names that could break a shell line are refused', () => {
  assert.equal(run(['--apply']).status, 2);
  assert.match(run(['--apply']).stderr, /no apply mode/);
  for (const bad of [['--owner', 'a;b'], ['--ops', '$(x)'], ['--kit-commit', 'abc'], ['--code', 'git@x:y'], ['--nope', 'x'], ['--owner']]) {
    assert.ok(parseArgs(bad).error, bad.join(' '));
  }
  const sha = 'a'.repeat(40);
  assert.match(render(parseArgs(['--owner', 'o', '--kit-commit', sha]).opts), new RegExp(`git -C "\\$KIT" archive ${sha} `));
});
