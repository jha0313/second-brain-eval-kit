// Q7: ci/brain-publish.mjs end to end on one throwaway Neon branch. The source repo is the Phase 1 T7 secret corpus and
// GitHub is the replay fixture (no network); the GitHub repo id comes from a fetch stub. Checks: a failure before the
// transaction is recorded with its stage; the first publish goes through with no canary on the server; no git call
// sees the writer URL, and only sync's git calls see the read token (as GH_TOKEN: Phase 1 code passes its environment
// on); the source repo's own typescript is never loaded; a source repo id other
// than the binding is refused before anything is written (V22). Skipped unless NEON_PROJECT_ID is set (neon-branch.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { neonEnv, createBranch } from './neon-branch.mjs';
import { OWNER, REPO, canaries, githubSecretCorpus, repoSecretCorpus, replayRoutes, writeReplay, setupRepo, leaksIn } from '../security/lib.mjs';

const it = neonEnv() ? test : test.skip;
const DRIVER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'ci', 'brain-publish.mjs');
const DOMAIN = ['run', 'sync_state', 'binding', 'node', 'node_rev', 'edge', 'unresolved', 'item', 'item_rev', 'chunk', 'ref', 'ref_link', 'link'];
// the GitHub repo id the driver reads for the binding (R1); every other request still fails (there is no network use)
const STUB = 'data:text/javascript,' + encodeURIComponent(`const id = Number(process.env.BRAIN_TEST_REPO_ID), real = globalThis.fetch;
globalThis.fetch = async (u, o) => String(u).startsWith('https://api.github.com/repos/') ? new Response(JSON.stringify({ id }), { status: 200 }) : real(u, o);`);
let branch, owner, run = 9000;

before(async () => {
  if (!neonEnv()) return;
  branch = await createBranch('p2b-q7');
  await branch.reset();
  owner = new pg.Client({ connectionString: branch.ownerUrl });
  owner.on('error', () => {});
  await owner.connect();
}, { timeout: 300_000 });
after(async () => { await owner?.end().catch(() => {}); branch?.drop(); });

const rows = async (text, params) => (await owner.query(text, params)).rows;

