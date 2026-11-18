// Q7 / S2: src/pg/ci-publish.mjs end to end on one throwaway Neon branch (the fault matrix F2–F15 and P22 is
// test/pg/faults.mjs). The source repo is the Phase 1 T7 secret corpus and GitHub is the replay fixture (no network); the
// GitHub repo id and this run's created_at come from a fetch stub. Checks: a failure before the transaction is recorded
// as <stage>:<kind>; the first publish goes through with no canary on the server and prints its stage events; no git call
// sees the writer URL or the Actions token, and only sync's git calls see the read token (as GH_TOKEN: Phase 1 code
// passes its environment on); the source repo's own typescript is never loaded; verify leaves the cached mirror at the
// new run, so the next run finds it there, and a lost cache is pulled in full; the server reads back to its checksum;
// a source repo id other than the binding is refused before anything is written (V22). Skipped unless NEON_PROJECT_ID
// is set (harness.mjs).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { neonSkip, createBranch } from './harness.mjs';
import { pullMirror } from '../../src/pg/mirror.mjs';
import { OWNER, REPO, canaries, githubSecretCorpus, repoSecretCorpus, replayRoutes, writeReplay, setupRepo, leaksIn } from '../security/lib.mjs';

const it = neonSkip() ? test.skip : test;
const DRIVER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'pg', 'ci-publish.mjs');
const DOMAIN = ['run', 'sync_state', 'binding', 'node', 'node_rev', 'edge', 'unresolved', 'item', 'item_rev', 'chunk', 'ref', 'ref_link', 'link'];
// the GitHub repo id ci-publish reads for the binding (R1) and this run's created_at (A5: unknown here, so no skip);
// every other request still fails (there is no network use)
const STUB = 'data:text/javascript,' + encodeURIComponent(`const id = Number(process.env.BRAIN_TEST_REPO_ID), real = globalThis.fetch;
globalThis.fetch = async (u, o) => String(u).startsWith('https://api.github.com/repos/') ? new Response(JSON.stringify({ id, created_at: null }), { status: 200 }) : real(u, o);`);
let branch, owner, pending = null, run = 9000;

// Node 25 runs root-level before() hooks concurrently with each other: the branch is made on first use instead
const ready = () => (pending ??= (async () => {
  branch = await createBranch('ci-publish');
  await branch.migrate();
  owner = await branch.connect('owner');
})());
after(async () => { await owner?.end().catch(() => {}); await branch?.drop(); });

const rows = async (text, params) => (await owner.query(text, params)).rows;

