// brain refresh (Phase 3 S4): docs/phase3-design.md §6.6 F1–F11. Lane B owns this file.
//
// One call: lock the state file -> read the server, main HEAD and Actions (status.mjs) -> decide -> maybe dispatch ->
// poll until the three completion conditions hold, the call budget (80 s) ends, or the deadline (15 min from the first
// call, never extended) passes. Exit codes and lines come only from contract REFRESH_EXIT / REFRESH_MESSAGES.
// - Never writes to the brain DB (F10): status.mjs runs one SELECT through the reader.
// - Completion is server state (F6, F7): latest run commit = main HEAD re-read now, GitHub T > T at the start (or T
//   appears), DB now() - T < 24 h. Which Actions run published does not matter.
// - Clocks: `now` (laptop) measures the call budget and the deadline only; staleness, memory age and cooldown use DB
//   now() (P14).
// - State file (F11, contract RefreshState v 1, mode 0600) written by rename under withWriteLock(<file>); created when
//   this call dispatches or decides to wait for a run in flight, continued while it exists and the deadline has not
//   passed (with or without --wait), deleted on exit 0 / 1 / 2. A held lock: no dispatch, exit 75.
// - extraDispatches (max 1) covers both the one re-send after a lost dispatch reply (F5, only in a later call) and the
//   one re-dispatch after main moved (F7): at most two dispatches per refresh.
import { readFileSync, writeFileSync, renameSync, rmSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { withWriteLock } from './gh-schema.mjs';
import { LockBusyError } from './errors.mjs';
import { staleness } from './pg/status.mjs';
import {
  REFRESH_EXIT as EXIT, REFRESH_LIMITS as LIM, REFRESH_MESSAGES as MSG, REFRESH_STATE_VERSION, needsRefresh, ageText,
} from './pg/contract.mjs';

const POLL_MS = 10_000;
const LOOK_RESERVE_MS = 5_000;   // time kept for the last look of a call
const NO_PERMISSION = new Set(['auth', 'forbidden', 'not-found']);
const noServer = MSG.noServer ?? MSG.noGithub;   // contract request pending: REFRESH_MESSAGES.noServer
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{ wait?: boolean, now?: () => number, statePath: string, reader: { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> },
 *   actions: import('./gh-actions.mjs').ActionsClient | null, repoDir: string, env?: Record<string, string|undefined>,
 *   sleep?: (ms: number) => Promise<void>, pollMs?: number }} opts
 *   wait: --wait. F11 continues an existing state file with or without it and starts a new refresh without a file, so
 *   it changes nothing here. env: BRAIN_REFRESH_CALL_S (may only shorten the 80 s call) and the env of git.
 *   sleep / pollMs: test seams.
 * @returns {Promise<{ exit: 0|1|2|75, message: string, runId: number|null }>}
 *   runId: the brain run on exit 0, otherwise the Actions run being waited for (null when unknown)
 */
export async function refresh({ wait: _wait = false, now = Date.now, statePath, reader, actions, repoDir, env = process.env,
  sleep = realSleep, pollMs = POLL_MS }) {
  const callEnd = now() + callBudget(env);
  const o = { now, statePath, reader, actions, repoDir, env, sleep, pollMs, callEnd };
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
  try {
    return (await withWriteLock(statePath, () => locked(o))).value;
  } catch (e) {
    if (!(e instanceof LockBusyError)) throw e;
    // another refresh on this machine holds the lock: read its state only, never dispatch (F2, F11)
    const st = loadState(statePath, { remove: false });
    return { exit: EXIT.running, message: MSG.running(st?.runId ?? null, ageText(st ? now() - Date.parse(st.startedAt) : 0), null), runId: st?.runId ?? null };
  }
}

function callBudget(env) {
  const s = Number(env.BRAIN_REFRESH_CALL_S);
  return Number.isFinite(s) && s > 0 ? Math.min(LIM.callMs, s * 1000) : LIM.callMs;
}

