// Q7: BRAIN_TYPESCRIPT=kit (CI publish) never loads the source repo's typescript; without it the repo's compiler is
// preferred, so requiring it runs the repo's code. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const INDEX_TS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'index-ts.mjs');

test("BRAIN_TYPESCRIPT=kit loads the kit's typescript; without it the repo's own runs", () => {
  const repo = mkdtempSync(join(tmpdir(), 'brain-ts-kit-'));
  const marker = join(repo, 'loaded');
  const ts = join(repo, 'node_modules', 'typescript');
  mkdirSync(ts, { recursive: true });
  writeFileSync(join(repo, 'package.json'), '{}');
  writeFileSync(join(ts, 'package.json'), JSON.stringify({ name: 'typescript', version: '5.99.0', main: 'index.js' }));
  writeFileSync(join(ts, 'index.js'), `require('fs').writeFileSync(${JSON.stringify(marker)}, '1'); module.exports = { version: '5.99.0' };`);
  const load = (env) => {
    const r = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e',
      `const { loadTypeScript } = await import(${JSON.stringify(INDEX_TS)}); const t = loadTypeScript(process.argv[1]); console.log(t.from, t.ts.version);`, repo],
    { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim().split(' ');
  };
  const [from, version] = load({ BRAIN_TYPESCRIPT: 'kit' });
  assert.equal(from, 'kit');
  assert.notEqual(version, '5.99.0');
  assert.equal(existsSync(marker), false, "the repo's typescript was not loaded");
  assert.deepEqual(load({}), ['repo', '5.99.0']);
  assert.equal(existsSync(marker), true, 'without the flag the repo code runs: why CI sets it');
  rmSync(repo, { recursive: true, force: true });
});
