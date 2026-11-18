// Phase 3 S4: brain refresh (docs/phase3-design.md §6.6 F1–F11; §7.3 P6, P8, P9, P11, P12, P13, P15, P16, P24, P25)
// and the Actions client. Offline: a GitHub stub HTTP server over a simulated world (brain DB + Actions + CI), a stub
// reader, temp git repos, a fake clock for the long flows and the real clock for concurrency and stalls.
// Neon (pg_sleep and a stalled TCP connection under brain_reader): only with BRAIN_P3_READER_URL.
// The real 80 s budget against stalls: only with BRAIN_P3_SLOW=1.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { refresh, loadState } from '../../src/refresh.mjs';
import { createActionsClient, actionsFromEnv } from '../../src/gh-actions.mjs';
import { staleness, STATUS_SQL } from '../../src/pg/status.mjs';
import { REFRESH_EXIT as EXIT, REFRESH_MESSAGES as MSG, REFRESH_LIMITS as LIM, refreshStatePath, BOOTSTRAP_HINT } from '../../src/pg/contract.mjs';
import {
  gitRepos, createWorld, stubReader, githubStub, fakeClock, tempDir, stubBin, alive, stallingPgServer,
  FAKE_TOKEN, OTHER_TOKEN, H, M,
} from './stub.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', '..', 'src');

/**
 * A stale brain (main 1 commit ahead of the latest run unless fresh), a GitHub stub, a client, a reader and a state
 * path. clock: fakeClock() (default) or { now: Date.now } for real time.
 */
async function rig(t, { clock = fakeClock(), fresh = false, tAgoMs = H, seed = true, world: wopts = {}, statePath } = {}) {
  const repos = gitRepos();
  const world = createWorld({ clock, repos, ...wopts });
  if (seed) world.seedRun({ commit: repos.head(), tAgoMs });
  if (!fresh) repos.push(1);
  const gh = await githubStub(world);
  t.after(() => gh.close());
  const actions = createActionsClient({ token: FAKE_TOKEN, api: gh.url });
  const reader = stubReader(world);
  const path = statePath ?? refreshStatePath(tempDir(), world.db.binding.sourceRepoId);
  const real = clock.sleep === undefined;
  const call = (extra = {}) => refresh({ wait: true, now: clock.now, ...(real ? { pollMs: 50 } : { sleep: clock.sleep }),
    statePath: path, reader, actions, repoDir: repos.clone, env: process.env, ...extra });
  return { repos, world, gh, actions, reader, statePath: path, call, clock };
}

/** call until the exit is not 75; returns every result with its duration on the given clock */
async function until(x, { max = 40, between = async () => {} } = {}) {
  const out = [];
  for (let i = 0; i < max; i++) {
    const t0 = x.clock.now();
    const r = await x.call();
    out.push({ ...r, took: x.clock.now() - t0 });
    if (r.exit !== EXIT.running) return out;
    await between();
  }
  throw new Error(`no final exit after ${max} calls`);
}
const exits = (rs) => rs.map((r) => r.exit);