async function locked(o) {
  let st = loadState(o.statePath);
  if (st && o.now() >= Date.parse(st.deadline)) return finish(o, EXIT.failed, MSG.deadline, null);
  const end = () => Math.min(o.callEnd, st ? Date.parse(st.deadline) : Infinity);
  let s = await look(o, st, end());
  let dispatchedNow = false;

  if (!st) {
    // a new refresh (F1, F3, F9)
    if (!s.detail.db.ok) return finish(o, EXIT.unavailable, noServer, null);
    if (s.code.state === 'unknown') return finish(o, EXIT.unavailable, MSG.noGithub, null);
    if (!needsRefresh(s)) return finish(o, EXIT.fresh, MSG.fresh, s.run);
    if (!o.actions) return finish(o, EXIT.unavailable, MSG.noPermission, null);
    if (!s.detail.binding) return finish(o, EXIT.failed, MSG.failed('the brain server has no binding yet'), null);
    if (!s.detail.actions.ok) return finish(o, EXIT.unavailable, NO_PERMISSION.has(s.detail.actions.error) ? MSG.noPermission : MSG.noGithub, null);
    const inFlight = s.activity.state !== 'idle';
    if (!inFlight) {
      const cd = cooldown(s);
      if (cd) return finish(o, EXIT.failed, MSG.cooldown(ageText(cd.agoMs), cd.stage), null);
    }
    const t0 = o.now();
    st = { v: REFRESH_STATE_VERSION, startedAt: iso(t0), deadline: iso(t0 + LIM.deadlineMs), baseT: s.detail.githubT,
      baseHead: s.code.mainHead, runId: inFlight ? s.activity.runId : null, dispatchedAt: null, extraDispatches: 0 };
    saveState(o.statePath, st);
    if (!inFlight) {
      const r = await dispatch(o, s, st);
      if (r) return r;
      dispatchedNow = true;
    }
  }

  for (;;) {
    if (complete(s, st)) return finish(o, EXIT.fresh, MSG.refreshed(s.run), s.run);
    if (NO_PERMISSION.has(s.detail.actions.error)) return finish(o, EXIT.unavailable, MSG.noPermission, st.runId);   // token revoked
    if (st.runId === null && s.activity.runId !== null) {
      // a run in flight after a lost dispatch reply: wait for it (F5); any run that publishes counts (F6)
      st.runId = s.activity.runId;
      saveState(o.statePath, st);
    }
    if (s.detail.db.ok && s.code.state !== 'unknown' && !inFlightNow(s, st)) {
      // nothing will change by itself: a failure, main moved, or a lost dispatch
      const advanced = tAdvanced(s, st);
      if (advanced && s.memory.state === 'fresh') {
        // (2) and (3) hold, (1) does not: main moved after the run's checkout (F7, P9)
        if (st.extraDispatches >= LIM.extraDispatchMax) return finish(o, EXIT.failed, MSG.mainMoved, st.runId);
        st.extraDispatches += 1;
        const r = await dispatch(o, s, st);
        if (r) return r;
        dispatchedNow = true;
      } else if (st.runId !== null) {
        const f = failureSince(s, st);
        if (f) return finish(o, EXIT.failed, MSG.failed(f), st.runId);
        return finish(o, EXIT.failed, MSG.failed('the run ended without publishing'), st.runId);
      } else if (st.dispatchedAt !== null && !dispatchedNow && st.extraDispatches < LIM.extraDispatchMax) {
        // F5: the earlier reply was lost and no run is in flight: send once more (never in the call that lost it)
        st.extraDispatches += 1;
        const r = await dispatch(o, s, st);
        if (r) return r;
        dispatchedNow = true;
      }
    }
    if (o.now() >= Date.parse(st.deadline) - LOOK_RESERVE_MS) {
      return finish(o, EXIT.failed, tAdvanced(s, st) && s.code.state !== 'same' ? MSG.mainMoved : MSG.deadline, st.runId);
    }
    const left = end() - o.now();
    if (left <= LOOK_RESERVE_MS) break;
    await o.sleep(Math.min(o.pollMs, left - LOOK_RESERVE_MS));
    s = await look(o, st, end());
  }
  return { exit: EXIT.running, message: MSG.running(st.runId, ageText(o.now() - Date.parse(st.startedAt)), s.activity.stage ?? null), runId: st.runId };
}

/** staleness() plus the state of the run this refresh waits for, when it is not in the lists. */
async function look(o, st, end) {
  const s = await staleness({ reader: o.reader, repoDir: o.repoDir, actions: o.actions, now: o.now, deadline: end, env: o.env });
  s.mine = null;
  if (st?.runId && o.actions && s.detail.actions.ok && s.detail.binding) {
    s.mine = s.detail.actions.runs.find((r) => r.id === st.runId) ?? null;
    if (!s.mine) {
      try { s.mine = await o.actions.run(s.detail.binding, st.runId, { left: end - o.now() }); } catch { s.mine = 'unknown'; }
    }
  }
  return s;
}

/** F7: (1) latest run commit = main HEAD read now, (2) T moved past the start's T (or appeared), (3) T younger than 24 h. */
const complete = (s, st) => s.detail.db.ok && s.code.state === 'same' && tAdvanced(s, st) && s.memory.state === 'fresh';
function tAdvanced(s, st) {
  const t = s.detail.githubT;
  if (!s.detail.db.ok || !t) return false;
  return st.baseT === null || Date.parse(t) > Date.parse(st.baseT);
}

