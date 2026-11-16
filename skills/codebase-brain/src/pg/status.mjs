// Staleness model (Phase 3 S3): the four cells of docs/phase3-design.md §6.5 and the footer line. Lane B owns this file.
//
// - Server clocks only (P14): memory age = DB now() - GitHub T, attempt ages = DB now() - started_at (DB) or
//   run_started_at (GitHub). `now` (the laptop clock) only measures the time budget of this call.
// - Reads only (F10): one SELECT through the reader, `git ls-remote origin refs/heads/main`, local git objects for
//   ancestry, and Actions GETs. Every one of them is bounded by the time left (F8): the DB query by a client-side timer
//   that destroys the socket, git by a child-process timeout that kills its process group, HTTP inside gh-actions.mjs.
// - reader: { query(sql, params) -> { rows } }. A pg.Client fits; a stub fits. On timeout, a reader with
//   `connection.stream` (pg.Client) gets its socket destroyed and then end() (a server timeout cannot cut a stalled TCP
//   connection).
// - actions: the gh-actions.mjs client or null (no BRAIN_DISPATCH_TOKEN). Without it activity and last come from the
//   DB alone (attemptDisplay with actions 'unknown').
import { spawn } from 'node:child_process';
import { BrainError } from '../errors.mjs';
import {
  MEMORY_FRESH_MS, FOOTER_PHRASES, FRESHNESS_UNKNOWN, ageText, attemptDisplay, REFRESH_LIMITS,
} from './contract.mjs';

/** One statement, one snapshot: DB now, the latest run, its GitHub T, the binding and the recent attempts. */
export const STATUS_SQL = `SELECT floor(extract(epoch FROM now()) * 1000)::float8 AS now_ms,
  (SELECT json_build_object('run', r.run_id, 'commit', r.commit_sha) FROM brain.run r ORDER BY r.run_id DESC LIMIT 1) AS latest,
  (SELECT s.state->'row'->>'cursor' FROM brain.sync_state s WHERE s.source = 'github' ORDER BY s.run_id DESC LIMIT 1) AS github_t,
  (SELECT json_build_object('sourceRepoId', b.source_repo_id, 'opsRepo', b.ops_repo, 'workflow', b.workflow)
     FROM brain.binding b WHERE b.id = 1) AS binding,
  (SELECT coalesce(json_agg(a ORDER BY a."startedMs" DESC), '[]'::json) FROM (
     SELECT gha_run_id AS "ghaRunId", gha_attempt AS "ghaAttempt", source_sha AS "sourceSha", status, stage,
       floor(extract(epoch FROM started_at) * 1000)::float8 AS "startedMs"
     FROM brain.attempt ORDER BY started_at DESC, attempt_id DESC LIMIT 20) a) AS attempts`;

const GIT_MAX_MS = 20_000;
const RECENT_RUNS = 20;
const LOOKUPS_MAX = 3;   // single-run GETs for running DB attempts that are not in the recent list

/**
 * @param {{ reader: { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> }, repoDir: string,
 *   actions?: import('../gh-actions.mjs').ActionsClient | null, now?: () => number, deadline?: number,
 *   env?: Record<string, string|undefined> }} opts  deadline: in now() ms, default now() + REFRESH_LIMITS.callMs
 * @returns {Promise<import('./contract.mjs').Staleness & { detail: Detail }>}
 * @typedef {{ nowMs: number|null, githubT: string|null, binding: { sourceRepoId: number, opsRepo: string, workflow: string }|null,
 *   executions: Execution[], actions: { ok: boolean, error: string|null, runs: object[] }, db: { ok: boolean, error: string|null },
 *   git: { ok: boolean, error: string|null } }} Detail
 * @typedef {{ ghaRunId: number, ghaAttempt: number, shown: string, stage: string|null, sourceSha: string|null,
 *   startedMs: number }} Execution  one Actions attempt, DB and Actions merged (§6.5 table)
 */
