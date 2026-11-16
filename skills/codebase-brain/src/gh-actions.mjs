// GitHub Actions client for brain refresh (Phase 3 S4, docs/phase3-design.md §6.6 F4–F9). Lane B owns this file.
//
// - Calls only the ops repo's Actions API. The one POST is
//     POST /repos/{ops}/actions/workflows/{file}/dispatches   {"ref":"main","return_run_details":true}
//   and the GETs are
//     GET /repos/{ops}/actions/workflows/{file}/runs?per_page=n[&status=s]
//     GET /repos/{ops}/actions/runs/{id}
//     GET /repos/{ops}/actions/runs/{id}/attempts/{n}/jobs?per_page=10
//   {ops} and {file} come from brain.binding (ops_repo, workflow; a path keeps its file name).
// - The token is BRAIN_DISPATCH_TOKEN and nothing else: never `gh auth token`, GH_TOKEN or GITHUB_TOKEN (F9, P16).
//   This file starts no child process.
// - Every call gets AbortSignal.timeout(min(left, 20 s)) (F8). No retries here: refresh polls again within its budget,
//   and a dispatch whose reply is lost is never re-sent by the client (F5).
// - One socket per request (agent: false), closed with the response, so nothing stays open after a call (P25).
// - Errors are GhError with a fixed message: endpoint label, HTTP status or failure kind. No URL, header or token.
//   kinds: auth (401) · forbidden (403) · not-found (404) · rejected (422) · rate-limit · server (5xx) ·
//   network (no reply, reply cut off) · timeout · protocol (unexpected status or body)
import http from 'node:http';
import https from 'node:https';
import { GhError } from './errors.mjs';
import { REFRESH_LIMITS } from './pg/contract.mjs';

const API = 'https://api.github.com';
const MAX_BODY = 1 << 20;
const OPS_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const FILE_RE = /^[A-Za-z0-9._-]+\.ya?ml$/;

/**
 * @typedef {{ opsRepo: string, workflow: string }} Binding  brain.binding ops_repo, workflow
 * @typedef {{ id: number, runAttempt: number, status: string, conclusion: string|null, createdAt: string,
 *   runStartedAt: string|null }} ActionsRun
 * @typedef {{
 *   dispatch(b: Binding, o: { left: number }): Promise<{ runId: number|null }>,
 *   runs(b: Binding, o: { status?: string, perPage?: number, left: number }): Promise<ActionsRun[]>,
 *   run(b: Binding, id: number, o: { left: number }): Promise<ActionsRun>,
 *   jobs(b: Binding, id: number, attempt: number, o: { left: number }): Promise<{ status: string, steps: { name: string, status: string }[] }[]>
 * }} ActionsClient
 */

/** The client for BRAIN_DISPATCH_TOKEN, or null when it is not set. Reads no other variable. */
export function actionsFromEnv(env = process.env, opts = {}) {
  const token = env.BRAIN_DISPATCH_TOKEN;
  return token ? createActionsClient({ ...opts, token }) : null;
}

/**
 * @param {{ token: string, api?: string }} opts  api: tests only; plain http only on a loopback host
 * @returns {ActionsClient}
 */