describe('F1 / F4 / F7: the plain paths', () => {
  test('P24: already fresh -> exit 0 at once, no dispatch, no state file', async (t) => {
    const x = await rig(t, { fresh: true });
    const r = await x.call();
    assert.deepEqual(r, { exit: EXIT.fresh, message: MSG.fresh, runId: 1 });
    assert.equal(x.gh.count('dispatch'), 0);
    assert.equal(existsSync(x.statePath), false);
    assert.equal(x.clock.slept, 0);
  });
  test('stale -> dispatch {ref main, return_run_details}, 75 while it runs, then 0 with the new run', async (t) => {
    const x = await rig(t);
    const rs = await until(x);
    assert.equal(rs.at(-1).exit, EXIT.fresh);
    assert.equal(rs.at(-1).message, MSG.refreshed(2));
    assert.ok(rs.slice(0, -1).every((r) => r.exit === EXIT.running && /^still running \(actions run \d+, \d+[smh](, stage: .+)?\)$/.test(r.message)), JSON.stringify(rs));
    const posts = x.gh.log.filter((l) => l.method === 'POST');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].path, '/repos/acme/brain-ops/actions/workflows/brain-publish.yml/dispatches');
    assert.deepEqual(JSON.parse(posts[0].body), { ref: 'main', return_run_details: true });
    assert.ok(x.gh.log.every((l) => l.auth === 'dispatch-token'));
    assert.equal(existsSync(x.statePath), false, 'deleted on exit 0');
    assert.equal(x.world.publishes, 1);
    assert.ok(x.reader.sql.every((s) => s === STATUS_SQL), 'F10: reads only');
  });
  test('F11: the state file is v 1, mode 0600, with the contract fields; the deadline never moves', async (t) => {
    const x = await rig(t);
    const r1 = await x.call();
    assert.equal(r1.exit, EXIT.running);
    const st = JSON.parse(readFileSync(x.statePath, 'utf8'));
    assert.deepEqual(Object.keys(st).sort(), ['baseHead', 'baseT', 'deadline', 'dispatchedAt', 'extraDispatches', 'runId', 'startedAt', 'v']);
    assert.equal(st.v, 1);
    assert.equal(statSync(x.statePath).mode & 0o777, 0o600);
    assert.equal(Date.parse(st.deadline) - Date.parse(st.startedAt), LIM.deadlineMs);
    assert.equal(st.baseHead, x.repos.head());
    assert.equal(st.runId, r1.runId);
    await x.call();
    const st2 = loadState(x.statePath);
    assert.deepEqual([st2.startedAt, st2.deadline], [st.startedAt, st.deadline]);
  });
  test('F1 needs code same AND memory fresh: an unreadable T is not fresh (exit 2)', async (t) => {
    const x = await rig(t, { fresh: true });
    x.world.db.sync.at(-1).t = 'not a time';
    assert.deepEqual(await x.call(), { exit: EXIT.unavailable, message: MSG.noServer, runId: null });
    assert.equal(x.gh.count('dispatch'), 0);
  });
  test('F8: the deadline counts from the call, not from after a slow first look', async (t) => {
    const x = await rig(t);
    const inner = x.reader.query.bind(x.reader);
    let first = true;
    x.reader.query = async (sql, p) => { if (first) { first = false; x.clock.advance(60_000); } return inner(sql, p); };
    const t0 = x.clock.now();
    await x.call();
    const st = loadState(x.statePath);
    assert.ok(Math.abs(Date.parse(st.startedAt) - t0) < 1000, 'startedAt = call start');
    assert.equal(Date.parse(st.deadline) - Date.parse(st.startedAt), LIM.deadlineMs);
  });
  test('a publish between a look\'s DB read and its Actions read is confirmed by a second look, not reported as a failure', async (t) => {
    const x = await rig(t, { world: { runMs: 5 * M } });
    assert.equal((await x.call({ env: { ...process.env, BRAIN_REFRESH_CALL_S: '20' } })).exit, EXIT.running);
    const inner = x.reader.query.bind(x.reader);
    let jump = true;
    // after the DB snapshot of the first look, the run's remaining events become due: it publishes before the Actions read
    x.reader.query = async (sql, p) => {
      const r = await inner(sql, p);
      if (jump) {
        jump = false;
        const run = x.world.gh.runs.at(-1), now = x.clock.now();
        if (run.phase === 'queued') run.startAt = now - 10 * M;
        if (run.phase === 'starting') run.recordAt = now - 9 * M;
        if (run.phase === 'running') run.finishAt = now - M;
      }
      return r;
    };
    const r = await x.call();
    assert.deepEqual([r.exit, r.message], [EXIT.fresh, MSG.refreshed(2)]);
  });
  test('a run already in flight: no dispatch, wait for it (F1)', async (t) => {
    const x = await rig(t);
    x.world.dispatch();   // someone else's
    const rs = await until(x);
    assert.equal(rs.at(-1).exit, EXIT.fresh);
    assert.equal(x.gh.count('dispatch'), 0);
  });
  test('P24: first refresh (no run, no T) -> T appears -> exit 0', async (t) => {
    const x = await rig(t, { seed: false });
    const rs = await until(x);
    assert.deepEqual([rs.at(-1).exit, rs.at(-1).message], [EXIT.fresh, MSG.refreshed(1)]);
  });
});