export async function staleness({ reader, repoDir, actions = null, now = Date.now, deadline, env = process.env }) {
  const end = deadline ?? now() + REFRESH_LIMITS.callMs;
  const left = () => end - now();
  let [db, head] = await Promise.all([readServer(reader, left), lsRemoteMain(repoDir, left, env)]);

  let gh = { ok: false, error: actions ? 'no-binding' : 'no-token', runs: [] };
  if (actions && db.ok && db.binding) {
    gh = await readActions(actions, db.binding, db.attempts, left);
    // a run that finished between the DB read and the Actions read would look abandoned: read the DB once more
    if (gh.ok && db.attempts.some((a) => a.status === 'running' && isDone(findRun(gh.runs, a)))) {
      const again = await readServer(reader, left);
      if (again.ok) db = again;
    }
  }

  const code = await codeCell(db, head, repoDir, left, env);
  const memory = memoryCell(db);
  const executions = db.ok ? mergeExecutions(db, gh) : [];
  const activity = await activityCell(executions, db, gh, actions, left);
  const last = lastCell(executions, db);
  return {
    code, memory, activity, last, run: db.ok ? db.latest?.run ?? null : null,
    detail: { nowMs: db.ok ? db.nowMs : null, githubT: db.ok ? db.githubT : null, binding: db.ok ? db.binding : null,
      executions, actions: { ok: gh.ok, error: gh.error, runs: gh.runs }, db: { ok: db.ok, error: db.error ?? null },
      git: { ok: head.ok, error: head.error ?? null } },
  };
}

/**
 * The footer line (§6.5), e.g.
 * `brain data: run 42 @9f3c2e1a · 3 commits behind main · github as of 27h ago (stale) · last attempt FAILED 40m ago (sync)`.
 * `(freshness unknown)` appears once when code or memory is unknown, or when an Actions client was given and the Actions
 * API could not be read (activity and last are then the DB's view only, P13).
 * @param {import('./contract.mjs').Staleness} s @returns {string}
 */
export function footerLine(s) {
  const P = FOOTER_PHRASES;
  const head = s.run !== null && s.run !== undefined ? `${P.prefix} run ${s.run}${s.code.runCommit ? ` @${s.code.runCommit.slice(0, 8)}` : ''}`
    : s.memory.state === 'unknown' ? P.prefix : `${P.prefix} ${P.noRun}`;
  const parts = [];
  const add = (t) => { if (t && !(t === FRESHNESS_UNKNOWN && parts.includes(t))) parts.push(t); };
  add(s.code.state === 'behind' ? P.code.behind(s.code.behind) : P.code[s.code.state]);
  const m = P.memory[s.memory.state];
  add(typeof m === 'function' ? m(ageText(s.memory.ageMs ?? 0)) : m);
  const a = P.activity[s.activity.state];
  add(typeof a === 'function' ? a(s.activity.stage ?? null) : a);
  const l = s.last && P.last[s.last.state];
  if (l) add(l(ageText(s.last.agoMs ?? 0), s.last.stage ?? null));
  const gh = s.detail?.actions;
  if (gh && !gh.ok && !['no-token', 'no-binding'].includes(gh.error)) add(FRESHNESS_UNKNOWN);
  return [head, ...parts].join(' · ');
}

// ---- reads ---------------------------------------------------------------------------------------------------------

async function readServer(reader, left) {
  try {
    const res = await withDeadline(reader.query(STATUS_SQL, []), left(), () => destroyReader(reader));
    const row = res?.rows?.[0];
    if (!row || typeof row.now_ms !== 'number') throw new BrainError('status-shape', 'unexpected status row');
    return { ok: true, nowMs: row.now_ms, latest: row.latest ?? null, githubT: row.github_t ?? null,
      binding: row.binding ?? null, attempts: Array.isArray(row.attempts) ? row.attempts : [] };
  } catch (e) {
    return { ok: false, error: e?.code === 'timeout' ? 'timeout' : 'query' };
  }
}

/** F8: a server timeout cannot cut a stalled TCP connection, so destroy the socket, then end the client. */
export function destroyReader(reader) {
  try { reader?.connection?.stream?.destroy(); } catch { /* already gone */ }
  try { Promise.resolve(reader?.end?.()).catch(() => {}); } catch { /* already ended */ }
}

