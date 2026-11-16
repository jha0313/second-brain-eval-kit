// S5: bin/brain refresh and ci-publish, the staleness footer of server answers, server-mode `brain status` (Phase 2 Q6
// review #4) and server-mode hints (#7: never a local build or sync). Black-box through bin/brain where it can be.
// Offline: help, local mode, an unreachable and a stalled reader, ci-publish usage and env pass-through, the footer
// and guard texts, and what git sees. Neon (BRAIN_P3_NEON=1 and NEON_PROJECT_ID): one throwaway branch (prefix
// BRAIN_TEST_BRANCH_PREFIX, default p3b) with the golden seed (r1, GitHub data of sanitizer v0) and r2 (current
// sanitizer, T = now) — status, the footer of search / find, --as-of, the guard hint, refresh exits, the state key.
// origin's main comes from a git wrapper (fakeGit), never from the network.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { footer, guard } from '../../src/answer.mjs';
import { GuardError } from '../../src/errors.mjs';
import { runGit } from '../../src/pg/status.mjs';
import { withWriteLock } from '../../src/gh-schema.mjs';
import { REFRESH_MESSAGES as MSG, REFRESH_TRIGGERS, BOOTSTRAP_HINT } from '../../src/pg/contract.mjs';
import { SANITIZE_VERSION } from '../../src/sanitize.mjs';
import { tempDir, stallingPgServer, FAKE_TOKEN } from './stub.mjs';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BRAIN = join(KIT, 'bin', 'brain');
const PW = 'cli' + 'pass' + '123456';   // a reader password long enough for the CLI (MIN_SECRET)

/** bin/brain in a bare environment: PATH, HOME, NO_COLOR + env. */
function brain(args, { env = {}, cwd, home }) {
  return new Promise((res) => {
    const t0 = Date.now();
    const c = spawn(BRAIN, args, { cwd, env: { PATH: process.env.PATH, HOME: home, NO_COLOR: '1', ...env } });
    let stdout = '', stderr = '';
    c.stdout.on('data', (d) => { stdout += d; });
    c.stderr.on('data', (d) => { stderr += d; });
    c.on('close', (status) => res({ stdout, stderr, status, ms: Date.now() - t0 }));
  });
}
function checkout(root, remote = 'https://github.com/o/r.git') {
  const dir = mkdtempSync(join(root, 'repo-'));
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  writeFileSync(join(dir, 'README.md'), '# r\n');
  git('add', '-A'); git('commit', '-q', '-m', 'init');
  if (remote) git('remote', 'add', 'origin', remote);
  return dir;
}

// git with a fixed `origin` main: a wrapper first on PATH answers `ls-remote` from P3_MAIN (unset: fails, as an
// unreachable origin does), hangs `remote get-url` when P3_HANG is set, and passes every other git command to the real
// git. The checkout's origin stays a github.com URL (the reader check needs the binding's repo), and no test depends
// on the network.
function fakeGit(root) {
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const dir = mkdtempSync(join(root, 'bin-'));
  writeFileSync(join(dir, 'git'), `#!/bin/sh\ncase " $* " in\n  *" ls-remote "*) [ -n "$P3_MAIN" ] || exit 2; printf '%s\\trefs/heads/main\\n' "$P3_MAIN"; exit 0 ;;\n  *" get-url "*) [ -z "$P3_HANG" ] || exec sleep 30 ;;\nesac\nexec "${real}" "$@"\n`, { mode: 0o755 });
  return dir;
}

// ---------- offline ----------