describe('P11: split waits and the fixed deadline', () => {
  test('every call <= 80 s (the fake clock also counts real HTTP / git / reader time); 75 -> --wait -> 0', async (t) => {
    const x = await rig(t, { world: { runMs: 6 * M } });
    const rs = await until(x);
    assert.ok(rs.length >= 4, `several calls: ${exits(rs)}`);
    assert.ok(rs.every((r) => r.took <= LIM.callMs), JSON.stringify(rs.map((r) => r.took)));
    assert.deepEqual(exits(rs), [...Array(rs.length - 1).fill(EXIT.running), EXIT.fresh]);
  });
  test('a run that never ends: exit 1 at the 15 min deadline, not later; calling again does not extend it', async (t) => {
    const x = await rig(t);
    x.world.plans.push('hold');
    const t0 = x.clock.now();
    const rs = await until(x);
    assert.deepEqual([rs.at(-1).exit, rs.at(-1).message], [EXIT.failed, MSG.deadline]);
    assert.ok(x.clock.now() - t0 >= LIM.deadlineMs, `ended after ${x.clock.now() - t0} ms`);
    assert.ok(x.clock.now() - t0 <= LIM.deadlineMs + 5000, 'the last look is at the deadline, not later');
    assert.equal(existsSync(x.statePath), false);
    assert.equal(x.gh.count('dispatch'), 1);
    // the next call is a new refresh: it waits for the run still in flight and does not dispatch
    const r = await x.call();
    assert.equal(r.exit, EXIT.running);
    assert.equal(x.gh.count('dispatch'), 1);
  });
  test('P24: a state file past its deadline -> exit 1 once and removed; the next call starts again', async (t) => {
    const x = await rig(t);
    mkdirSync(dirname(x.statePath), { recursive: true });
    const t0 = x.clock.now();
    writeFileSync(x.statePath, JSON.stringify({ v: 1, startedAt: new Date(t0 - 20 * M).toISOString(), deadline: new Date(t0 - 5 * M).toISOString(),
      baseT: null, baseHead: x.repos.head(), runId: null, dispatchedAt: null, extraDispatches: 0 }), { mode: 0o600 });
    const r = await x.call();
    assert.deepEqual(r, { exit: EXIT.failed, message: MSG.deadline, runId: null });
    assert.equal(existsSync(x.statePath), false);
    assert.equal(x.gh.count('dispatch'), 0);
    const r2 = await x.call();
    assert.equal(r2.exit, EXIT.running);
    assert.equal(x.gh.count('dispatch'), 1);
  });
  test('BRAIN_REFRESH_CALL_S only shortens the call', async (t) => {
    const x = await rig(t, { world: { runMs: 6 * M } });
    let t0 = x.clock.now();
    await x.call({ env: { ...process.env, BRAIN_REFRESH_CALL_S: '30' } });
    assert.ok(x.clock.now() - t0 <= 30_000);
    t0 = x.clock.now();
    await x.call({ env: { ...process.env, BRAIN_REFRESH_CALL_S: '900' } });
    assert.ok(x.clock.now() - t0 <= LIM.callMs);
  });
});