/** Race p against a timer of ms; on timeout run onTimeout and reject with BrainError('timeout'). */
export function withDeadline(p, ms, onTimeout = () => {}) {
  Promise.resolve(p).catch(() => {});   // the loser's rejection is not unhandled
  if (!(ms > 0)) { onTimeout(); return Promise.reject(new BrainError('timeout', 'out of time')); }
  let timer;
  const t = new Promise((_, reject) => { timer = setTimeout(() => { onTimeout(); reject(new BrainError('timeout', 'out of time')); }, ms); });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/**
 * git with a child-process timeout. The child runs in its own process group (detached, so also without a controlling
 * terminal: no password prompt can hang it); on timeout the whole group gets SIGKILL, remote helpers included.
 * @returns {Promise<{ code: number|null, stdout: string, timedOut: boolean }>}
 */
export function runGit(args, { cwd, timeoutMs, env = process.env }) {
  return new Promise((resolve) => {
    if (!(timeoutMs > 0)) { resolve({ code: null, stdout: '', timedOut: true }); return; }
    let child;
    try {
      child = spawn('git', args, { cwd, env: { ...env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    } catch { resolve({ code: null, stdout: '', timedOut: false }); return; }
    let out = '', timedOut = false, settled = false;
    const done = (code) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ code, stdout: out, timedOut }); } };
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
      child.stdout.destroy();
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { if (out.length < 1 << 16) out += d; });
    child.on('error', () => done(null));
    child.on('exit', () => { if (timedOut) done(null); });
    child.on('close', (code) => done(timedOut ? null : code));
  });
}

async function lsRemoteMain(repoDir, left, env) {
  const r = await runGit(['ls-remote', 'origin', 'refs/heads/main'], { cwd: repoDir, timeoutMs: Math.min(left(), GIT_MAX_MS), env });
  const sha = r.code === 0 ? /^([0-9a-f]{40})\trefs\/heads\/main$/m.exec(r.stdout)?.[1] : null;
  return sha ? { ok: true, sha } : { ok: false, error: r.timedOut ? 'timeout' : r.code === 0 ? 'no-main' : 'ls-remote' };
}

async function readActions(actions, binding, attempts, left) {
  try {
    // both GETs settle before we return: when one fails, the other is cancelled, so no socket outlives this call
    const ac = new AbortController();
    let first = null;   // the real failure, not the cancellation it caused
    const both = [actions.runs(binding, { perPage: RECENT_RUNS, left: left(), signal: ac.signal }),
      actions.runs(binding, { status: 'in_progress', perPage: 10, left: left(), signal: ac.signal })]
      .map((p) => p.catch((e) => { first ??= e; ac.abort(); throw e; }));
    const settled = await Promise.allSettled(both);
    if (first) throw first;
    const [recent, inProgress] = settled.map((x) => x.value);
    const runs = [...recent];
    for (const r of inProgress) if (!runs.some((x) => x.id === r.id)) runs.push(r);
    // a running DB attempt whose run is older than the recent list: look it up (bounded)
    const missing = attempts.filter((a) => a.status === 'running' && !runs.some((r) => r.id === a.ghaRunId)).slice(0, LOOKUPS_MAX);
    for (const a of missing) runs.push(await actions.run(binding, a.ghaRunId, { left: left() }));
    return { ok: true, error: null, runs };
  } catch (e) {
    return { ok: false, error: e?.kind ?? 'internal', runs: [] };
  }
}

// ---- cells ---------------------------------------------------------------------------------------------------------

async function codeCell(db, head, repoDir, left, env) {
  const runCommit = db.ok ? db.latest?.commit ?? null : null;
  const mainHead = head.ok ? head.sha : null;
  if (!db.ok || !head.ok) return { state: 'unknown', runCommit, mainHead };
  if (!runCommit) return { state: 'differs', runCommit, mainHead };
  if (runCommit === mainHead) return { state: 'same', behind: 0, runCommit, mainHead };
  // ancestry and N only from local objects: exit 0 ancestor, 1 not, 128 missing object. GIT_NO_LAZY_FETCH: a partial
  // clone must not fetch the missing objects from its promisor remote (git 2.44+)
  const t = () => Math.min(left(), GIT_MAX_MS);
  const local = { ...env, GIT_NO_LAZY_FETCH: '1' };
  const anc = await runGit(['merge-base', '--is-ancestor', runCommit, mainHead], { cwd: repoDir, timeoutMs: t(), env: local });
  if (anc.code === 0) {
    const n = await runGit(['rev-list', '--count', `${runCommit}..${mainHead}`], { cwd: repoDir, timeoutMs: t(), env: local });
    const behind = n.code === 0 ? Number(n.stdout.trim()) : NaN;
    if (Number.isInteger(behind) && behind > 0) return { state: 'behind', behind, runCommit, mainHead };
  }
  return { state: 'differs', runCommit, mainHead };
}

function memoryCell(db) {
  if (!db.ok) return { state: 'unknown', ageMs: null };
  if (!db.githubT) return { state: 'never', ageMs: null };
  const t = Date.parse(db.githubT);
  if (Number.isNaN(t)) return { state: 'unknown', ageMs: null };
  const ageMs = Math.max(0, db.nowMs - t);
  return { state: ageMs < MEMORY_FRESH_MS ? 'fresh' : 'old', ageMs };
}