export function createActionsClient({ token, api = API }) {
  if (typeof token !== 'string' || !token) throw new GhError('auth', 'no dispatch token');
  const base = new URL(api);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))) {
    throw new GhError('protocol', 'the Actions API must be https');
  }
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'codebase-brain',
    Authorization: `Bearer ${token}` };

  async function call(label, method, path, { left, body = null }) {
    const ms = Math.min(left, REFRESH_LIMITS.httpMaxMs);
    if (!(ms > 0)) throw new GhError('timeout', `${label}: out of time`);
    const signal = AbortSignal.timeout(ms);
    let res;
    try {
      res = await request(new URL(base.pathname.replace(/\/$/, '') + path, base), {
        method, signal, body: body === null ? null : JSON.stringify(body),
        headers: body === null ? headers : { ...headers, 'Content-Type': 'application/json' } });
    } catch {
      throw signal.aborted ? new GhError('timeout', `${label}: timed out`) : new GhError('network', `${label}: no reply`);
    }
    const { status } = res;
    if (status === 401) throw new GhError('auth', `${label}: HTTP 401`, { status });
    if (status === 429 || (status === 403 && (res.headers['x-ratelimit-remaining'] === '0' || res.headers['retry-after']))) {
      throw new GhError('rate-limit', `${label}: rate limited`, { status });
    }
    if (status === 403) throw new GhError('forbidden', `${label}: HTTP 403`, { status });
    if (status === 404) throw new GhError('not-found', `${label}: HTTP 404`, { status });
    if (status === 422) throw new GhError('rejected', `${label}: HTTP 422`, { status });
    if (status >= 500) throw new GhError('server', `${label}: HTTP ${status}`, { status });
    if (status === 204 && method === 'POST') return null;
    if (status !== 200) throw new GhError('protocol', `${label}: HTTP ${status}`, { status });
    try { return JSON.parse(res.body); } catch { throw new GhError('protocol', `${label}: body is not JSON`, { status }); }
  }

  return {
    async dispatch(b, { left }) {
      const body = await call('dispatch', 'POST', `${workflowPath(b)}/dispatches`, { left, body: { ref: 'main', return_run_details: true } });
      const id = body?.workflow_run_id;
      return { runId: Number.isSafeInteger(id) && id > 0 ? id : null };
    },
    async runs(b, { status, perPage = 20, left }) {
      const q = new URLSearchParams({ per_page: String(perPage), ...(status ? { status } : {}) });
      const body = await call('runs', 'GET', `${workflowPath(b)}/runs?${q}`, { left });
      if (!Array.isArray(body?.workflow_runs)) throw new GhError('protocol', 'runs: unexpected body');
      return body.workflow_runs.map(shapeRun);
    },
    async run(b, id, { left }) {
      return shapeRun(await call('run', 'GET', `${repoPath(b)}/actions/runs/${runNumber(id)}`, { left }));
    },
    async jobs(b, id, attempt, { left }) {
      const body = await call('jobs', 'GET', `${repoPath(b)}/actions/runs/${runNumber(id)}/attempts/${runNumber(attempt)}/jobs?per_page=10`, { left });
      if (!Array.isArray(body?.jobs)) throw new GhError('protocol', 'jobs: unexpected body');
      return body.jobs.map((j) => ({ status: String(j.status), steps: Array.isArray(j.steps) ? j.steps.map((s) => ({ name: String(s.name), status: String(s.status) })) : [] }));
    },
  };
}

function repoPath(b) {
  if (!OPS_RE.test(b?.opsRepo ?? '')) throw new GhError('protocol', 'binding: bad ops repo');
  return `/repos/${b.opsRepo}`;
}
function workflowPath(b) {
  const file = String(b?.workflow ?? '').split('/').pop();
  if (!FILE_RE.test(file)) throw new GhError('protocol', 'binding: bad workflow file');
  return `${repoPath(b)}/actions/workflows/${file}`;
}
function runNumber(n) {
  if (!Number.isSafeInteger(n) || n <= 0) throw new GhError('protocol', 'bad run id');
  return n;
}
function shapeRun(r) {
  if (!r || !Number.isSafeInteger(r.id) || typeof r.status !== 'string') throw new GhError('protocol', 'run: unexpected body');
  return { id: r.id, runAttempt: Number.isSafeInteger(r.run_attempt) ? r.run_attempt : 1, status: r.status,
    conclusion: r.conclusion ?? null, createdAt: String(r.created_at), runStartedAt: r.run_started_at ?? null };
}

/** One request on its own socket. Rejects on network failure, a cut-off reply, a body over 1 MB, or the signal. */
function request(url, { method, headers, body, signal }) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    let settled = false;
    const settle = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    const req = mod.request(url, { method, headers: body === null ? headers : { ...headers, 'Content-Length': Buffer.byteLength(body) },
      agent: false, signal }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) req.destroy(new Error('body too large')); else chunks.push(c);
      });
      res.on('end', () => settle(resolve, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (e) => settle(reject, e));
      res.on('close', () => settle(reject, new Error('reply cut off')));
    });
    req.on('error', (e) => settle(reject, e));
    req.end(body ?? undefined);
  });
}
