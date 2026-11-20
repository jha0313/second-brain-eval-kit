// Phase 3 S3: staleness cells and footer (docs/phase3-design.md §6.5; §7.3 P3, P4, P13, P14; F8 for git and DB).
// Offline: git repos in a temp dir, a stub reader, an in-process Actions stub. The Neon part (STATUS_SQL against the
// real schema under brain_reader) runs only with BRAIN_P3_OWNER_URL set (see neonReader below).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { staleness, footerLine, STATUS_SQL, runGit, bootstrapHint } from '../../src/pg/status.mjs';
import { needsRefresh, REFRESH_TRIGGERS, FRESHNESS_UNKNOWN, CODE_STATES, MEMORY_STATES, BOOTSTRAP_HINT } from '../../src/pg/contract.mjs';
import { gitRepos, createWorld, stubReader, worldActions, stubBin, alive, H, M } from './stub.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const clock = { now: () => Date.now() };

/** a world whose latest run is at the origin's main HEAD, T = tAgoMs ago */
function setup({ tAgoMs = H, run = true } = {}) {
  const repos = gitRepos();
  const world = createWorld({ clock, repos });
  if (run) world.seedRun({ commit: repos.head(), tAgoMs });
  return { repos, world, reader: stubReader(world) };
}
const look = (x, extra = {}) => staleness({ reader: x.reader, repoDir: x.repos.clone, actions: null, ...extra });

describe('P3 staleness table: code x memory -> footer and needsRefresh', () => {
  const code = { same: { state: 'same', behind: 0, runCommit: 'a'.repeat(40) }, behind: { state: 'behind', behind: 3, runCommit: 'a'.repeat(40) },
    differs: { state: 'differs', runCommit: 'a'.repeat(40) }, unknown: { state: 'unknown', runCommit: 'a'.repeat(40) } };
  const memory = { fresh: { state: 'fresh', ageMs: 2 * H }, old: { state: 'old', ageMs: 27 * H }, never: { state: 'never', ageMs: null }, unknown: { state: 'unknown', ageMs: null } };
  const codeText = { same: '= main', behind: '3 commits behind main', differs: 'differs from main', unknown: FRESHNESS_UNKNOWN };
  const memText = { fresh: 'github as of 2h ago', old: 'github as of 27h ago (stale)', never: 'github never synced', unknown: FRESHNESS_UNKNOWN };
  for (const c of CODE_STATES) for (const m of MEMORY_STATES) {
    test(`${c} x ${m}`, () => {
      const s = { code: code[c], memory: memory[m], activity: { state: 'idle' }, last: null, run: 42 };
      const line = footerLine(s);
      assert.ok(line.startsWith('brain data: run 42 @aaaaaaaa · '), line);
      assert.ok(line.includes(codeText[c]), line);
      assert.ok(line.includes(memText[m]), line);
      assert.equal(line.split(FRESHNESS_UNKNOWN).length - 1, c === 'unknown' || m === 'unknown' ? 1 : 0, `one ${FRESHNESS_UNKNOWN}: ${line}`);
      const want = ['behind', 'differs'].includes(c) || ['old', 'never'].includes(m);
      assert.equal(needsRefresh(s), want);
      // the trigger phrases SKILL.md looks for are present exactly when a refresh is needed
      assert.equal(REFRESH_TRIGGERS.some((p) => line.includes(p)), want, line);
    });
  }
  test('the design example line', () => {
    const s = { code: { state: 'behind', behind: 3, runCommit: '9f3c2e1a'.padEnd(40, '0') }, memory: { state: 'old', ageMs: 27 * H + 5 * M },
      activity: { state: 'idle' }, last: { state: 'failed', stage: 'sync', agoMs: 40 * M }, run: 42 };
    assert.equal(footerLine(s), 'brain data: run 42 @9f3c2e1a · 3 commits behind main · github as of 27h ago (stale) · last attempt FAILED 40m ago (sync)');
  });
});