it('the publish driver: a recorded early failure, then a first publish with no credential in any child, then V22', { timeout: 300_000 }, async () => {
  const reg = canaries();
  const fx = setupRepo(repoSecretCorpus(reg));
  assert.equal(fx.build.status, 0, 'corpus build');
  const replay = writeReplay(replayRoutes(githubSecretCorpus(reg)));
  const spy = mkdtempSync(join(tmpdir(), 'brain-q7-spy-'));
  // the source checkout ships its own typescript: loading it would run the source repo's code
  const tsDir = join(fx.repo, 'node_modules', 'typescript');
  mkdirSync(tsDir, { recursive: true });
  writeFileSync(join(tsDir, 'package.json'), JSON.stringify({ name: 'typescript', version: '5.99.0', main: 'index.js' }));
  writeFileSync(join(tsDir, 'index.js'), `require('fs').writeFileSync(${JSON.stringify(join(spy, 'ts-loaded'))}, '1'); module.exports = { version: '5.99.0' };`);
  // every git call notes who ran it (the driver, build or sync) and which credential variables it can see
  const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  mkdirSync(join(spy, 'bin'));
  writeFileSync(join(spy, 'bin', 'git'), `#!/bin/sh
case "$(ps -o command= -p "$PPID")" in *"cli.mjs build"*) who=build ;; *"cli.mjs sync"*) who=sync ;; *) who=other ;; esac
echo "$who writer=\${BRAIN_WRITER_URL+1} source=\${BRAIN_SOURCE_TOKEN+1} gh=\${GH_TOKEN+1}" >> '${spy}/git'
exec '${realGit}' "$@"
`);
  chmodSync(join(spy, 'bin', 'git'), 0o755);

  const drive = (extra = {}, { work: workDir } = {}) => {
    run += 1;
    const env = { PATH: `${spy}/bin:${process.env.PATH}`, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? '/tmp', NO_COLOR: '1',
      BRAIN_WRITER_URL: branch.writerUrl, BRAIN_SOURCE_REPO: `${OWNER}/${REPO}`, BRAIN_SOURCE_TOKEN: ['test', 'source', 'token'].join('-'),
      GITHUB_RUN_ID: String(run), GITHUB_RUN_ATTEMPT: '1', GITHUB_REPOSITORY: 'o/brain-ops',
      GITHUB_WORKFLOW_REF: 'o/brain-ops/.github/workflows/brain-publish.yml@refs/heads/main', BRAIN_REPLAY_DIR: replay, BRAIN_TEST_REPO_ID: '4242', ...extra };
    const work = mkdtempSync(join(tmpdir(), 'brain-q7-'));
    const r = spawnSync(process.execPath, ['--no-warnings', `--import=${STUB}`, DRIVER, '--source', fx.repo, '--mirror', join(work, 'mirror'), '--work', workDir ?? join(work, 'w')],
      { env, encoding: 'utf8', timeout: 240_000 });
    const out = `${r.stdout}${r.stderr}`;
    assert.ok(!out.includes(branch.writerUrl) && !out.includes(new URL(branch.writerUrl).password), 'the writer URL is never printed');
    return { status: r.status, out };
  };

  // 1. sync fails (a failpoint in the child): the attempt ends failed with the stage, nothing else is written
  const early = drive({ BRAIN_FAIL_AT: 'sync:after-repo' });
  assert.equal(early.status, 1, early.out);
  assert.match(early.out, /sync-failed \(stage sync\)/);
  assert.deepEqual(await rows('SELECT status, stage, error FROM brain.attempt'), [{ status: 'failed', stage: 'sync', error: 'sync-failed' }]);
  assert.equal((await rows('SELECT count(*)::int AS n FROM brain.run'))[0].n, 0);

  // 1b. a plain error after the attempt started (the scratch dir cannot be made): recorded under its stage
  const file = join(mkdtempSync(join(tmpdir(), 'brain-q7-')), 'not-a-dir');
  writeFileSync(file, '');
  const blocked = drive({}, { work: join(file, 'w') });
  assert.equal(blocked.status, 1, blocked.out);
  assert.deepEqual((await rows('SELECT status, stage, error FROM brain.attempt ORDER BY attempt_id'))[1], { status: 'failed', stage: 'build', error: 'enotdir' });

  // 2. the first publish
  const first = drive();
  assert.equal(first.status, 0, first.out);
  assert.match(first.out, /published run 1\b/);
  const [r1] = await rows('SELECT run_id::int AS run, commit_sha, mode, a.status FROM brain.run JOIN brain.attempt a USING (attempt_id)');
  assert.deepEqual(r1, { run: 1, commit_sha: fx.head, mode: 'normal', status: 'ok' });
  assert.deepEqual(await rows('SELECT source_repo_id::int AS id, source_repo, ops_repo, workflow FROM brain.binding'),
    [{ id: 4242, source_repo: `${OWNER}/${REPO}`, ops_repo: 'o/brain-ops', workflow: '.github/workflows/brain-publish.yml' }]);
  assert.ok((await rows("SELECT count(*)::int AS n FROM brain.item WHERE origin = 'github'"))[0].n > 0, 'GitHub items came through sync');
  const text = [];
  for (const t of DOMAIN) text.push(JSON.stringify(await rows(`SELECT * FROM brain.${t}`)));
  assert.deepEqual(leaksIn(reg, text.join('\n'), { folded: true }), []);

  const calls = [...new Set(readFileSync(join(spy, 'git'), 'utf8').trim().split('\n'))].sort();
  assert.deepEqual(calls, ['build writer= source= gh=', 'other writer= source= gh=', 'sync writer= source= gh=1'],
    'no git call sees the writer URL; build and the driver see no token; sync sees only the read token');
  assert.equal(existsSync(join(spy, 'ts-loaded')), false, "build never loaded the source repo's typescript");

  // 3. V22: the database is bound to repo id 4242; a publisher pointed at another repo writes nothing
  const attempts = (await rows('SELECT count(*)::int AS n FROM brain.attempt'))[0].n;
  const other = drive({ BRAIN_TEST_REPO_ID: '999' });
  assert.equal(other.status, 1, other.out);
  assert.match(other.out, /binding-mismatch/);
  assert.equal((await rows('SELECT count(*)::int AS n FROM brain.attempt'))[0].n, attempts);
  assert.equal((await rows('SELECT count(*)::int AS n FROM brain.run'))[0].n, 1);
});
