// Phase 3 lane B test stubs: git repos, a simulated "world" (brain DB + Actions + CI), a stub reader, an in-process
// Actions client, and a GitHub stub HTTP server with faults (drop the reply, hang, 401/403/404/422/500, down).
// No network beyond 127.0.0.1. Fake tokens are built by concatenation.
import http from 'node:http';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const FAKE_TOKEN = 'github_' + 'pat_' + '11TESTONLY' + '0'.repeat(12) + '_' + 'q'.repeat(59);
export const OTHER_TOKEN = 'gh' + 'o_' + 'w'.repeat(36);
export const BINDING = Object.freeze({ sourceRepoId: 4242, opsRepo: 'acme/brain-ops', workflow: '.github/workflows/brain-publish.yml' });
export const H = 3600_000, M = 60_000;
export const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

// ---- git -----------------------------------------------------------------------------------------------------------

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args],
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A bare origin with main, a work clone that pushes, and the user's clone (repoDir) that fetches only when asked. */
export function gitRepos() {
  const root = mkdtempSync(join(tmpdir(), 'brain-p3-git-'));
  const origin = join(root, 'origin.git'), work = join(root, 'work'), clone = join(root, 'clone');
  git(root, 'init', '-q', '--bare', origin);
  git(root, 'clone', '-q', origin, work);
  let n = 0;
  const commit = (branch = 'main') => {
    n += 1;
    writeFileSync(join(work, 'f.txt'), `change ${n}\n`);
    git(work, 'add', 'f.txt');
    git(work, 'commit', '-q', '-m', `change ${n}`);
    git(work, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`);
    return git(work, 'rev-parse', 'HEAD');
  };
  commit();
  git(root, 'clone', '-q', origin, clone);
  return {
    root, origin, clone,
    head: () => git(origin, 'rev-parse', 'refs/heads/main'),
    /** n commits on main, pushed. The clone does not see them until fetch(). */
    push: (count = 1) => { let sha; for (let i = 0; i < count; i++) sha = commit(); return sha; },
    fetch: () => git(clone, 'fetch', '-q', 'origin'),
    /** a commit that is not on main (a side branch), fetched into the clone */
    sideCommit: () => {
      git(work, 'checkout', '-q', '-b', `side${n}`, 'HEAD~0');
      git(work, 'reset', '-q', '--hard', 'HEAD');
      writeFileSync(join(work, 'side.txt'), `side ${n}\n`);
      git(work, 'add', 'side.txt');
      git(work, 'commit', '-q', '-m', 'side');
      const sha = git(work, 'rev-parse', 'HEAD');
      git(work, 'push', '-q', 'origin', `HEAD:refs/heads/side${n}`);
      git(work, 'checkout', '-q', 'main');
      git(clone, 'fetch', '-q', 'origin');
      return sha;
    },
    setOrigin: (url) => git(clone, 'remote', 'set-url', 'origin', url),
  };
}

/**
 * A dir with a `git-remote-hang` helper (git runs it for `hang::<x>` remotes) that writes its pid and sleeps, and a
 * `gh` that logs every call. Put it first on PATH.
 */
export function stubBin() {
  const dir = mkdtempSync(join(tmpdir(), 'brain-p3-bin-'));
  const pidFile = join(dir, 'hang.pid'), ghLog = join(dir, 'gh.log');
  writeFileSync(join(dir, 'git-remote-hang'), `#!/bin/sh\necho $$ >> "${pidFile}"\nexec sleep 600\n`);
  writeFileSync(join(dir, 'gh'), `#!/bin/sh\necho "gh $*" >> "${ghLog}"\necho ${OTHER_TOKEN}\n`);
  chmodSync(join(dir, 'git-remote-hang'), 0o755);
  chmodSync(join(dir, 'gh'), 0o755);
  return { dir, pidFile, ghLog };
}

export const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// ---- world: brain DB + Actions + CI ----------------------------------------------------------------------------------

/**
 * clock: { now() } shared with the code under test (a fake clock, or Date). Server clocks: DB = clock + dbSkewMs,
 * GitHub = clock + ghSkewMs. Laptop clocks are what tests pass to refresh / staleness as `now`.
 * CI per Actions run: pending (behind another run, a newer dispatch cancels it) -> queued (queueMs) -> in progress:
 * prepMs then the attempt is recorded (A5 skip, or 'fail-before-start') -> runMs then publish / fail.
 * plans: outcome of each new run in order ('ok' default, 'fail-sync', 'fail-not-descendant', 'fail-before-start',
 *   'abandon', 'hold').
 */
export function createWorld({ clock, repos, dbSkewMs = 0, ghSkewMs = 0, queueMs = 20_000, prepMs = 30_000, runMs = 120_000 } = {}) {
  const w = {
    clock, repos, plans: [], at: [],
    db: { runs: [], sync: [], attempts: [], binding: { ...BINDING } },
    gh: { runs: [] },
    nextRun: 91_000_000, nextAttempt: 1, dispatches: 0, publishes: 0, skips: 0,
    dbNow: () => clock.now() + dbSkewMs,
    ghNow: () => clock.now() + ghSkewMs,
  };

  /** a run that is already published: T = GitHub time tAgoMs ago (null: no github sync_state) */
  w.seedRun = ({ commit, tAgoMs = H }) => {
    const attemptId = w.nextAttempt++;
    w.db.attempts.push({ attemptId, ghaRunId: w.nextRun++, ghaAttempt: 1, sourceSha: commit, status: 'ok', stage: null, startedMs: w.dbNow() - (tAgoMs ?? H) });
    const runId = w.db.runs.length + 1;
    w.db.runs.push({ runId, commit, attemptId });
    if (tAgoMs !== null) w.db.sync.push({ runId, t: iso(w.ghNow() - tAgoMs) });
    return runId;
  };
  w.addAttempt = (a) => { const row = { attemptId: w.nextAttempt++, ghaAttempt: 1, stage: null, sourceSha: repos?.head() ?? 'a'.repeat(40), ...a }; w.db.attempts.push(row); return row; };
  w.addActionsRun = (r) => { const row = { id: w.nextRun++, runAttempt: 1, phase: 'completed', conclusion: 'failure', createdMs: w.clock.now(), startedMs: w.clock.now(), plan: 'ok', ...r }; w.gh.runs.push(row); return row; };

  w.dispatch = () => {
    w.tick();
    const c = clock.now();
    const busy = w.gh.runs.some((r) => ['queued', 'starting', 'running'].includes(r.phase));
    for (const r of w.gh.runs) if (r.phase === 'pending') Object.assign(r, { phase: 'completed', conclusion: 'cancelled', doneMs: c });
    const run = { id: w.nextRun++, runAttempt: 1, createdMs: c, startedMs: null, plan: w.plans.shift() ?? 'ok', phase: busy ? 'pending' : 'queued', startAt: busy ? null : c + queueMs };
    w.gh.runs.push(run);
    w.dispatches += 1;
    return run.id;
  };

  const latest = () => w.db.runs.at(-1) ?? null;
  const latestT = () => { const r = latest(); return r ? w.db.sync.findLast((s) => s.runId <= r.runId)?.t ?? null : null; };

  function events() {
    const ev = [];
    for (const r of w.gh.runs) {
      if (r.phase === 'queued') ev.push([r.startAt, () => Object.assign(r, { phase: 'starting', startedMs: r.startAt, recordAt: r.startAt + prepMs })]);
      if (r.phase === 'starting') ev.push([r.recordAt, () => record(r)]);
      if (r.phase === 'running') ev.push([r.finishAt, () => finish(r)]);
    }
    for (const a of w.at) if (!a.done) ev.push([a.ms, () => { a.done = true; a.fn(); }]);
    return ev;
  }
  function record(r) {
    const t = r.recordAt;
    if (r.plan === 'fail-before-start') return complete(r, 'failure', t);
    const source = repos.head();
    const l = latest(), lt = latestT();
    // A5 with GitHub's second-resolution times on both sides (Date header, created_at)
    if (r.runAttempt === 1 && l && l.commit === source && lt && Date.parse(lt) >= Date.parse(iso(r.createdMs + ghSkewMs))) {
      w.db.attempts.push({ attemptId: w.nextAttempt++, ghaRunId: r.id, ghaAttempt: r.runAttempt, sourceSha: source, status: 'skipped', stage: null, startedMs: t + dbSkewMs });
      w.skips += 1;
      return complete(r, 'success', t);
    }
    r.attempt = { attemptId: w.nextAttempt++, ghaRunId: r.id, ghaAttempt: r.runAttempt, sourceSha: source, status: 'running', stage: null, startedMs: t + dbSkewMs };
    w.db.attempts.push(r.attempt);
    Object.assign(r, { phase: 'running', source, syncT: t + ghSkewMs, finishAt: r.plan === 'hold' ? Infinity : t + runMs });
  }
  function finish(r) {
    const t = r.finishAt;
    if (r.plan === 'ok') {
      const runId = w.db.runs.length + 1;
      w.db.runs.push({ runId, commit: r.source, attemptId: r.attempt.attemptId });
      w.db.sync.push({ runId, t: iso(r.syncT) });
      r.attempt.status = 'ok';
      w.publishes += 1;
      return complete(r, 'success', t);
    }
    if (r.plan === 'fail-sync') { Object.assign(r.attempt, { status: 'failed', stage: 'sync', error: 'sync:exit' }); return complete(r, 'failure', t); }
    if (r.plan === 'fail-not-descendant') {   // P10: a normal publish on a rewritten main
      Object.assign(r.attempt, { status: 'failed', stage: 'publish', error: 'publish:not-descendant' });
      return complete(r, 'failure', t);
    }
    return complete(r, 'cancelled', t);   // abandon: the job was killed, the attempt stays running
  }
  function complete(r, conclusion, t) {
    Object.assign(r, { phase: 'completed', conclusion, doneMs: t });
    const next = w.gh.runs.find((x) => x.phase === 'pending');
    if (next) Object.assign(next, { phase: 'queued', startAt: t + queueMs });
  }

  /** apply every event due by now, in time order */
  w.tick = () => {
    for (let guard = 0; guard < 10_000; guard++) {
      const due = events().filter(([ms]) => ms <= clock.now()).sort((a, b) => a[0] - b[0]);
      if (!due.length) return;
      due[0][1]();
    }
    throw new Error('world: event loop did not settle');
  };

  w.statusRow = () => {
    w.tick();
    const l = latest();
    return {
      now_ms: w.dbNow(),
      latest: l ? { run: l.runId, commit: l.commit } : null,
      github_t: latestT(),
      binding: w.db.binding ? { ...w.db.binding } : null,
      attempts: [...w.db.attempts].sort((a, b) => b.startedMs - a.startedMs || b.attemptId - a.attemptId).slice(0, 20)
        .map(({ ghaRunId, ghaAttempt, sourceSha, status, stage, error, startedMs }) => ({ ghaRunId, ghaAttempt, sourceSha, status, stage, error: error ?? null, startedMs })),
    };
  };

  /** GitHub REST shape of one run */
  w.runJson = (r) => ({
    id: r.id, run_attempt: r.runAttempt, name: 'brain-publish', event: 'workflow_dispatch',
    status: r.phase === 'pending' ? 'pending' : r.phase === 'queued' ? 'queued' : r.phase === 'completed' ? 'completed' : 'in_progress',
    conclusion: r.phase === 'completed' ? r.conclusion : null,
    created_at: iso(r.createdMs + ghSkewMs), run_started_at: iso((r.startedMs ?? r.createdMs) + ghSkewMs),
  });
  w.listRuns = ({ status, perPage = 30 } = {}) => {
    w.tick();
    return [...w.gh.runs].sort((a, b) => b.id - a.id).map(w.runJson).filter((r) => !status || r.status === status).slice(0, perPage);
  };
  w.jobsJson = (id) => {
    w.tick();
    const r = w.gh.runs.find((x) => x.id === id);
    if (!r) return null;
    const step = r.phase === 'starting' ? 'Run actions/checkout' : r.phase === 'running' ? 'brain ci-publish (build)' : null;
    return { total_count: 1, jobs: [{ status: w.runJson(r).status, steps: step ? [{ name: 'Set up job', status: 'completed' }, { name: step, status: 'in_progress' }] : [] }] };
  };
  return w;
}

/**
 * Stub reader over the world. mode: 'ok' | 'fail' | 'hang'. Asserts every statement is a read (F10).
 * A hanging reader has `connection.stream.destroy` and `end` like pg.Client, and records that they were called.
 */
export function stubReader(world, { mode = 'ok' } = {}) {
  const reader = {
    mode, sql: [], destroyed: 0, ended: 0, order: [],
    connection: { stream: { destroy: () => { reader.destroyed += 1; reader.order.push('destroy'); } } },
    end: async () => { reader.ended += 1; reader.order.push('end'); },
    async query(sql, params = []) {
      reader.sql.push(sql);
      if (!/^\s*(SELECT|WITH)\b/i.test(sql) || /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP|GRANT|COPY|LOCK)\b/i.test(sql)) {
        throw new Error('stub reader: not a read-only statement');
      }
      if (params.length) throw new Error('stub reader: unexpected params');
      if (reader.mode === 'hang') return new Promise(() => {});
      if (reader.mode === 'fail') throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
      return { rows: [world.statusRow()] };
    },
  };
  return reader;
}

/** ActionsClient (gh-actions.mjs shape) straight over the world, for status tests that need no HTTP. */
export function worldActions(world, { fail = null } = {}) {
  const shape = (r) => ({ id: r.id, runAttempt: r.run_attempt, status: r.status, conclusion: r.conclusion, createdAt: r.created_at, runStartedAt: r.run_started_at });
  const guard = () => { if (fail) throw Object.assign(new Error(`stub ${fail}`), { kind: fail }); };
  return {
    calls: 0,
    async dispatch() { guard(); this.calls++; return { runId: world.dispatch() }; },
    async runs(_b, { status, perPage }) { guard(); this.calls++; return world.listRuns({ status, perPage }).map(shape); },
    async run(_b, id) { guard(); this.calls++; const r = world.listRuns({ perPage: 1e9 }).find((x) => x.id === id); if (!r) throw Object.assign(new Error('nf'), { kind: 'not-found' }); return shape(r); },
    async jobs(_b, id) { guard(); this.calls++; return world.jobsJson(id).jobs; },
  };
}

// ---- GitHub stub HTTP server ---------------------------------------------------------------------------------------

/**
 * faults: { [route]: mode } with route 'dispatch' | 'runs' | 'runs-status' (runs?status=…) | 'run' | 'jobs' | '*' and mode
 *   'drop'        dispatch: create the run, then destroy the socket without a reply; GET: destroy without a reply
 *   'drop-before' destroy the socket and do nothing
 *   'hang'        never reply
 *   401 | 403 | 404 | 422 | 500
 * log: { method, path, auth: 'dispatch-token' | 'other-token' | 'unknown' | 'none', body } per request (no header values
 * kept). beforeDispatch: called before a dispatch is applied (another dispatcher racing us).
 */
export async function githubStub(world, { token = FAKE_TOKEN } = {}) {
  const stub = { faults: {}, log: [], hung: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const h = req.headers.authorization;
      const auth = h === `Bearer ${token}` ? 'dispatch-token' : h === `Bearer ${OTHER_TOKEN}` ? 'other-token' : h ? 'unknown' : 'none';
      stub.log.push({ method: req.method, path: url.pathname, query: url.search, auth, body: body || null });
      const route = routeOf(req.method, url.pathname, url.searchParams);
      const fault = stub.faults[route] ?? stub.faults['*'];
      const send = (status, json) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(json === undefined ? '' : JSON.stringify(json)); };
      if (fault === 'hang') { stub.hung.push(res); return; }
      if (fault === 'drop-before') { req.socket.destroy(); return; }
      if (typeof fault === 'number') { send(fault, { message: 'stub fault' }); return; }
      if (auth !== 'dispatch-token') { send(401, { message: 'Bad credentials' }); return; }
      const base = `/repos/${world.db.binding.opsRepo}/actions`;
      const wf = `${base}/workflows/brain-publish.yml`;
      let out;
      if (req.method === 'POST' && url.pathname === `${wf}/dispatches`) {
        if (body !== JSON.stringify({ ref: 'main', return_run_details: true })) { send(422, { message: 'bad body' }); return; }
        stub.beforeDispatch?.();
        const id = world.dispatch();
        out = [200, { workflow_run_id: id, run_url: `http://x/runs/${id}`, html_url: `http://x/run/${id}` }];
      } else if (req.method === 'GET' && url.pathname === `${wf}/runs`) {
        const runs = world.listRuns({ status: url.searchParams.get('status'), perPage: Number(url.searchParams.get('per_page') ?? 30) });
        out = [200, { total_count: runs.length, workflow_runs: runs }];
      } else if (req.method === 'GET' && /\/actions\/runs\/\d+$/.test(url.pathname) && url.pathname.startsWith(base)) {
        const r = world.listRuns({ perPage: 1e9 }).find((x) => x.id === Number(url.pathname.split('/').pop()));
        out = r ? [200, r] : [404, { message: 'Not Found' }];
      } else if (req.method === 'GET' && /\/actions\/runs\/\d+\/attempts\/\d+\/jobs$/.test(url.pathname) && url.pathname.startsWith(base)) {
        const j = world.jobsJson(Number(url.pathname.split('/')[6]));
        out = j ? [200, j] : [404, { message: 'Not Found' }];
      } else out = [404, { message: 'Not Found' }];
      if (fault === 'drop') { req.socket.destroy(); return; }
      send(...out);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  stub.url = `http://127.0.0.1:${server.address().port}`;
  stub.count = (route) => stub.log.filter((l) => routeOf(l.method, l.path, new URLSearchParams(l.query)) === route).length;
  stub.close = () => new Promise((r) => { for (const h of stub.hung) h.destroy?.(); server.closeAllConnections(); server.close(r); });
  return stub;
}

function routeOf(method, path, query) {
  if (method === 'POST') return 'dispatch';
  if (path.endsWith('/runs')) return query?.has('status') ? 'runs-status' : 'runs';
  if (path.endsWith('/jobs')) return 'jobs';
  return 'run';
}

/**
 * A fake clock: sleep advances time and lets the world move. Real elapsed time is added too, so the time spent in HTTP,
 * git and the reader counts against a call's budget like it would on a laptop.
 */
export function fakeClock(start = Date.parse('2026-11-16T09:00:00Z')) {
  const r0 = Date.now();
  const c = { t: start, slept: 0, now: () => c.t + (Date.now() - r0), sleep: async (ms) => { c.t += ms; c.slept += ms; }, advance: (ms) => { c.t += ms; } };
  return c;
}

export const tempDir = (p = 'brain-p3-') => { const d = mkdtempSync(join(tmpdir(), p)); mkdirSync(d, { recursive: true }); return d; };

/**
 * A Postgres server that answers the startup (AuthenticationOk, ReadyForQuery) and then never replies again: a stalled
 * connection for a real pg.Client, offline. sockets: the server-side sockets, to check they get closed.
 */
export async function stallingPgServer() {
  const sockets = new Set();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
    let started = false;
    sock.on('data', () => {
      if (started) return;   // swallow every query
      started = true;
      const auth = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0]);   // 'R' AuthenticationOk
      const ready = Buffer.from([0x5a, 0, 0, 0, 5, 0x49]);        // 'Z' ReadyForQuery idle
      sock.write(Buffer.concat([auth, ready]));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `postgres://stall:x@127.0.0.1:${server.address().port}/none`, port: server.address().port, sockets,
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(r); }),
  };
}