describe('P6 / P8 / P9: concurrency, pending replacement, main moving', () => {
  test('P6: five refreshes on one machine + one on a second laptop: <= 2 dispatches, 1 publish, all exit 0', async (t) => {
    const x = await rig(t, { clock: { now: Date.now }, world: { queueMs: 40, prepMs: 80, runMs: 250 } });
    const laptop2 = refreshStatePath(tempDir(), 4242);
    const one = async (statePath) => {
      const seen = [];
      for (let i = 0; i < 200; i++) {
        const r = await x.call({ statePath, env: { ...process.env, BRAIN_REFRESH_CALL_S: '2' } });
        seen.push(r.exit);
        if (r.exit !== EXIT.running) return seen;
        await new Promise((res) => setTimeout(res, 30));
      }
      return seen;
    };
    const all = await Promise.all([...Array(5)].map(() => one(x.statePath)).concat([one(laptop2)]));
    assert.ok(all.every((s) => s.at(-1) === EXIT.fresh), JSON.stringify(all));
    assert.ok(all.slice(0, 5).some((s) => s.includes(EXIT.running) && s[0] === EXIT.running), 'a busy lock gave 75');
    assert.ok(x.gh.count('dispatch') <= 2, `dispatches ${x.gh.count('dispatch')}`);
    for (let i = 0; i < 100 && (x.world.tick(), x.world.gh.runs.some((r) => r.phase !== 'completed')); i++) await new Promise((res) => setTimeout(res, 30));
    assert.equal(x.world.publishes, 1);
    assert.equal(x.world.skips, x.world.dispatches - 1, 'the other dispatch ended skipped (A5)');
  });
  test('the lock held by another process, no --wait: exit 75 at once, no dispatch, state only read (F2, F11)', async (t) => {
    const x = await rig(t, { clock: { now: Date.now } });
    const holder = await holdLock(t, x.statePath, { runId: 777 });
    const t0 = Date.now();
    const r = await x.call({ wait: false });
    assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
    assert.equal(r.exit, EXIT.running);
    assert.equal(r.message, MSG.running(777, r.message.match(/, (\d+s)\)$/)[1], null));
    assert.match(r.message, /^still running \(actions run 777, \d+s\)$/);
    assert.equal(x.gh.count('dispatch'), 0);
    holder.kill('SIGKILL');
  });
  test('S7: --wait on a held lock waits for the holder, then carries on as the holder (one call, exit 0)', async (t) => {
    const x = await rig(t, { clock: { now: Date.now }, fresh: true });
    await holdLock(t, x.statePath, { runId: 777, finishMs: 1500 });   // the holder ends with exit 0 after 1.5 s
    const t0 = Date.now();
    const r = await x.call({ wait: true, lockPollMs: 100 });
    const took = Date.now() - t0;
    assert.equal(r.exit, EXIT.fresh, r.message);
    assert.ok(took >= 1200 && took < 10_000, `took ${took} ms`);
    assert.equal(x.gh.count('dispatch'), 0);
    assert.equal(existsSync(x.statePath), false, 'no state file left');
  });
  test('S7: --wait on a lock held past the call budget: exit 75 with the holder\'s state when the budget (less the last look) ends', async (t) => {
    const x = await rig(t, { clock: { now: Date.now } });
    const holder = await holdLock(t, x.statePath, { runId: 777 });
    const t0 = Date.now();
    const r = await x.call({ wait: true, lockPollMs: 100, start: t0 - (LIM.callMs - 5000 - 1500) });   // 1.5 s of budget left
    const took = Date.now() - t0;
    assert.equal(r.exit, EXIT.running);
    assert.match(r.message, /^still running \(actions run 777, \d+s\)$/);
    assert.ok(took >= 1300 && took < 5000, `took ${took} ms`);
    assert.equal(x.gh.count('dispatch'), 0);
    holder.kill('SIGKILL');
  });
  test('P24: a lock left by kill -9 does not block: the next refresh takes it and continues the file', async (t) => {
    const x = await rig(t, { clock: { now: Date.now }, world: { queueMs: 30, prepMs: 60, runMs: 200 } });
    const theirs = x.world.dispatch();
    const holder = await holdLock(t, x.statePath, { runId: theirs, baseT: x.world.statusRow().github_t });
    holder.kill('SIGKILL');
    await new Promise((res) => holder.on('exit', res));
    const rs = await until(x, { between: () => new Promise((res) => setTimeout(res, 30)) });
    assert.equal(rs.at(-1).exit, EXIT.fresh);
    assert.equal(x.gh.count('dispatch'), 0, 'continued the waiting refresh, no new dispatch');
  });
  test('P8: my run is pending and replaced by a newer dispatch -> completion by server state, exit 0', async (t) => {
    const x = await rig(t);
    x.gh.beforeDispatch = () => { x.gh.beforeDispatch = null; x.world.dispatch(); };   // a run admitted just before mine
    x.world.at.push({ ms: x.clock.now() + 5000, fn: () => x.world.dispatch() });        // a later one replaces my pending
    const rs = await until(x);
    assert.equal(rs.at(-1).exit, EXIT.fresh);
    const mine = x.world.gh.runs.find((r) => r.id === rs[0].runId);
    assert.deepEqual([mine.phase, mine.conclusion], ['completed', 'cancelled']);
    assert.equal(x.gh.count('dispatch'), 1);
  });
  test('P9: main moves during the refresh -> one more dispatch -> exit 0', async (t) => {
    const x = await rig(t);
    x.world.at.push({ ms: x.clock.now() + 70_000, fn: () => x.repos.push(1) });   // after the run's checkout
    const rs = await until(x);
    assert.deepEqual([rs.at(-1).exit, rs.at(-1).message], [EXIT.fresh, MSG.refreshed(3)]);
    assert.equal(x.gh.count('dispatch'), 2);
    assert.equal(loadState(x.statePath), null);
  });
  test('P9: main keeps moving -> exit 1 (main moved), at most 2 dispatches', async (t) => {
    const x = await rig(t);
    x.world.at.push({ ms: x.clock.now() + 70_000, fn: () => x.repos.push(1) });
    x.world.at.push({ ms: x.clock.now() + 4 * M, fn: () => x.repos.push(1) });
    const rs = await until(x);
    assert.deepEqual([rs.at(-1).exit, rs.at(-1).message], [EXIT.failed, MSG.mainMoved]);
    assert.equal(x.gh.count('dispatch'), 2);
  });
});

describe('P12: a lost dispatch reply', () => {
  test('the run was created: no re-send, the run in flight is found and waited for', async (t) => {
    const x = await rig(t);
    x.gh.faults.dispatch = 'drop';
    const rs = await until(x);
    assert.equal(rs.at(-1).exit, EXIT.fresh);
    assert.equal(x.gh.count('dispatch'), 1);
    assert.equal(x.world.dispatches, 1);
  });
  test('nothing was created: no re-send in the same call; one re-send in the next call', async (t) => {
    const x = await rig(t);
    x.gh.faults.dispatch = 'drop-before';
    const r1 = await x.call();
    assert.deepEqual([r1.exit, x.gh.count('dispatch')], [EXIT.running, 1]);
    delete x.gh.faults.dispatch;
    const rs = await until(x);
    assert.equal(rs.at(-1).exit, EXIT.fresh);
    assert.equal(x.gh.count('dispatch'), 2);
  });
  test('the re-send is lost too: no third POST, exit 1 at the deadline', async (t) => {
    const x = await rig(t);
    x.gh.faults.dispatch = 'drop-before';
    const rs = await until(x);
    assert.deepEqual([rs.at(-1).exit, rs.at(-1).message], [EXIT.failed, MSG.deadline]);
    assert.equal(x.gh.count('dispatch'), 2);
  });
  test('a hanging dispatch: the call still ends inside its budget and nothing is re-sent at once', async (t) => {
    const x = await rig(t, { clock: { now: Date.now } });
    x.gh.faults.dispatch = 'hang';
    const t0 = Date.now();
    const r = await x.call({ env: { ...process.env, BRAIN_REFRESH_CALL_S: '2' } });
    assert.ok(Date.now() - t0 < 3500, `took ${Date.now() - t0}`);
    assert.equal(r.exit, EXIT.running);
    assert.equal(x.gh.count('dispatch'), 1);
  });
});