describe('P3 cells from real inputs', () => {
  test('same: latest run = main HEAD; memory fresh 1h', async () => {
    const x = setup();
    const s = await look(x);
    assert.equal(s.code.state, 'same');
    assert.equal(s.memory.state, 'fresh');
    assert.equal(s.run, 1);
    assert.equal(needsRefresh(s), false);
    assert.match(footerLine(s), /^brain data: run 1 @[0-9a-f]{8} · = main · github as of 1h ago$/);
  });
  test('behind N from local objects (1 and 3)', async () => {
    const x = setup();
    x.repos.push(1); x.repos.fetch();
    let s = await look(x);
    assert.deepEqual([s.code.state, s.code.behind], ['behind', 1]);
    assert.ok(footerLine(s).includes('1 commit behind main'));
    x.repos.push(2); x.repos.fetch();
    s = await look(x);
    assert.deepEqual([s.code.state, s.code.behind], ['behind', 3]);
    assert.ok(footerLine(s).includes('3 commits behind main'));
    assert.equal(s.code.mainHead, x.repos.head());
  });
  test('differs: main moved but the clone has not fetched (no local objects, no fetch by status)', async () => {
    const x = setup();
    x.repos.push(2);
    const s = await look(x);
    assert.equal(s.code.state, 'differs');
    assert.ok(footerLine(s).includes('differs from main'));
  });
  test('differs in a partial clone: missing commits are not fetched from the promisor remote (local objects only)', async () => {
    const x = setup();
    execFileSync('git', ['-C', x.repos.origin, 'config', 'uploadpack.allowFilter', 'true']);
    const partial = join(x.repos.root, 'partial');
    execFileSync('git', ['clone', '-q', '--filter=blob:none', `file://${x.repos.origin}`, partial], { stdio: 'ignore' });
    const head = x.repos.push(2);
    const s = await staleness({ reader: x.reader, repoDir: partial, actions: null });
    assert.equal(s.code.state, 'differs');
    const has = spawnSync('git', ['-C', partial, 'cat-file', '-e', `${head}^{commit}`], { env: { ...process.env, GIT_NO_LAZY_FETCH: '1' } });
    assert.notEqual(has.status, 0, 'the new main commit was not fetched');
  });
  test('differs: run commit is not an ancestor of main (force-push shape)', async () => {
    const repos = gitRepos();
    const world = createWorld({ clock, repos });
    world.seedRun({ commit: repos.sideCommit(), tAgoMs: H });
    const s = await staleness({ reader: stubReader(world), repoDir: repos.clone, actions: null });
    assert.equal(s.code.state, 'differs');
  });
  test('no run yet: differs + never synced', async () => {
    const x = setup({ run: false });
    const s = await look(x);
    assert.deepEqual([s.run, s.code.state, s.memory.state], [null, 'differs', 'never']);
    assert.equal(footerLine(s), 'brain data: no published run · differs from main · github never synced');
  });
  test('unknown: ls-remote fails', async () => {
    const x = setup();
    x.repos.setOrigin(join(x.repos.root, 'missing.git'));
    const s = await look(x);
    assert.equal(s.code.state, 'unknown');
    assert.equal(s.memory.state, 'fresh');
    assert.ok(footerLine(s).endsWith(`· ${FRESHNESS_UNKNOWN} · github as of 1h ago`), footerLine(s));
    assert.equal(needsRefresh(s), false, 'unknown alone never dispatches');
  });
  test('old: 27h; never: a run without github sync_state; unknown: the reader fails', async () => {
    let x = setup({ tAgoMs: 27 * H });
    let s = await look(x);
    assert.equal(s.memory.state, 'old');
    assert.ok(footerLine(s).includes('github as of 27h ago (stale)'));
    x = setup({ tAgoMs: null });
    s = await look(x);
    assert.equal(s.memory.state, 'never');
    x = setup();
    x.reader.mode = 'fail';
    s = await look(x);
    assert.deepEqual([s.memory.state, s.code.state, s.run], ['unknown', 'unknown', null]);
    assert.equal(footerLine(s), `brain data: · ${FRESHNESS_UNKNOWN}`);
  });
  test('memory boundary: 24h exactly is old, 1s less is fresh (DB clock)', async () => {
    let x = setup({ tAgoMs: 24 * H });
    assert.equal((await look(x)).memory.state, 'old');
    x = setup({ tAgoMs: 24 * H - 1000 });
    assert.equal((await look(x)).memory.state, 'fresh');
  });
  test('a missed schedule: one run at main, only the DB clock moves; 24h - 1ms is fresh, exactly 24h is (stale) and asks for a refresh', async () => {
    const C = Math.floor(Date.now() / 1000) * 1000;   // a whole second: the stored cursor keeps no milliseconds
    const fixed = { t: C, now() { return this.t; } };
    const repos = gitRepos();
    const world = createWorld({ clock: fixed, repos });
    world.seedRun({ commit: repos.head(), tAgoMs: 0 });   // GitHub cursor = C
    const x = { repos, world, reader: stubReader(world) };
    fixed.t = C + 24 * H - 1;
    let s = await look(x);
    assert.deepEqual([s.code.state, s.memory.state, needsRefresh(s)], ['same', 'fresh', false]);
    assert.ok(!REFRESH_TRIGGERS.some((t) => footerLine(s).includes(t)));
    fixed.t = C + 24 * H;
    s = await look(x);
    assert.deepEqual([s.code.state, s.memory.state, needsRefresh(s)], ['same', 'old', true]);
    assert.match(footerLine(s), / · = main · github as of 24h ago \(stale\)$/);
    assert.ok(REFRESH_TRIGGERS.some((t) => footerLine(s).includes(t)));   // the words SKILL.md rule 10 reads
  });
  test('F10: the only statement is STATUS_SQL, a single read without params', async () => {
    const x = setup();
    await look(x);
    assert.deepEqual(x.reader.sql, [STATUS_SQL]);
    assert.match(STATUS_SQL, /^SELECT /);
    assert.doesNotMatch(STATUS_SQL, /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP|GRANT|LOCK)\b/i);
  });
});