describe('offline', () => {
  const root = tempDir('brain-p3-cli-');
  const home = mkdtempSync(join(root, 'home-'));
  const repo = checkout(root);

  test('brain refresh --help: usage with the exit codes (S5 acceptance)', async () => {
    const r = await brain(['refresh', '--help'], { cwd: repo, home });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /brain refresh \[--wait\]/);
    assert.match(r.stdout, /exit 0 fresh .* 75 still running .*--wait/s);
    assert.match(r.stdout, /1 failed, cooldown or deadline .* 2 unavailable/s);
    assert.match(r.stdout, /brain ci-publish --source DIR --mirror DIR/);
  });

  test('local mode: refresh is unavailable (exit 2, one line), writes no state', async () => {
    for (const args of [['refresh'], ['refresh', '--wait'], ['refresh', '--json'], ['refresh', '--local', '--json']]) {
      const r = await brain(args, { cwd: repo, home, env: args.includes('--local') ? { BRAIN_READER_URL: `postgresql://brain_reader:${PW}@127.0.0.1:9/x` } : {} });
      assert.equal(r.status, 2, r.stdout + r.stderr);
      const line = args.includes('--json') ? JSON.parse(r.stdout) : { message: r.stdout.trim() };
      assert.match(line.message, /^refresh unavailable: local mode \(no BRAIN_READER_URL\)/);
      if (args.includes('--json')) assert.deepEqual(Object.keys(line).sort(), ['exit', 'message', 'runId']);
      else assert.equal(r.stdout.split('\n').length, 2, r.stdout);
    }
    assert.equal(existsSync(join(home, '.cache', 'brain', 'refresh')), false);
  });

  test('an unreachable reader: exit 2 noServer, quickly; the password never printed', async () => {
    const r = await brain(['refresh'], { cwd: repo, home, env: { BRAIN_READER_URL: `postgresql://brain_reader:${PW}@127.0.0.1:9/x?sslmode=disable` } });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.equal(r.stdout.trim(), MSG.noServer);
    assert.ok(!(r.stdout + r.stderr).includes(PW));
  });

  test('a reader that stalls after the startup: the connect + check is bounded by the call budget (F8), exit 2', async () => {
    const pg = await stallingPgServer();
    try {
      const r = await brain(['refresh'], { cwd: repo, home, env: { BRAIN_REFRESH_CALL_S: '2', BRAIN_READER_URL: `postgresql://brain_reader:${PW}@127.0.0.1:${pg.port}/none` } });
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.equal(r.stdout.trim(), MSG.noServer);
      assert.ok(r.ms < 2000 + 3000, `took ${r.ms} ms`);
    } finally { await pg.close(); }
  });

  test('a local git read that hangs (the origin) is killed inside the call budget (F8)', async () => {
    const bin = fakeGit(root);
    const r = await brain(['refresh'], { cwd: repo, home, env: { PATH: `${bin}:${process.env.PATH}`, P3_HANG: '1', BRAIN_REFRESH_CALL_S: '3',
      BRAIN_READER_URL: `postgresql://brain_reader:${PW}@127.0.0.1:9/x?sslmode=disable` } });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.equal(r.stdout.trim(), MSG.noServer);
    assert.ok(r.ms < 3000 + 2500, `took ${r.ms} ms`);
  });

  test('build and sync in server mode point to brain refresh, never a local write (#7)', async () => {
    const env = { BRAIN_READER_URL: `postgresql://brain_reader:${PW}@127.0.0.1:9/x` };
    for (const args of [['build', repo], ['sync']]) {
      const r = await brain(args, { cwd: repo, home, env });
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stdout, /\(server-mode\).*brain refresh updates it, or add --local/);
    }
  });

  test('ci-publish is a brain command; its env passes through (BRAIN_PUBLISH_WORKFLOW); it never reads the reader URL', async () => {
    const short = { BRAIN_READER_URL: 'postgresql://brain_reader:pw@127.0.0.1:9/x' };   // refused by every other command
    const r = await brain(['ci-publish'], { cwd: repo, home, env: short });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout, /^ci-publish: usage: missing or bad .*--source, --mirror/m);
    const base = { BRAIN_WRITER_URL: 'postgresql://w:x@127.0.0.1:9/x', BRAIN_SOURCE_REPO: 'o/r', BRAIN_SOURCE_TOKEN: 't', GITHUB_REPOSITORY: 'o/ops',
      GITHUB_WORKFLOW_REF: 'o/ops/.github/workflows/brain-bootstrap.yml@refs/heads/main', GHA_RUN_ID: '5', GHA_RUN_ATTEMPT: '1' };
    const args = ['ci-publish', '--source', repo, '--mirror', join(root, 'mirror'), '--mode', 'bootstrap', '--full'];
    const without = await brain(args, { cwd: repo, home, env: base });
    assert.equal(without.status, 2, without.stdout + without.stderr);
    assert.match(without.stdout, /usage: missing or bad BRAIN_PUBLISH_WORKFLOW \(bootstrap mode\)$/m);
    const bare = await brain(['ci-publish', '--source', repo, '--mirror', join(root, 'mirror'), '--mode'], { cwd: repo, home, env: base });
    assert.match(bare.stdout, /--mode normal\|bootstrap/, 'a --mode with no value is not taken as normal');
    // with it, usage passes: the run goes on to the prepare stage and fails there (a source with no HEAD: before any
    // network call), never usage
    const noHead = mkdtempSync(join(root, 'nohead-'));
    const withIt = await brain(['ci-publish', '--source', noHead, ...args.slice(3)], { cwd: repo, home, env: { ...base, BRAIN_PUBLISH_WORKFLOW: '.github/workflows/brain-publish.yml' } });
    assert.doesNotMatch(withIt.stdout, /usage:/, withIt.stdout);
    assert.match(withIt.stdout, /^brain-stage prepare fail /m, withIt.stdout);
    assert.equal(withIt.status, 1, withIt.stdout + withIt.stderr);
  });

  test('git children see no token and no brain setting (F9 / P16)', async () => {
    const env = { ...process.env, BRAIN_DISPATCH_TOKEN: FAKE_TOKEN, GH_TOKEN: FAKE_TOKEN + 'g', GITHUB_TOKEN: FAKE_TOKEN + 'h', BRAIN_READER_URL: 'postgresql://x' };
    const r = await runGit(['-c', 'alias.envdump=!env', 'envdump'], { cwd: repo, timeoutMs: 10_000, env });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^GIT_TERMINAL_PROMPT=0$/m);
    assert.doesNotMatch(r.stdout, /^(BRAIN_|GH_|GITHUB_)/m);
    assert.ok(!r.stdout.includes(FAKE_TOKEN));
  });
});