describe('P15: cooldown', () => {
  for (const plan of ['fail-sync', 'fail-before-start']) {
    test(`${plan}: three refreshes -> one dispatch, then exit 1 cooldown; after 15 min it may dispatch again`, async (t) => {
      const x = await rig(t);
      x.world.plans.push(plan);
      const first = await until(x);
      assert.equal(first.at(-1).exit, EXIT.failed);
      assert.equal(first.at(-1).message, MSG.failed(plan === 'fail-sync' ? 'run failed in sync' : 'run failed before start'));
      for (let i = 0; i < 2; i++) {
        const r = await x.call();
        assert.equal(r.exit, EXIT.failed);
        assert.match(r.message, plan === 'fail-sync' ? /^refresh FAILED \(cooldown: last attempt failed \d+[sm] ago in sync; data is stale\)$/
          : /^refresh FAILED \(cooldown: last attempt failed \d+[sm] ago in prepare; data is stale\)$/);
      }
      assert.equal(x.gh.count('dispatch'), 1);
      x.clock.advance(LIM.cooldownMs);
      const again = await x.call();
      assert.equal(again.exit, EXIT.running);
      assert.equal(x.gh.count('dispatch'), 2);
    });
  }
  test('S7 / P10: a run that fails as not-descendant -> the failure and the cooldown give the bootstrap hint (one line)', async (t) => {
    const x = await rig(t);
    x.world.plans.push('fail-not-descendant');
    const first = await until(x);
    assert.equal(first.at(-1).exit, EXIT.failed);
    assert.equal(first.at(-1).message, MSG.failed(`run failed in publish; ${BOOTSTRAP_HINT}`));
    const r = await x.call();
    assert.equal(r.exit, EXIT.failed);
    assert.ok(r.message.startsWith('refresh FAILED (cooldown: last attempt failed '), r.message);
    assert.ok(r.message.endsWith(` ago in publish; data is stale; ${BOOTSTRAP_HINT})`), r.message);
    for (const m of [first.at(-1).message, r.message]) {
      assert.ok(!m.includes('\n') && m.includes('brain-bootstrap.yml') && m.includes('BRAIN_BOOTSTRAP_UNTIL'), m);
    }
    assert.equal(x.gh.count('dispatch'), 1);
  });
  test('a failure on an older main HEAD does not cool down the new HEAD', async (t) => {
    const x = await rig(t);
    x.world.plans.push('fail-sync');
    await until(x);
    x.repos.push(1);
    const r = await x.call();
    assert.equal(r.exit, EXIT.running);
    assert.equal(x.gh.count('dispatch'), 2);
  });
});