describe('P4 failure display and last', () => {
  test('F1: Actions failed, no DB attempt -> failed before start', async () => {
    const x = setup();
    x.world.addActionsRun({ conclusion: 'failure', createdMs: Date.now() - 10 * M, startedMs: Date.now() - 10 * M });
    const s = await look(x, { actions: worldActions(x.world) });
    assert.equal(s.last.state, 'failed before start');
    assert.ok(footerLine(s).endsWith('last attempt FAILED before start 10m ago'), footerLine(s));
  });
  test('F4: DB attempt failed in sync -> failed (sync)', async () => {
    const x = setup();
    const r = x.world.addActionsRun({ conclusion: 'failure', createdMs: Date.now() - 40 * M });
    x.world.addAttempt({ ghaRunId: r.id, status: 'failed', stage: 'sync', startedMs: Date.now() - 40 * M });
    const s = await look(x, { actions: worldActions(x.world) });
    assert.deepEqual([s.last.state, s.last.stage], ['failed', 'sync']);
    assert.ok(footerLine(s).endsWith('last attempt FAILED 40m ago (sync)'));
  });
  test('S7 / P10: the last attempt failed as not-descendant -> the bootstrap hint; another failure or a newer end -> none', async () => {
    const x = setup();
    const r = x.world.addActionsRun({ conclusion: 'failure', createdMs: Date.now() - 30 * M });
    x.world.addAttempt({ ghaRunId: r.id, status: 'failed', stage: 'publish', error: 'publish:not-descendant', startedMs: Date.now() - 30 * M });
    let s = await look(x, { actions: worldActions(x.world) });
    assert.deepEqual([s.last.state, s.last.stage], ['failed', 'publish']);
    assert.deepEqual(Object.keys(s.last).sort(), ['agoMs', 'stage', 'state']);   // the `last` cell (JSON too) is unchanged
    assert.equal(s.detail.executions[0].error, 'publish:not-descendant');
    assert.equal(bootstrapHint(s.detail.executions), BOOTSTRAP_HINT);
    assert.ok(!BOOTSTRAP_HINT.includes('\n') && BOOTSTRAP_HINT.includes('brain-bootstrap.yml') && BOOTSTRAP_HINT.includes('BRAIN_BOOTSTRAP_UNTIL'));
    // a newer failure before start (no DB attempt) is the last one now: no hint
    x.world.addActionsRun({ conclusion: 'failure', createdMs: Date.now() - 5 * M, startedMs: Date.now() - 5 * M });
    s = await look(x, { actions: worldActions(x.world) });
    assert.equal(s.last.state, 'failed before start');
    assert.equal(bootstrapHint(s.detail.executions), null);
    // another kind of failure: no hint
    const y = setup();
    const q = y.world.addActionsRun({ conclusion: 'failure', createdMs: Date.now() - 30 * M });
    y.world.addAttempt({ ghaRunId: q.id, status: 'failed', stage: 'publish', error: 'publish:base-moved', startedMs: Date.now() - 30 * M });
    assert.equal(bootstrapHint((await look(y, { actions: worldActions(y.world) })).detail.executions), null);
  });
  test('F8: DB running, Actions over -> abandoned', async () => {
    const x = setup();
    const r = x.world.addActionsRun({ conclusion: 'cancelled', createdMs: Date.now() - 20 * M });
    x.world.addAttempt({ ghaRunId: r.id, status: 'running', startedMs: Date.now() - 20 * M });
    const s = await look(x, { actions: worldActions(x.world) });
    assert.equal(s.last.state, 'abandoned');
    assert.equal(s.activity.state, 'idle');
    assert.ok(footerLine(s).endsWith('last attempt abandoned 20m ago'));
  });
  test('last picks the newest attempt start: a newer failed-before-start wins over an older DB failure, and the reverse', async () => {
    let x = setup();
    let r = x.world.addActionsRun({ conclusion: 'failure', createdMs: Date.now() - 50 * M });
    x.world.addAttempt({ ghaRunId: r.id, status: 'failed', stage: 'build', startedMs: Date.now() - 50 * M });
    x.world.addActionsRun({ conclusion: 'failure', createdMs: Date.now() - 5 * M, startedMs: Date.now() - 5 * M });
    assert.equal((await look(x, { actions: worldActions(x.world) })).last.state, 'failed before start');
    x = setup();
    x.world.addActionsRun({ conclusion: 'failure', createdMs: Date.now() - 50 * M, startedMs: Date.now() - 50 * M });
    r = x.world.addActionsRun({ conclusion: 'failure', createdMs: Date.now() - 5 * M });
    x.world.addAttempt({ ghaRunId: r.id, status: 'failed', stage: 'build', startedMs: Date.now() - 5 * M });
    const last = (await look(x, { actions: worldActions(x.world) })).last;
    assert.deepEqual([last.state, last.stage, Math.round(last.agoMs / M)], ['failed', 'build', 5]);
  });
  test('a re-run (attempt 2) that fails before start is newer than attempt 1 even though created_at is old', async () => {
    const x = setup();
    const r = x.world.addActionsRun({ conclusion: 'failure', createdMs: Date.now() - 3 * H, startedMs: Date.now() - 2 * M, runAttempt: 2 });
    x.world.addAttempt({ ghaRunId: r.id, ghaAttempt: 1, status: 'failed', stage: 'sync', startedMs: Date.now() - 3 * H });
    const s = await look(x, { actions: worldActions(x.world) });
    assert.deepEqual([s.last.state, Math.round(s.last.agoMs / M)], ['failed before start', 2]);
  });
  test('running and queued activity, with the current step as stage', async () => {
    const x = setup();
    x.world.dispatch();
    let s = await look(x, { actions: worldActions(x.world) });
    assert.equal(s.activity.state, 'queued');
    assert.ok(footerLine(s).includes('refresh queued'));
    const run = x.world.gh.runs.at(-1);
    Object.assign(run, { phase: 'running', startedMs: Date.now() - M, source: x.repos.head(), finishAt: Infinity });
    x.world.addAttempt({ ghaRunId: run.id, status: 'running', startedMs: Date.now() - M });
    s = await look(x, { actions: worldActions(x.world) });
    assert.deepEqual([s.activity.state, s.activity.runId, s.activity.stage], ['running', run.id, 'brain ci-publish build']);
    assert.ok(footerLine(s).includes('refresh running (brain ci-publish build)'));
  });
  test('without Actions: a running DB attempt is running? under 30 min, abandoned? over it', async () => {
    let x = setup();
    x.world.addAttempt({ ghaRunId: 5, status: 'running', startedMs: Date.now() - 10 * M });
    let s = await look(x);
    assert.equal(s.activity.state, 'running');
    x = setup();
    x.world.addAttempt({ ghaRunId: 5, status: 'running', startedMs: Date.now() - 31 * M });
    s = await look(x);
    assert.deepEqual([s.activity.state, s.last.state], ['idle', 'abandoned']);
  });
  test('a cancelled re-run of an old run is not hidden by runs created before the re-run started', async () => {
    const x = setup();
    x.world.addActionsRun({ phase: 'completed', conclusion: 'success', createdMs: Date.now() - 2 * H });   // newer than run r below
    x.world.addActionsRun({ conclusion: 'cancelled', runAttempt: 2, createdMs: Date.now() - 3 * H, startedMs: Date.now() - 5 * M });
    const s = await look(x, { actions: worldActions(x.world) });
    assert.equal(s.last.state, 'failed before start');
  });
  test('a pending run cancelled by a newer dispatch is not a failure (P8 shape)', async () => {
    const x = setup();
    // a pending run never started: run_started_at = created_at
    x.world.addActionsRun({ conclusion: 'cancelled', createdMs: Date.now() - 2 * M, startedMs: Date.now() - 2 * M });
    x.world.addActionsRun({ phase: 'queued', startAt: Infinity, createdMs: Date.now() - M });
    const s = await look(x, { actions: worldActions(x.world) });
    assert.equal(s.last?.state ?? null, 'ok');
    assert.equal(s.activity.state, 'queued');
  });
  test('a run that finishes between the DB read and the Actions read is read again, not shown abandoned', async () => {
    const x = setup();
    const r = x.world.addActionsRun({ conclusion: 'success', createdMs: Date.now() - 5 * M });
    const a = x.world.addAttempt({ ghaRunId: r.id, status: 'running', startedMs: Date.now() - 4 * M });
    const inner = x.reader.query.bind(x.reader);
    let n = 0;
    x.reader.query = async (sql, p) => { const res = await inner(sql, p); n += 1; if (n === 1) a.status = 'ok'; return res; };
    const s = await look(x, { actions: worldActions(x.world) });
    assert.equal(n, 2);
    assert.equal(s.last.state, 'ok');
  });
});