// ---------- the footer and guard texts (answer.mjs) ----------

const cells = (over = {}) => ({ code: { state: 'behind', behind: 3 }, memory: { state: 'old', ageMs: 27 * 3600e3 }, activity: { state: 'idle' },
  last: { state: 'failed', stage: 'sync', agoMs: 40 * 60e3 }, run: 42,
  cells: ['3 commits behind main', 'github as of 27h ago (stale)', 'last attempt FAILED 40m ago (sync)'], ...over });
const fresh = (over = {}) => ({
  code: { state: 'stale', commit: '9f3c2e1a' + '0'.repeat(32), head: 'abcdef12' + '0'.repeat(32), behind: 2, diverged: false, changed: 0, files: [] },
  github: { state: 'stale', asOf: '2026-11-14T09:00:00Z', syncedAt: '2026-11-14T09:30:00Z', fullAt: null, runAt: null, pid: null, error: null },
  brain: { run: 42, commit: '9f3c2e1a' + '0'.repeat(32), publishedAt: new Date(Date.now() - 3 * 3600e3).toISOString(), asOf: false, latest: 42 }, ...over });
const cov = { state: 'complete', reasons: [] };

describe('server footer and hints', () => {
  test('the newest run: its run, the four cells, then the checkout; no local sync hint', () => {
    const [, line] = footer({ coverage: cov, freshness: fresh({ staleness: cells() }) });
    assert.equal(line, '  freshness: brain data: run 42 @9f3c2e1a (published 3h ago) · 3 commits behind main · github as of 27h ago (stale) · '
      + 'last attempt FAILED 40m ago (sync) · code @9f3c2e1a · HEAD @abcdef12 · 2 commits behind');
    for (const t of ['behind main', '(stale)']) assert.ok(line.includes(t), t);
    assert.ok(REFRESH_TRIGGERS.includes('(stale)'));
    assert.doesNotMatch(line, /brain sync|brain build/);
  });

  test('a newer run published meanwhile is named; --as-of shows no cells and no sync hint', () => {
    const [, newer] = footer({ coverage: cov, freshness: fresh({ staleness: cells({ run: 43, cells: ['= main', 'github as of 2h ago'] }) }) });
    assert.match(newer, /brain data: run 42 @9f3c2e1a \(published 3h ago\) · = main · github as of 2h ago · latest run 43 · code @9f3c2e1a/);
    const asOf = fresh({ brain: { ...fresh().brain, run: 17, asOf: true, latest: 42 } });
    const [, old] = footer({ coverage: cov, freshness: asOf });
    assert.match(old, /brain data as of run 17 @9f3c2e1a \(\d{4}-\d\d-\d\d, as-of\) · latest run 42 · code @9f3c2e1a/);
    assert.match(old, /github data as of 2026-11-14 09:00Z \(\d+[mhd] old, stale · full sync never\)$/);
    assert.doesNotMatch(old, /brain sync|behind main|\(stale\)/);
  });

  test('local mode keeps its footer and hints', () => {
    const [, line] = footer({ coverage: cov, freshness: fresh({ brain: undefined }) });
    assert.match(line, /stale: run brain sync/);
    assert.throws(() => guard({ meta: { sanitize_version: -1 }, sync: null }), (e) => e instanceof GuardError && /run: brain build <repo>/.test(e.message));
  });

  test('a server run written before the current sanitizer: ask an admin to run the bootstrap (#7)', () => {
    const v = SANITIZE_VERSION;
    assert.throws(() => guard({ meta: { brain_run: 3, sanitize_version: v - 1 }, sync: null }),
      (e) => e instanceof GuardError && e.store === 'code' && /team brain's index was published before secret masking v\d+ \(has v-?\d+\) — ask an admin to run the bootstrap/.test(e.message)
        && !/brain build|brain sync/.test(e.message));
    assert.throws(() => guard({ meta: { brain_run: 3, sanitize_version: v }, sync: { cursor: 'x', sanitize_version: 0 } }),
      (e) => e instanceof GuardError && e.store === 'github' && /team brain's github data .* ask an admin to run the bootstrap \(brain-bootstrap\.yml\)$/.test(e.message));
  });
});

// ---------- Neon ----------

const NEON = process.env.BRAIN_P3_NEON === '1' && !!process.env.NEON_PROJECT_ID;
process.env.BRAIN_TEST_BRANCH_PREFIX ||= 'p3b';
const H = NEON ? await import('../pg/harness.mjs') : null;
const b = NEON ? H.useBranch('cli') : null;

describe('Neon: server mode through bin/brain', { skip: NEON ? false : 'set BRAIN_P3_NEON=1 and NEON_PROJECT_ID (one throwaway branch)' }, () => {
  const root = tempDir('brain-p3-clin-');
  let repo, home, reader, bin;
  const SHA1 = `aaaaaaa1${'0'.repeat(32)}`, OTHER = `b${'1'.repeat(39)}`;

  before(async () => {
    const { buildStores, goldenState } = await import('../pg/golden/build-golden.mjs');
    const { writeRun } = await import('../pg/write-run.mjs');
    const { githubDbPath } = await import('../../src/gh-schema.mjs');
    await b.migrate();
    await b.seed();
    // r2: the r1 build at another commit, its GitHub state written by the current sanitizer, T = now
    const r1 = buildStores();
    const codeDb = join(root, 'r2.db'), ghDb = githubDbPath(codeDb);
    copyFileSync(r1.codeDb, codeDb); copyFileSync(r1.ghDb, ghDb);
    const now = new Date().toISOString();
    for (const [file, sql] of [[codeDb, `UPDATE meta SET value = '"golden02"' WHERE key = 'build_id'; UPDATE meta SET value = '"${SHA1}"' WHERE key = 'commit';`],
      [ghDb, `UPDATE refs SET resolved_build = 'golden02' WHERE resolved_build = 'golden00'; UPDATE sync_state SET sanitize_version = 1, cursor = '${now}', last_ok_at = '${now}';`]]) {
      const db = new DatabaseSync(file);
      try { db.exec(sql); } finally { db.close(); }
    }
    const w = await b.connect('writer');
    try {
      const { run } = await writeRun(w, { ...goldenState(r1.codeDb, r1.ghDb), run: 1 }, goldenState(codeDb, ghDb), { gha: 300 });
      assert.equal(run, 2);
    } finally { await w.end(); }
    repo = checkout(root);
    home = mkdtempSync(join(root, 'home-'));
    bin = fakeGit(root);
    reader = { BRAIN_READER_URL: b.readerUrl };
  });
  /** main: origin's main as ls-remote reports it (null: ls-remote fails) */
  const run = (args, { main = SHA1, env = {} } = {}) => brain(args, { cwd: repo, home,
    env: { ...reader, PATH: `${bin}:${process.env.PATH}`, ...(main && { P3_MAIN: main }), ...env } });
  const noSecret = (r) => assert.ok(!(r.stdout + r.stderr).includes(new URL(b.readerUrl).password), 'the reader password in output');
  const stateDir = () => join(home, '.cache', 'brain', 'refresh');

  test('brain status: the store view (run, commit, GitHub state) and the four cells (#4); nothing local is read', async () => {
    const r = await run(['status']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    noSecret(r);
    assert.match(r.stdout, /^brain status {2}server · o\/r \(the team brain, read-only\)$/m);
    assert.match(r.stdout, /run +2 @aaaaaaa1 · published \d{4}-\d\d-\d\d \d\d:\d\dZ \(\d+[smh] ago\)/);
    assert.match(r.stdout, /github +data as of \d{4}-\d\d-\d\d \d\d:\d\dZ · last ok /);
    assert.match(r.stdout, /code += main \(main @aaaaaaa1\)$/m);
    assert.match(r.stdout, /memory +github as of \d+[sm] ago$/m);
    assert.match(r.stdout, /activity +idle$/m);
    assert.match(r.stdout, /last +ok \d+[smh] ago$/m);
    assert.match(r.stdout, /actions +not read \(no BRAIN_DISPATCH_TOKEN\)/);
    assert.match(r.stdout, /freshness: brain data: run 2 @aaaaaaa1 \(published \d+[smh] ago\) · = main · github as of \d+[sm] ago · code @aaaaaaa1/);
    assert.equal(existsSync(join(home, '.cache', 'brain', 'mirror')), false, 'status pulled a mirror');
    const j = JSON.parse((await run(['status', '--json'])).stdout);
    assert.equal(j.mode, 'server');
    assert.deepEqual({ run: j.run.run, commit: j.run.commit, asOf: j.run.asOf, latest: j.run.latest }, { run: 2, commit: SHA1, asOf: false, latest: 2 });
    assert.ok(j.sync.cursor && j.sync.lastOkAt);
    assert.deepEqual([j.staleness.code.state, j.staleness.memory.state, j.staleness.activity.state, j.staleness.last.state, j.staleness.run], ['same', 'fresh', 'idle', 'ok', 2]);
    assert.deepEqual(j.checks, { db: 'ok', git: 'ok', actions: 'no-token' });
    assert.equal(j.freshness.staleness.run, 2);
    const down = await run(['status'], { main: null });
    assert.match(down.stdout, /code +unknown \(git ls-remote origin failed\)$/m);
    assert.match(down.stdout, /freshness: brain data: run 2 @aaaaaaa1 \(published \d+[smh] ago\) · \(freshness unknown\) · github as of/);
    const old = await run(['status', '--as-of', 'run:1']);
    assert.equal(old.status, 0, old.stdout + old.stderr);
    assert.match(old.stdout, /run +1 @[0-9a-f]{8} · published .* · as-of · latest run 2/);
    assert.match(old.stdout, /freshness: brain data as of run 1 /);
  });

  test('every answer from the newest run carries the cells: search (server store) and find (mirror)', async () => {
    for (const args of [['search', 'credits'], ['find', 'reserve']]) {
      const r = await run(args);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      noSecret(r);
      assert.match(r.stdout, /freshness: brain data: run 2 @aaaaaaa1 \(published \d+[smh] ago\) · = main · github as of \d+[sm] ago · code @aaaaaaa1/, args.join(' '));
      assert.doesNotMatch(r.stdout, /brain sync|or brain build/, args.join(' '));
      const moved = await run(args, { main: OTHER });
      assert.match(moved.stdout, /freshness: brain data: run 2 @aaaaaaa1 \(published \d+[smh] ago\) · differs from main · github as of/, args.join(' '));
      const j = JSON.parse((await run([...args, '--json'])).stdout);
      assert.deepEqual([j.freshness.staleness.code.state, j.freshness.staleness.memory.state, j.freshness.staleness.run, j.freshness.brain.run], ['same', 'fresh', 2, 2], args.join(' '));
    }
  });

  test('--as-of: no cells (that run is old on purpose); a run of the old sanitizer: ask an admin to run the bootstrap (#7)', async () => {
    const r = await run(['search', 'credits', '--as-of', 'run:2', '--json']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(JSON.parse(r.stdout).freshness.staleness, undefined);
    const v0 = await run(['search', 'credits', '--as-of', 'run:1']);
    assert.equal(v0.status, 1, v0.stdout + v0.stderr);
    assert.match(v0.stdout, /\(rebuild-needed\): the team brain's github data was published before secret masking v1 \(has v0\) — ask an admin to run the bootstrap/);
    assert.doesNotMatch(v0.stdout, /brain sync|brain build/);
  });

  test('brain refresh: fresh (F1) exit 0 · main moved without a token exit 2 · main unknown exit 2; no state left', async () => {
    const fresh = await run(['refresh', '--json']);
    assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr);
    assert.deepEqual(JSON.parse(fresh.stdout), { exit: 0, message: MSG.fresh, runId: 2 });
    const moved = await run(['refresh'], { main: OTHER });
    assert.equal(moved.status, 2, moved.stdout + moved.stderr);
    assert.equal(moved.stdout.trim(), MSG.noPermission);
    const down = await run(['refresh', '--wait'], { main: null });
    assert.equal(down.status, 2, down.stdout + down.stderr);
    assert.equal(down.stdout.trim(), MSG.noGithub);
    for (const r of [fresh, moved, down]) noSecret(r);
    assert.deepEqual(readdirSync(stateDir()).filter((f) => f.endsWith('.json')), []);
  });

  test('brain refresh refusals keep its one-line form: not the reader account, another repo (exit 2)', async () => {
    const owner = await run(['refresh'], { env: { BRAIN_READER_URL: b.ownerUrl } });
    assert.equal(owner.status, 2, owner.stdout + owner.stderr);
    assert.match(owner.stdout, /^refresh unavailable: BRAIN_READER_URL logs in as "neondb_owner", not brain_reader .*\n$/);
    assert.ok(!(owner.stdout + owner.stderr).includes(new URL(b.ownerUrl).password), 'the owner password in output');
    const elsewhere = checkout(root, 'https://github.com/o/other.git');
    const other = await brain(['refresh', '--json'], { cwd: elsewhere, home, env: { ...reader, PATH: `${bin}:${process.env.PATH}`, P3_MAIN: SHA1 } });
    assert.equal(other.status, 2, other.stdout + other.stderr);
    const j = JSON.parse(other.stdout);
    assert.deepEqual([j.exit, j.runId], [2, null]);
    assert.match(j.message, /^refresh unavailable: the server brain is for o\/r, this checkout's origin is o\/other/);
  });

  test('the state file is keyed by the binding\'s source repo id: a held lock on it means another refresh (exit 75, its run)', async () => {
    // another brain on this laptop: source repo id 4242 (a throwaway branch: the owner lifts the binding's refuse trigger)
    await b.query('owner', 'ALTER TABLE brain.binding DISABLE TRIGGER refuse; UPDATE brain.binding SET source_repo_id = 4242 WHERE id = 1; ALTER TABLE brain.binding ENABLE TRIGGER refuse');
    const path = join(stateDir(), '4242.json'), now = Date.now();
    writeFileSync(path, JSON.stringify({ v: 1, startedAt: new Date(now - 60e3).toISOString(), deadline: new Date(now + 14 * 60e3).toISOString(),
      baseT: null, baseHead: SHA1, runId: 777, dispatchedAt: new Date(now - 60e3).toISOString(), extraDispatches: 0 }), { mode: 0o600 });
    const { value: r } = await withWriteLock(path, () => run(['refresh'], { main: OTHER, env: { BRAIN_DISPATCH_TOKEN: FAKE_TOKEN } }));
    assert.equal(r.status, 75, r.stdout + r.stderr);
    assert.match(r.stdout.trim(), /^still running \(actions run 777, 1m\)$/);
    assert.ok(!(r.stdout + r.stderr).includes(FAKE_TOKEN));
    assert.ok(existsSync(path), 'a busy lock leaves the other refresh\'s state alone');
    assert.equal(existsSync(join(stateDir(), '1.json')), false);
  });

  test('S7 / P10: the last attempt failed as not-descendant -> brain status gives the bootstrap hint in one row', async () => {
    const before = await run(['status']);
    assert.doesNotMatch(before.stdout, /^ *next /m);
    // what ci-publish records for a normal publish on a rewritten main (the writer: insert running, then end it once)
    const id = (await b.query('writer', "INSERT INTO brain.attempt (gha_run_id, gha_attempt, source_sha, base_run) VALUES (991, 1, $1, 2) RETURNING attempt_id", [OTHER])).rows[0].attempt_id;
    await b.query('writer', "UPDATE brain.attempt SET status = 'failed', stage = 'publish', error = 'publish:not-descendant', finished_at = now() WHERE attempt_id = $1", [id]);
    const r = await run(['status'], { main: OTHER });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    noSecret(r);
    assert.match(r.stdout, /last +failed \(publish\) \d+[smh] ago$/m);
    const rows = r.stdout.split('\n').filter((l) => /^ *next /.test(l));
    assert.equal(rows.length, 1, r.stdout);
    assert.ok(rows[0].includes(BOOTSTRAP_HINT), r.stdout);
    const j = JSON.parse((await run(['status', '--json'], { main: OTHER })).stdout);
    assert.equal(j.staleness.last.state, 'failed');
  });
});