const QUEUED = new Set(['queued', 'pending', 'waiting', 'requested']);
const FAILED = new Set(['failure', 'timed_out', 'startup_failure', 'action_required', 'stale']);
const isDone = (r) => !!r && r.status === 'completed';
const findRun = (runs, a) => runs.find((r) => r.id === a.ghaRunId) ?? null;

/** Actions run (latest attempt) -> attemptDisplay `actions` for attempt n of that run. */
function actionsState(run, attempt) {
  if (!run) return 'unknown';
  if (attempt < run.runAttempt) return 'completed_failure';   // a re-run exists: this attempt is over
  if (run.status === 'in_progress') return 'in_progress';
  if (QUEUED.has(run.status)) return 'queued';
  if (run.status !== 'completed') return 'unknown';
  if (run.conclusion === 'cancelled') return 'cancelled';
  return FAILED.has(run.conclusion) ? 'completed_failure' : 'completed_success';
}

/**
 * §6.5 table, matched by (run id, run attempt). Actions runs without a DB attempt count only when they are queued /
 * in progress, failed, or cancelled while no newer run exists (a pending run replaced by a newer dispatch is cancelled by
 * the concurrency group: that is not a failure, P8).
 */
function mergeExecutions(db, gh) {
  const out = [];
  for (const a of db.attempts) {
    const run = gh.ok ? findRun(gh.runs, a) : null;
    const shown = attemptDisplay({ db: a.status, actions: gh.ok ? actionsState(run, a.ghaAttempt) : 'unknown', startedAtMs: a.startedMs, nowMs: db.nowMs });
    out.push({ ghaRunId: a.ghaRunId, ghaAttempt: a.ghaAttempt, shown, stage: a.stage ?? null, sourceSha: a.sourceSha, startedMs: a.startedMs });
  }
  for (const r of gh.runs) {
    if (db.attempts.some((a) => a.ghaRunId === r.id && a.ghaAttempt === r.runAttempt)) continue;
    const st = actionsState(r, r.runAttempt);
    if (st === 'completed_success' || st === 'unknown') continue;
    const startedMs = Date.parse(r.runStartedAt ?? r.createdAt);
    if (Number.isNaN(startedMs)) continue;
    // replaced while pending: another run was created after this attempt was queued (a re-run is queued at its
    // run_started_at, not at the run's old created_at)
    if (st === 'cancelled' && gh.runs.some((x) => x.id !== r.id && Date.parse(x.createdAt) > startedMs)) continue;
    out.push({ ghaRunId: r.id, ghaAttempt: r.runAttempt, shown: attemptDisplay({ db: null, actions: st }), stage: null, sourceSha: null, startedMs });
  }
  return out.sort((x, y) => y.startedMs - x.startedMs || y.ghaRunId - x.ghaRunId);
}

async function activityCell(executions, db, gh, actions, left) {
  const running = executions.find((e) => e.shown === 'running' || e.shown === 'running?');
  const queued = executions.find((e) => e.shown === 'queued');
  const e = running ?? queued;
  if (!e) return { state: 'idle', runId: null, stage: null, sinceMs: null };
  let stage = null;
  if (running && gh.ok && actions) {
    try {
      const jobs = await actions.jobs(db.binding, e.ghaRunId, e.ghaAttempt, { left: left() });
      stage = stepLabel(jobs.flatMap((j) => j.steps ?? []).find((s) => s.status === 'in_progress')?.name);
    } catch { /* the stage is a nicety */ }
  }
  return { state: running ? 'running' : 'queued', runId: e.ghaRunId, stage, sinceMs: Math.max(0, db.nowMs - e.startedMs) };
}

/** GitHub step names are display text from the ops repo workflow: keep a short, plain label. */
const stepLabel = (name) => (typeof name === 'string' ? name.replace(/[^\w .:/-]/g, '').trim().slice(0, 40) || null : null);

const END = new Set(['ok', 'skipped', 'failed', 'failed before start', 'abandoned', 'abandoned?', 'outcome unknown']);
function lastCell(executions, db) {
  const e = executions.find((x) => END.has(x.shown));
  if (!e) return null;
  const state = e.shown === 'abandoned?' ? 'abandoned' : e.shown;
  return { state, stage: state === 'failed' ? e.stage : null, agoMs: Math.max(0, db.nowMs - e.startedMs) };
}