test('usage errors exit 2 before anything starts: a flag without its value, a missing env (no server needed)', () => {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  for (const [argv, out] of [[['--source', '.', '--mirror', 'm', '--mode'], /ci-publish: usage: ERR_PARSE_ARGS_INVALID_OPTION_VALUE/],
    [['--source', '.', '--mirror', 'm', '--bogus'], /ci-publish: usage: ERR_PARSE_ARGS_UNKNOWN_OPTION/],
    [['--source', '.', '--mirror', 'm'], /ci-publish: usage: missing or bad BRAIN_WRITER_URL/],
    [['--source', '.', '--mirror', 'm', '--mode', 'bootstrap'], /BRAIN_PUBLISH_WORKFLOW \(bootstrap mode\)/]]) {
    const r = spawnSync(process.execPath, [DRIVER, ...argv], { env, encoding: 'utf8' });
    assert.equal(r.status, 2, `${argv.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, out);
    assert.doesNotMatch(r.stderr, /at .*\.mjs:\d+/, 'no stack trace');
  }
});

// the budget covers the harness's slot wait (up to 15 min while two other suites hold the slots) and then the runs
it('ci-publish: recorded early failures, a first publish with no credential in any child, two runs on a base, V22', { timeout: 1_500_000 }, async () => {
  await ready();
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
echo "$who writer=\${BRAIN_WRITER_URL+1} source=\${BRAIN_SOURCE_TOKEN+1} gh=\${GH_TOKEN+1} actions=\${GITHUB_TOKEN+1}" >> '${spy}/git'
exec '${realGit}' "$@"
`);
  chmodSync(join(spy, 'bin', 'git'), 0o755);

  const cache = join(mkdtempSync(join(tmpdir(), 'brain-q7-cache-')), 'mirror');   // the Actions cache: kept between runs
  const drive = (extra = {}, { work: workDir, args = [] } = {}) => {
    run += 1;
    const env = { PATH: `${spy}/bin:${process.env.PATH}`, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? '/tmp', NO_COLOR: '1',
      BRAIN_WRITER_URL: branch.writerUrl, BRAIN_SOURCE_REPO: `${OWNER}/${REPO}`, BRAIN_SOURCE_TOKEN: ['test', 'source', 'token'].join('-'),
      GITHUB_TOKEN: ['test', 'actions', 'token'].join('-'), GHA_RUN_ID: String(run), GHA_RUN_ATTEMPT: '1', GITHUB_REPOSITORY: 'o/brain-ops',
      GITHUB_WORKFLOW_REF: 'o/brain-ops/.github/workflows/brain-publish.yml@refs/heads/main', BRAIN_REPLAY_DIR: replay, BRAIN_TEST_REPO_ID: '4242', ...extra };
    const work = mkdtempSync(join(tmpdir(), 'brain-q7-'));
    const r = spawnSync(process.execPath, ['--no-warnings', `--import=${STUB}`, DRIVER, '--source', fx.repo, '--mirror', cache, '--work', workDir ?? join(work, 'w'), ...args],
      { env, encoding: 'utf8', timeout: 240_000 });
    const out = `${r.stdout}${r.stderr}`;
    assert.ok(!out.includes(branch.writerUrl) && !out.includes(new URL(branch.writerUrl).password), 'the writer URL is never printed');
    return { status: r.status, out };
  };

  // 1. sync fails (a failpoint in the child): the attempt ends failed with the stage, nothing else is written. This
  // first run is brain-bootstrap.yml's (design §6.1): it binds the publish workflow (checked below), not itself.
  const early = drive({ BRAIN_FAIL_AT: 'sync:after-repo', GITHUB_WORKFLOW_REF: 'o/brain-ops/.github/workflows/brain-bootstrap.yml@refs/heads/main',
    BRAIN_PUBLISH_WORKFLOW: '.github/workflows/brain-publish.yml' }, { args: ['--full', '--mode', 'bootstrap'] });
  assert.equal(early.status, 1, early.out);
  assert.match(early.out, /FAILED sync:exit/);
  assert.deepEqual(await rows('SELECT status, stage, error FROM brain.attempt'), [{ status: 'failed', stage: 'sync', error: 'sync:exit' }]);
  assert.equal((await rows('SELECT count(*)::int AS n FROM brain.run'))[0].n, 0);

  // 1b. a plain error after the attempt started (the scratch dir cannot be made): recorded under its stage
  const file = join(mkdtempSync(join(tmpdir(), 'brain-q7-')), 'not-a-dir');
  writeFileSync(file, '');
  const blocked = drive({}, { work: join(file, 'w') });
  assert.equal(blocked.status, 1, blocked.out);
  assert.deepEqual((await rows('SELECT status, stage, error FROM brain.attempt ORDER BY attempt_id'))[1], { status: 'failed', stage: 'build', error: 'build:internal' });

  // 2. the first publish
  const first = drive();
  assert.equal(first.status, 0, first.out);
  assert.match(first.out, /published run 1\b/);
  assert.match(first.out, /verified: the latest run is 1; the mirror is at run 1/);
  // stage events for the SLO meter, in order; no mirror stage on a first publish
  assert.deepEqual([...first.out.matchAll(/^brain-stage (\S+) (start|ok) /gm)].map((m) => `${m[1]} ${m[2]}`),
    ['prepare', 'record', 'build', 'sync', 'outbound', 'publish', 'verify'].flatMap((st) => [`${st} start`, `${st} ok`]));
  const [r1] = await rows('SELECT run_id::int AS run, commit_sha, mode, a.status FROM brain.run JOIN brain.attempt a USING (attempt_id)');
  assert.deepEqual(r1, { run: 1, commit_sha: fx.head, mode: 'normal', status: 'ok' });
  assert.deepEqual(await rows('SELECT source_repo_id::int AS id, source_repo, ops_repo, workflow FROM brain.binding'),
    [{ id: 4242, source_repo: `${OWNER}/${REPO}`, ops_repo: 'o/brain-ops', workflow: '.github/workflows/brain-publish.yml' }]);
  assert.ok((await rows("SELECT count(*)::int AS n FROM brain.item WHERE origin = 'github'"))[0].n > 0, 'GitHub items came through sync');
  const text = [];
  for (const t of DOMAIN) text.push(JSON.stringify(await rows(`SELECT * FROM brain.${t}`)));
  assert.deepEqual(leaksIn(reg, text.join('\n'), { folded: true }), []);

  const calls = [...new Set(readFileSync(join(spy, 'git'), 'utf8').trim().split('\n'))].sort();
  // Phase 1 strips GH_* / GITHUB_* / BRAIN_* from every git env it builds (plan A29), so sync's git sees no token either
  assert.deepEqual(calls, ['build writer= source= gh= actions=', 'other writer= source= gh= actions=', 'sync writer= source= gh= actions='],
    'no git call sees the writer URL, the Actions token or the read token');
  assert.equal(existsSync(join(spy, 'ts-loaded')), false, "build never loaded the source repo's typescript");

  // 3. two runs with a base: new commits on main. verify left the cache at run 1, so run 2 finds it there; the cache is
  //    then lost, so run 3 pulls run 2 in full. Each checks the mirror against the base run's checksum (R3), and each
  //    verify moves the cache to its new run by a delta.
  const commit = (rel, text, msg) => {
    mkdirSync(dirname(join(fx.repo, rel)), { recursive: true });
    writeFileSync(join(fx.repo, rel), text);
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'], { cwd: fx.repo });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', msg], { cwd: fx.repo });
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repo, encoding: 'utf8' }).trim();
  };
  // a cached mirror gets CI_LIMITS mirror (60 s); none (the cache evicted: a full pull) gets mirrorCold (300 s)
  for (const [n, rel, text, pull, limit] of [[2, 'docs/step-two.md', '# Step two\n\nRefunds wait for the ledger.\n', 'mirror already at run 1',
    'mirror: a cached mirror: limit 60s'],
  [3, 'src/lib/step-three.ts', 'export function stepThree(n: number) { return n + 3; }\n', 'mirror run 2 \\(full\\)',
    'mirror: no cached mirror \\(a full pull\\): limit 300s']]) {
    const sha = commit(rel, text, `step ${n}: add ${rel}`);
    if (n === 3) rmSync(cache, { recursive: true, force: true });  // the Actions cache was evicted
    const next = drive();
    assert.equal(next.status, 0, next.out);
    assert.match(next.out, new RegExp(pull));
    assert.match(next.out, new RegExp(limit));
    assert.match(next.out, new RegExp(`mirror: run ${n - 1}, checksum matches`));
    assert.match(next.out, new RegExp(`published run ${n}\\b`));
    assert.match(next.out, new RegExp(`mirror run ${n - 1} -> ${n} \\(delta\\)`), 'verify moved the cache to the new run');
    assert.deepEqual(await rows(`SELECT r.commit_sha, a.base_run::int AS base, a.status FROM brain.run r JOIN brain.attempt a USING (attempt_id)
      WHERE r.run_id = $1`, [n]), [{ commit_sha: sha, base: n - 1, status: 'ok' }]);
  }
  assert.equal((await rows("SELECT count(*)::int AS n FROM brain.item i JOIN brain.item_rev r USING (item_id) WHERE i.ptr LIKE 'doc:docs/step-two.md%' AND r.valid_to IS NULL"))[0].n, 1);
  assert.ok((await rows("SELECT count(*)::int AS n FROM brain.node WHERE key LIKE 'src/lib/step-three.ts%'"))[0].n >= 2, 'the new file and its function');
  // the server state at run 3 reads back to run 3's checksum (pullMirror checks it on a fresh pull)
  const check = await pullMirror({ url: branch.readerUrl, dir: join(mkdtempSync(join(tmpdir(), 'brain-q7-check-')), 'm'), run: 3, shapes: ['code', 'github'] });
  assert.equal(check.run, 3);

  // 4. V22: the database is bound to repo id 4242; a publisher pointed at another repo writes nothing
  const attempts = (await rows('SELECT count(*)::int AS n FROM brain.attempt'))[0].n;
  const other = drive({ BRAIN_TEST_REPO_ID: '999' });
  assert.equal(other.status, 1, other.out);
  assert.match(other.out, /FAILED record:binding/);
  assert.equal((await rows('SELECT count(*)::int AS n FROM brain.attempt'))[0].n, attempts);
  assert.equal((await rows('SELECT count(*)::int AS n FROM brain.run'))[0].n, 3);
});