describe('P13 / P16: no GitHub, no token, other tokens', () => {
  test('P13: Actions API down -> exit 2 (GitHub not reachable)', async (t) => {
    const x = await rig(t);
    x.gh.faults['*'] = 500;
    assert.deepEqual(await x.call(), { exit: EXIT.unavailable, message: MSG.noGithub, runId: null });
    assert.equal(x.gh.count('dispatch'), 0);
  });
  test('P13: ls-remote down too -> exit 2', async (t) => {
    const x = await rig(t);
    x.gh.faults['*'] = 'drop-before';
    x.repos.setOrigin(join(x.repos.root, 'missing.git'));
    assert.deepEqual(await x.call(), { exit: EXIT.unavailable, message: MSG.noGithub, runId: null });
  });
  test('P16: no BRAIN_DISPATCH_TOKEN -> exit 2; gh never runs; GH_TOKEN / GITHUB_TOKEN never sent', async (t) => {
    const x = await rig(t);
    const bin = stubBin();
    const env = { ...process.env, PATH: `${bin.dir}:${process.env.PATH}`, GH_TOKEN: OTHER_TOKEN, GITHUB_TOKEN: OTHER_TOKEN };
    delete env.BRAIN_DISPATCH_TOKEN;
    const actions = actionsFromEnv(env, { api: x.gh.url });
    assert.equal(actions, null);
    const r = await x.call({ env, actions });
    assert.deepEqual(r, { exit: EXIT.unavailable, message: MSG.noPermission, runId: null });
    assert.equal(existsSync(bin.ghLog), false, 'gh was never executed');
    assert.equal(x.gh.log.length, 0);
  });
  for (const fault of [401, 403, 404]) {
    test(`P16: dispatch ${fault} -> exit 2 (no dispatch permission), state removed, gh never runs`, async (t) => {
      const x = await rig(t);
      const bin = stubBin();
      const env = { ...process.env, PATH: `${bin.dir}:${process.env.PATH}`, GH_TOKEN: OTHER_TOKEN, BRAIN_DISPATCH_TOKEN: FAKE_TOKEN };
      x.gh.faults.dispatch = fault;
      const r = await x.call({ env, actions: actionsFromEnv(env, { api: x.gh.url }) });
      assert.deepEqual(r, { exit: EXIT.unavailable, message: MSG.noPermission, runId: null });
      assert.equal(existsSync(x.statePath), false);
      assert.equal(existsSync(bin.ghLog), false);
      assert.ok(x.gh.log.every((l) => l.auth === 'dispatch-token'), 'only BRAIN_DISPATCH_TOKEN is sent');
    });
  }
  test('F9: BRAIN_DISPATCH_TOKEN gone in a later call -> exit 2, state removed', async (t) => {
    const x = await rig(t);
    const r1 = await x.call();
    assert.equal(r1.exit, EXIT.running);
    assert.deepEqual(await x.call({ actions: null }), { exit: EXIT.unavailable, message: MSG.noPermission, runId: r1.runId });
    assert.equal(existsSync(x.statePath), false);
  });
  test('P16: the token stops working while we wait -> exit 2, state removed', async (t) => {
    const x = await rig(t);
    assert.equal((await x.call()).exit, EXIT.running);
    x.gh.faults['*'] = 401;
    const r = await x.call();
    assert.deepEqual([r.exit, r.message], [EXIT.unavailable, MSG.noPermission]);
    assert.equal(existsSync(x.statePath), false);
  });
  test('P16: a forbidden Actions read at the start -> exit 2 (no dispatch permission)', async (t) => {
    const x = await rig(t);
    x.gh.faults.runs = 403;
    assert.deepEqual(await x.call(), { exit: EXIT.unavailable, message: MSG.noPermission, runId: null });
  });
  test('P16: source check: gh-actions starts no process and reads no token but BRAIN_DISPATCH_TOKEN', () => {
    const src = readFileSync(join(SRC, 'gh-actions.mjs'), 'utf8').replace(/^\s*(\/\/|\*).*$/gm, '');
    assert.doesNotMatch(src, /child_process|execFile|spawn|GH_TOKEN|GITHUB_TOKEN|auth token/);
    assert.deepEqual([...src.matchAll(/env\.(\w+)/g)].map((m) => m[1]), ['BRAIN_DISPATCH_TOKEN']);
    for (const f of ['refresh.mjs', 'pg/status.mjs']) {
      const s = readFileSync(join(SRC, f), 'utf8');
      assert.doesNotMatch(s, /gh-client|GH_TOKEN|GITHUB_TOKEN|'gh'/, f);
    }
    assert.deepEqual([...readFileSync(join(SRC, 'pg/status.mjs'), 'utf8').matchAll(/spawn\('(\w+)'/g)].map((m) => m[1]), ['git']);
  });
  test('422 on dispatch -> exit 1 (dispatch rejected); rate limit -> exit 2', async (t) => {
    let x = await rig(t);
    x.gh.faults.dispatch = 422;
    assert.deepEqual(await x.call(), { exit: EXIT.failed, message: MSG.failed('dispatch rejected'), runId: null });
    x = await rig(t);
    x.gh.faults.dispatch = 429;
    assert.deepEqual(await x.call(), { exit: EXIT.unavailable, message: MSG.noGithub, runId: null });
  });
  test('errors carry no URL, header or token', async () => {
    const gh = createActionsClient({ token: FAKE_TOKEN, api: 'http://127.0.0.1:9' });
    const e = await gh.runs({ opsRepo: 'acme/brain-ops', workflow: 'brain-publish.yml' }, { left: 2000 }).catch((err) => err);
    assert.equal(e.kind, 'network');
    const text = `${e.message} ${e.stack} ${JSON.stringify(e)}`;
    assert.doesNotMatch(text, /127\.0\.0\.1|http:|Bearer|github_pat|acme/);
    assert.throws(() => createActionsClient({ token: FAKE_TOKEN, api: 'http://example.com' }), /must be https/);
    await assert.rejects(gh.dispatch({ opsRepo: '../x', workflow: 'w.yml' }, { left: 1000 }), /bad ops repo/);
    await assert.rejects(gh.dispatch({ opsRepo: 'a/b', workflow: 'w.sh' }, { left: 1000 }), /bad workflow file/);
  });
});

describe('P25: stalled work ends inside the budget, leaving no process or socket', () => {
  const budget = { ...process.env, BRAIN_REFRESH_CALL_S: '2' };
  const settle = () => new Promise((r) => setTimeout(r, 150));
  const sockets = () => process.getActiveResourcesInfo().filter((k) => k === 'TCPSocketWrap').length;

  test('GitHub stub never answers: a new refresh -> exit 2 inside the budget', async (t) => {
    const x = await rig(t, { clock: { now: Date.now } });
    x.gh.faults['*'] = 'hang';
    const t0 = Date.now();
    const r = await x.call({ env: budget });
    assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0}`);
    assert.deepEqual([r.exit, r.message], [EXIT.unavailable, MSG.noGithub]);
    await settle();
    assert.equal(sockets(), 0, process.getActiveResourcesInfo().join(','));
  });
  test('GitHub stops answering while we wait: the call ends inside the budget with exit 2 (could not read it at all)', async (t) => {
    const x = await rig(t, { clock: { now: Date.now }, world: { queueMs: 1e9 } });
    const r1 = await x.call({ env: budget });
    assert.equal(r1.exit, EXIT.running);
    x.gh.faults['*'] = 'hang';
    const t0 = Date.now();
    const r2 = await x.call({ env: budget });
    assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0}`);
    assert.deepEqual([r2.exit, r2.message], [EXIT.unavailable, MSG.noGithub]);
    assert.equal(existsSync(x.statePath), false);
    await settle();
    assert.equal(sockets(), 0);
  });
  test('one Actions list fails at once while the other hangs: the hanging one is cancelled, nothing stays open', async (t) => {
    const x = await rig(t, { clock: { now: Date.now } });
    x.gh.faults.runs = 'hang';
    x.gh.faults['runs-status'] = 403;
    const t0 = Date.now();
    const r = await x.call({ env: { ...process.env, BRAIN_REFRESH_CALL_S: '20' } });
    assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0}`);
    assert.deepEqual([r.exit, r.message], [EXIT.unavailable, MSG.noPermission]);
    await settle();
    assert.equal(sockets(), 0, process.getActiveResourcesInfo().join(','));
  });
  test('the reader hangs: new -> exit 2 (server not reachable), continuing -> 75; the socket is destroyed', async (t) => {
    const x = await rig(t, { clock: { now: Date.now }, world: { queueMs: 1e9 } });
    x.reader.mode = 'hang';
    let t0 = Date.now();
    const r1 = await x.call({ env: budget });
    assert.ok(Date.now() - t0 < 3000);
    assert.deepEqual([r1.exit, r1.message], [EXIT.unavailable, MSG.noServer]);
    assert.ok(x.reader.destroyed >= 1 && x.reader.ended >= 1);
    x.reader.mode = 'ok';
    assert.equal((await x.call({ env: budget })).exit, EXIT.running);
    x.reader.mode = 'hang';
    t0 = Date.now();
    const r3 = await x.call({ env: budget });
    assert.ok(Date.now() - t0 < 3000);
    assert.equal(r3.exit, EXIT.running);
  });
  test('git ls-remote hangs: exit 2 inside the budget, the remote helper is killed', async (t) => {
    const x = await rig(t, { clock: { now: Date.now } });
    const bin = stubBin();
    x.repos.setOrigin('hang::stall');
    const t0 = Date.now();
    const r = await x.call({ env: { ...budget, PATH: `${bin.dir}:${process.env.PATH}` } });
    assert.ok(Date.now() - t0 < 3000);
    assert.deepEqual([r.exit, r.message], [EXIT.unavailable, MSG.noGithub]);
    await settle();
    const pids = readFileSync(bin.pidFile, 'utf8').trim().split('\n').map(Number);
    assert.ok(pids.every((p) => !alive(p)), 'no helper left');
    assert.equal(process.getActiveResourcesInfo().filter((k) => k === 'ProcessWrap').length, 0);
  });
  test('a real pg.Client on a stalled connection: the timer destroys the socket and ends the client (offline)', async (t) => {
    const srv = await stallingPgServer();
    t.after(() => srv.close());
    const client = new pg.Client({ connectionString: srv.url });
    await client.connect();
    const repos = gitRepos();
    const t0 = Date.now();
    const s = await staleness({ reader: client, repoDir: repos.clone, actions: null, deadline: Date.now() + 1000 });
    assert.ok(Date.now() - t0 < 2000);
    assert.deepEqual([s.memory.state, s.detail.db.error], ['unknown', 'timeout']);
    assert.equal(client.connection.stream.destroyed, true);
    await settle();
    assert.equal(srv.sockets.size, 0, 'the server saw the connection close');
    assert.equal(sockets(), 0);
  });
  for (const [name, hang, want] of [['the reader and GitHub', ['db', 'gh'], EXIT.running], ['GitHub only (Actions GETs, 20 s cap)', ['gh'], EXIT.unavailable]]) {
    test(`BRAIN_P3_SLOW: the real 80 s budget, continuing refresh, ${name} hanging`, { skip: process.env.BRAIN_P3_SLOW === '1' ? false : 'set BRAIN_P3_SLOW=1', timeout: 200_000 }, async (t) => {
      const x = await rig(t, { clock: { now: Date.now }, world: { queueMs: 1e9 } });
      assert.equal((await x.call({ env: budget })).exit, EXIT.running);
      if (hang.includes('gh')) x.gh.faults['*'] = 'hang';
      if (hang.includes('db')) x.reader.mode = 'hang';
      const t0 = Date.now();
      const r = await x.call({ env: process.env, pollMs: 10_000 });
      const took = Date.now() - t0;
      assert.equal(r.exit, want);
      assert.ok(took <= 90_000 && took >= 60_000, `took ${took}`);
      await settle();
      assert.equal(sockets(), 0);
    });
  }
});

// ---- Neon (only with BRAIN_P3_READER_URL): F8 against a real server under brain_reader ------------------------------
const READER_URL = process.env.BRAIN_P3_READER_URL;
describe('Neon: the pg deadline under brain_reader', { skip: READER_URL ? false : 'set BRAIN_P3_READER_URL (a throwaway branch with 001/002 + golden seed)' }, () => {
  test('pg_sleep with no server timeout: the client timer cuts it inside the budget', async () => {
    const client = new pg.Client({ connectionString: READER_URL, connectionTimeoutMillis: 15_000, query_timeout: 30_000 });
    await client.connect();
    await client.query('SET statement_timeout = 0');
    const sleeping = { connection: client.connection, end: () => client.end(), query: () => client.query('SELECT pg_sleep(60)') };
    const repos = gitRepos();
    const t0 = Date.now();
    const s = await staleness({ reader: sleeping, repoDir: repos.clone, actions: null, deadline: Date.now() + 3000 });
    assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0}`);
    assert.deepEqual([s.memory.state, s.detail.db.error], ['unknown', 'timeout']);
    assert.equal(client.connection.stream.destroyed, true);
  });
  test('a stalled TCP connection (proxy stops forwarding): the timer destroys the socket', async (t) => {
    const u = new URL(READER_URL);
    const proxy = await stallProxy(u.hostname, Number(u.port || 5432));
    t.after(() => proxy.close());
    const client = new pg.Client({ host: '127.0.0.1', port: proxy.port, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
      database: u.pathname.slice(1), ssl: { servername: u.hostname }, connectionTimeoutMillis: 15_000, query_timeout: 30_000 });
    await client.connect();
    const ok = await staleness({ reader: client, repoDir: gitRepos().clone, actions: null });
    assert.equal(ok.run, 1);
    proxy.stall();
    const t0 = Date.now();
    const s = await staleness({ reader: client, repoDir: gitRepos().clone, actions: null, deadline: Date.now() + 3000 });
    assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0}`);
    assert.deepEqual([s.memory.state, s.detail.db.error], ['unknown', 'timeout']);
    assert.equal(client.connection.stream.destroyed, true);
  });
});

/** A TCP proxy to host:port that can stop forwarding in both directions (the connection stays open, silent). */
async function stallProxy(host, port) {
  const pairs = new Set();
  let stalled = false;
  const server = net.createServer((inSock) => {
    const outSock = net.connect(port, host);
    pairs.add([inSock, outSock]);
    for (const [a, b] of [[inSock, outSock], [outSock, inSock]]) {
      a.on('data', (d) => { if (!stalled) b.write(d); });
      a.on('error', () => {});
      a.on('close', () => b.destroy());
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, stall: () => { stalled = true; },
    close: () => new Promise((r) => { for (const p of pairs) for (const s of p) s.destroy(); server.close(r); }) };
}

/**
 * A child process that holds withWriteLock(statePath) and wrote a state file; resolves once it holds the lock.
 * finishMs: after that long it ends like a refresh that exited 0 (deletes the state file, then releases the lock).
 */
async function holdLock(t, statePath, { runId = null, baseT = null, finishMs = null } = {}) {
  const now = Date.now();
  const st = { v: 1, startedAt: new Date(now).toISOString(), deadline: new Date(now + LIM.deadlineMs).toISOString(), baseT,
    baseHead: 'f'.repeat(40), runId, dispatchedAt: new Date(now).toISOString(), extraDispatches: 0 };
  const code = `
    import { withWriteLock } from ${JSON.stringify(join(SRC, 'gh-schema.mjs'))};
    import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
    import { dirname } from 'node:path';
    const p = ${JSON.stringify(statePath)};
    mkdirSync(dirname(p), { recursive: true });
    await withWriteLock(p, async () => {
      writeFileSync(p, ${JSON.stringify(JSON.stringify(st))}, { mode: 0o600 });
      process.stdout.write('ready\\n');
      const finishMs = ${JSON.stringify(finishMs)};
      if (finishMs === null) await new Promise(() => setInterval(() => {}, 1000));
      await new Promise((resolve) => setTimeout(resolve, finishMs));
      rmSync(p, { force: true });
    });`;
  const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { if (String(d).includes('ready')) resolve(); });
    child.on('exit', () => reject(new Error('lock holder exited')));
  });
  return child;
}