/**
 * Something may still publish: a run queued or running, our run not completed or not looked at yet (dispatched after
 * this look), or Actions not readable.
 */
function inFlightNow(s, st) {
  if (s.activity.state !== 'idle' || !s.detail.actions.ok) return true;
  return st.runId !== null && (s.mine === null || s.mine === 'unknown' || s.mine.status !== 'completed');
}

/** The most recent failure of this refresh's runs (Actions run ids grow: ours and any later one). */
function failureSince(s, st) {
  const e = s.detail.executions.find((x) => x.ghaRunId >= st.runId && ['failed', 'failed before start', 'abandoned', 'abandoned?', 'outcome unknown'].includes(x.shown));
  if (!e) return null;
  if (e.shown === 'failed') return `run failed${e.stage ? ` in ${e.stage}` : ''}`;
  if (e.shown === 'failed before start') return 'run failed before start';
  if (e.shown === 'outcome unknown') return 'run outcome unknown';
  return 'run abandoned';
}

/**
 * F3: within 15 min (DB clock, by attempt start), an attempt failed or abandoned on the same main HEAD, or a run failed
 * before start (no source commit: it counts whatever the HEAD).
 */
function cooldown(s) {
  const now = s.detail.nowMs;
  for (const e of s.detail.executions) {
    if (now - e.startedMs >= LIM.cooldownMs) continue;
    if (e.shown === 'failed before start') return { agoMs: now - e.startedMs, stage: 'prepare' };
    if ((e.shown === 'failed' || e.shown === 'abandoned' || e.shown === 'abandoned?') && e.sourceSha === s.code.mainHead) {
      return { agoMs: now - e.startedMs, stage: e.shown === 'failed' ? e.stage : null };
    }
  }
  return null;
}

/**
 * F4/F5: the state file says "dispatched, no run id yet" before the POST, so a reply lost here (or a crash) is never
 * followed by a second POST in the same call. 401/403/404: exit 2. 422 / rate limit: the request was refused.
 * @returns {Promise<null | { exit, message, runId }>} null: carry on waiting
 */
async function dispatch(o, s, st) {
  st.dispatchedAt = iso(o.now());
  st.runId = null;
  saveState(o.statePath, st);
  try {
    const r = await o.actions.dispatch(s.detail.binding, { left: Math.min(o.callEnd, Date.parse(st.deadline)) - o.now() });
    st.runId = r.runId;
    saveState(o.statePath, st);
    return null;
  } catch (e) {
    if (NO_PERMISSION.has(e?.kind)) return finish(o, EXIT.unavailable, MSG.noPermission, null);
    if (e?.kind === 'rate-limit') return finish(o, EXIT.unavailable, MSG.noGithub, null);
    if (e?.kind === 'rejected') return finish(o, EXIT.failed, MSG.failed('dispatch rejected'), null);
    return null;   // no reply, timeout, 5xx: it may have been created (F5)
  }
}

function finish(o, exit, message, runId) {
  if (exit === EXIT.fresh || exit === EXIT.failed || exit === EXIT.unavailable) rmSync(o.statePath, { force: true });
  return { exit, message, runId: runId ?? null };
}

const iso = (ms) => new Date(ms).toISOString();

/**
 * @param {string} path @param {{ remove?: boolean }} [o] remove: delete a bad file (only while holding the lock)
 * @returns {import('./pg/contract.mjs').RefreshState | null} null when missing or not a v 1 state
 */
export function loadState(path, { remove = true } = {}) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch { return null; }
  try {
    const st = JSON.parse(raw);
    const isoOk = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
    const idOk = (v) => v === null || (Number.isSafeInteger(v) && v > 0);
    if (st && st.v === REFRESH_STATE_VERSION && isoOk(st.startedAt) && isoOk(st.deadline) && (st.baseT === null || isoOk(st.baseT)) &&
      /^[0-9a-f]{40}$/.test(st.baseHead ?? '') && idOk(st.runId) && (st.dispatchedAt === null || isoOk(st.dispatchedAt)) &&
      Number.isInteger(st.extraDispatches) && st.extraDispatches >= 0 && st.extraDispatches <= LIM.extraDispatchMax) return st;
  } catch { /* not JSON */ }
  if (remove) rmSync(path, { force: true });
  return null;
}

function saveState(path, st) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(st), { mode: 0o600 });
  renameSync(tmp, path);
}