describe('P13 / P14', () => {
  test('P13: Actions API down -> code and memory still from git and the DB, footer says (freshness unknown)', async () => {
    const x = setup({ tAgoMs: 27 * H });
    const s = await look(x, { actions: worldActions(x.world, { fail: 'network' }) });
    assert.deepEqual([s.code.state, s.memory.state, s.detail.actions.ok, s.detail.actions.error], ['same', 'old', false, 'network']);
    assert.ok(footerLine(s).endsWith(`github as of 27h ago (stale) · ${FRESHNESS_UNKNOWN}`), footerLine(s));
    x.repos.setOrigin(join(x.repos.root, 'missing.git'));
    const s2 = await look(x, { actions: worldActions(x.world, { fail: 'network' }) });
    assert.equal(footerLine(s2).split(FRESHNESS_UNKNOWN).length - 1, 1, footerLine(s2));
    // no token is not "GitHub down": the footer stays as the DB and git say
    assert.ok(!footerLine(await look(x)).includes('github as of 27h ago (stale) · ('));
  });
  test('P14: laptop clock +2h changes nothing (server clocks only)', async () => {
    const x = setup({ tAgoMs: 23 * H + 30 * M });
    x.world.addActionsRun({ conclusion: 'failure', createdMs: Date.now() - 10 * M, startedMs: Date.now() - 10 * M });
    const a = await look(x, { actions: worldActions(x.world) });
    const b = await look(x, { actions: worldActions(x.world), now: () => Date.now() + 2 * H });
    for (const k of ['code', 'memory', 'activity']) assert.deepEqual({ ...b[k], ageMs: undefined, sinceMs: undefined }, { ...a[k], ageMs: undefined, sinceMs: undefined });
    assert.equal(b.memory.state, 'fresh');
    assert.equal(b.last.state, a.last.state);
    assert.equal(footerLine(b), footerLine(a));
  });
});

describe('F8 bounds: git and the DB', () => {
  test('a stalled ls-remote is killed with its remote helper inside the budget', async () => {
    const x = setup();
    const bin = stubBin();
    x.repos.setOrigin('hang::stall');
    const env = { ...process.env, PATH: `${bin.dir}:${process.env.PATH}` };
    const t0 = Date.now();
    const s = await staleness({ reader: x.reader, repoDir: x.repos.clone, actions: null, env, deadline: Date.now() + 1500 });
    const took = Date.now() - t0;
    assert.equal(s.code.state, 'unknown');
    assert.equal(s.detail.git.error, 'timeout');
    assert.ok(took < 2500, `took ${took} ms`);
    const pids = readFileSync(bin.pidFile, 'utf8').trim().split('\n').map(Number);
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(pids.length >= 1 && pids.every((p) => !alive(p)), 'the remote helper is gone');
  });
  test('runGit: no time left -> no process at all', async () => {
    const r = await runGit(['--version'], { cwd: here, timeoutMs: 0 });
    assert.deepEqual(r, { code: null, stdout: '', timedOut: true });
  });
  test('a hanging reader: the client-side timer destroys the socket, then ends the client', async () => {
    const x = setup();
    x.reader.mode = 'hang';
    const t0 = Date.now();
    const s = await staleness({ reader: x.reader, repoDir: x.repos.clone, actions: null, deadline: Date.now() + 800 });
    assert.ok(Date.now() - t0 < 1500);
    assert.deepEqual([s.memory.state, s.detail.db.error, x.reader.order], ['unknown', 'timeout', ['destroy', 'end']]);
  });
});

// ---- Neon (only with BRAIN_P3_READER_URL): STATUS_SQL on the real schema + golden seed, under brain_reader ----------
const READER_URL = process.env.BRAIN_P3_READER_URL;
describe('Neon: STATUS_SQL under brain_reader', { skip: READER_URL ? false : 'set BRAIN_P3_READER_URL (a throwaway branch with 001/002 + golden seed)' }, () => {
  test('golden seed -> run 1, T, binding, the ok attempt; memory age from DB now()', async () => {
    const client = new pg.Client({ connectionString: READER_URL, connectionTimeoutMillis: 15_000, query_timeout: 20_000 });
    await client.connect();
    try {
      const who = await client.query("SELECT current_user AS u, has_table_privilege(current_user, 'brain.run', 'INSERT') AS w");
      assert.deepEqual(who.rows[0], { u: 'brain_reader', w: false });
      const { rows } = await client.query(STATUS_SQL, []);
      const row = rows[0];
      assert.equal(typeof row.now_ms, 'number');
      assert.ok(Math.abs(row.now_ms - Date.now()) < 10 * M, 'DB now() is a real clock');
      assert.deepEqual(row.latest, { run: 1, commit: 'b070cb73666691f1bdd5fb238720ece1301fc069' });
      assert.equal(row.github_t, '2026-11-15T09:58:00Z');
      assert.deepEqual(row.binding, { sourceRepoId: 1, opsRepo: 'o/brain-ops', workflow: '.github/workflows/brain-publish.yml' });
      assert.equal(row.attempts.length, 1);
      assert.deepEqual({ ...row.attempts[0], startedMs: typeof row.attempts[0].startedMs },
        { ghaRunId: 1, ghaAttempt: 1, sourceSha: 'b070cb73666691f1bdd5fb238720ece1301fc069', status: 'ok', stage: null, error: null, startedMs: 'number' });
      // staleness over the real client: memory age = DB now() - T
      const repos = gitRepos();
      const s = await staleness({ reader: client, repoDir: repos.clone, actions: null });
      assert.equal(s.run, 1);
      assert.equal(s.code.state, 'differs');   // the seed commit is not in this temp repo
      assert.equal(s.memory.ageMs, s.detail.nowMs - Date.parse('2026-11-15T09:58:00Z'));
    } finally { await client.end(); }
  });
});
