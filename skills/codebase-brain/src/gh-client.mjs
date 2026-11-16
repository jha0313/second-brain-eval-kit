// GitHub REST client. Lane C owns this file.
//
// Contract (design §6.2 R1, R3–R5, §6.3):
// - all methods are async; they return only data from successful responses, or throw GhError (errors.mjs)
// - retries live here: network errors and 5xx retry 3 times with exponential backoff (1s, 2s, 4s via clock.sleep);
//   primary rate limit (x-ratelimit-remaining: 0) waits until x-ratelimit-reset, at most 1 hour, logging the wait;
//   secondary rate limit (403/429 with retry-after or "secondary rate limit" message) waits retry-after seconds,
//   else 60s doubling, 3 times; then GhError('rate-limit')
// - 401 -> GhError('auth'), 403 (not rate limit) -> 'forbidden', 404 -> 'not-found', anything unparsable -> 'protocol'
// - the token never appears in an error, a log line, or a return value; HTTP errors are logged without headers
// - per_page=100 everywhere; Link rel="next" is followed only where the stream is not keyset-paged
// - every request is GET on https://api.github.com under /repos/{owner}/{repo}/ or /repositories/{id}/ (id from getRepo(),
//   the form GitHub's Link headers use); any other host or path, Link or redirect, is GhError('protocol') (R13, plan A14)
//
// EXACT requests (replay fixtures in lanes G, S, I match these query key sets exactly; order does not matter).
// B = /repos/{owner}/{repo}. since = ISO 8601 UTC to the second, "2026-11-15T09:58:00Z" (no milliseconds).
//   getRepo()               GET B                         {}
//   pullsDesc() page 1      GET B/pulls                   { state: all, sort: updated, direction: desc, per_page: 100 }
//   pullsDesc() page n>1    GET <the Link rel="next" URL exactly as GitHub sent it>
//   streamSince('issues')           GET B/issues          { state: all, sort: updated, direction: asc, per_page: 100, since?, page? }
//   streamSince('issue-comments')   GET B/issues/comments { sort: updated, direction: asc, per_page: 100, since?, page? }
//   streamSince('review-comments')  GET B/pulls/comments  { sort: updated, direction: asc, per_page: 100, since?, page? }
//     since: omitted when null (first sync). page: omitted for page 1; present (2, 3, …) only while paging inside a
//     same-second batch (R4). Link headers are ignored on these three streams.
//   reviews(n) page 1       GET B/pulls/{n}/reviews       { per_page: 100 }      then Link rel="next" as sent
//   files(n) page 1         GET B/pulls/{n}/files         { per_page: 100 }      then Link rel="next" as sent, max 30 pages;
//     truncated = 3,000 files came back (GitHub's cap, which may end with no next link) or a next link remains after page 30
// Request headers: Accept: application/vnd.github+json · X-GitHub-Api-Version: 2022-11-28 ·
//   User-Agent: codebase-brain · Authorization: Bearer <token> (only when token is non-null)
//
// Implementation notes:
// - rate-limit waits (primary or secondary) are at most 3 per request; a primary wait is the time to
//   x-ratelimit-reset capped at 1 hour, or the 60s-doubling step when the reset is not in the future (clock skew)
// - a URL is fetched only when it is on api.github.com under B, or under /repositories/<id>/ (the form GitHub uses
//   in Link headers and repo redirects; once getRepo() returned the id, only that id); anything else, Link or
//   redirect, is GhError('protocol') before any request, so the token goes nowhere else. Redirects are followed
//   here (at most 3), not by fetch, so every hop passes that check
// - a body that is not JSON is 'protocol'; a body that breaks off while reading is a network error (retried)
// - error messages and log lines hold only fixed words, endpoint labels and numbers: no URL, header or GitHub text
import { execFileSync } from 'node:child_process';
import { GhError } from './errors.mjs';

/**
 * @typedef {{ method: 'GET', url: string, headers: Record<string, string>, signal?: AbortSignal }} TransportRequest
 * @typedef {{ status: number, headers: { get(name: string): string | null }, json(): Promise<any> }} TransportResponse
 * @typedef {(req: TransportRequest) => Promise<TransportResponse>} Transport
 * @typedef {{ now(): number, sleep(ms: number): Promise<void> }} Clock
 * @typedef {(line: string) => void} Log  one progress line, already safe to print
 */

/** @type {Transport} signal: aborts the request and the body read (per-request timeout, set by the client) */
export const fetchTransport = async ({ method, url, headers, signal }) => {
  const r = await fetch(url, { method, headers, redirect: 'manual', signal });
  return { status: r.status, headers: { get: (n) => r.headers.get(n) }, json: () => r.json() };
};

/** @type {Clock} */
export const realClock = { now: () => Date.now(), sleep: (ms) => new Promise((res) => setTimeout(res, ms)) };

const API = 'https://api.github.com';
const PER_PAGE = 100;
const RETRIES = 3;
const REDIRECTS = 3;
const MAX_FILE_PAGES = 30;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const HTTP_KIND = { 401: ['auth', 'the token was rejected'], 403: ['forbidden', 'the token may not read this'], 404: ['not-found', 'not found or not visible to the token'] };
const STREAMS = {
  issues: { path: 'issues', query: { state: 'all', sort: 'updated', direction: 'asc' } },
  'issue-comments': { path: 'issues/comments', query: { sort: 'updated', direction: 'asc' } },
  'review-comments': { path: 'pulls/comments', query: { sort: 'updated', direction: 'asc' } },
};

const isoSecond = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const qs = (q) => new URLSearchParams({ ...q, per_page: PER_PAGE }).toString();
const nextLink = (res) => /<([^>]+)>\s*;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1] ?? null;
const BAD_JSON = Symbol('bad json');
const readBody = async (res) => {
  try { return await res.json(); } catch (e) { if (e instanceof SyntaxError) return BAD_JSON; throw e; }
};

/**
 * @param {{ owner: string, repo: string, token: string | null, transport?: Transport, clock?: Clock, log?: Log,
 *   requestTimeoutMs?: number, maxRateWaitMs?: number }} opts
 *   requestTimeoutMs: each attempt (request + body) is aborted after this long and counts as a network error (retried
 *   like one). maxRateWaitMs: a rate-limit wait longer than this is not waited for: GhError('rate-limit') at once
 *   (CI runs with a short budget; Phase 3 F5). Defaults: 60 s, 1 hour.
 * @returns {GhClient}
 */
export function createClient({ owner, repo, token, transport = fetchTransport, clock = realClock, log = () => {},
  requestTimeoutMs = 60_000, maxRateWaitMs = HOUR }) {
  const basePath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const base = API + basePath;
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'codebase-brain' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const counters = { requests: 0, retries: 0, waitedMs: 0, rateLimitWaits: 0 };
  let repoId = null;

  const inScope = (url) => {
    const u = URL.parse(url);
    const p = u?.pathname.toLowerCase() ?? '';
    const b = basePath.toLowerCase();
    const byId = /^\/repositories\/(\d+)(\/|$)/.exec(p);
    return u?.origin === API && (p === b || p.startsWith(`${b}/`) || (byId != null && (repoId == null || Number(byId[1]) === repoId)));
  };

  const wait = async (ms, line) => {
    log(line);
    counters.waitedMs += ms;
    await clock.sleep(ms);
  };

  const rateLimited = (res, body) => res.status === 429 || (res.status === 403 && (res.headers.get('retry-after') != null
    || res.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(String(body?.message ?? ''))));

  // GitHub's order: retry-after first, then x-ratelimit-reset when remaining is 0, else at least a minute
  const limitWait = (res, i) => {
    const after = res.headers.get('retry-after');
    if (after != null && Number(after) >= 0) return Number(after) * 1000;
    const untilReset = Number(res.headers.get('x-ratelimit-reset')) * 1000 - clock.now();
    if (res.headers.get('x-ratelimit-remaining') === '0' && untilReset > 0) return Math.min(untilReset, HOUR);
    return MINUTE * 2 ** i;
  };

  async function get(url, label) {
    if (!inScope(url)) throw new GhError('protocol', `GitHub ${label}: refused a URL outside this repository`);
    for (let fails = 0, limits = 0, redirects = 0; ;) {
      counters.requests++;
      let res = null, body;
      try {
        res = await transport({ method: 'GET', url, headers, signal: AbortSignal.timeout(requestTimeoutMs) });
        body = await readBody(res);
      } catch { res = null; /* the transport's message may hold anything: dropped */ }
      if (res && res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        const to = location && URL.parse(location, url)?.href;
        if (!to || !inScope(to) || redirects++ === REDIRECTS) {
          throw new GhError('protocol', `GitHub ${label}: refused a redirect (HTTP ${res.status})`, { status: res.status });
        }
        url = to;
        continue;
      }
      if (!res || res.status >= 500) {
        const what = res ? `HTTP ${res.status}` : 'network error';
        if (fails === RETRIES) throw new GhError(res ? 'server' : 'network', `GitHub ${label}: ${what} after ${RETRIES} retries`, { status: res?.status ?? null });
        const ms = 1000 * 2 ** fails++;
        counters.retries++;
        await wait(ms, `github ${label}: ${what}, retry ${fails}/${RETRIES} in ${ms / 1000}s`);
        continue;
      }
      if (res.status >= 200 && res.status < 300) {
        if (body === BAD_JSON) throw new GhError('protocol', `GitHub ${label}: HTTP ${res.status} without a JSON body`, { status: res.status });
        return { body, res };
      }
      if (rateLimited(res, body)) {
        const retryAfter = res.headers.get('retry-after') == null ? null : Number(res.headers.get('retry-after'));
        if (limits === RETRIES) throw new GhError('rate-limit', `GitHub ${label}: still rate limited after ${RETRIES} waits`, { status: res.status, retryAfter });
        const ms = limitWait(res, limits++);
        if (ms > maxRateWaitMs) {
          throw new GhError('rate-limit', `GitHub ${label}: rate limited, the wait of ${Math.ceil(ms / 1000)}s is over the ${Math.ceil(maxRateWaitMs / 1000)}s limit`,
            { status: res.status, retryAfter });
        }
        counters.rateLimitWaits++;
        await wait(ms, `github ${label}: rate limited (HTTP ${res.status}), waiting ${Math.ceil(ms / 1000)}s (${limits}/${RETRIES})`);
        continue;
      }
      const [kind, hint] = HTTP_KIND[res.status] ?? ['protocol', 'unexpected status'];
      throw new GhError(kind, `GitHub ${label}: HTTP ${res.status}, ${hint}`, { status: res.status });
    }
  }

  async function list(url, label) {
    const { body, res } = await get(url, label);
    if (!Array.isArray(body)) throw new GhError('protocol', `GitHub ${label}: expected a list`, { status: res.status });
    return { items: body, next: nextLink(res) };
  }

  return {
    owner, repo,
    /** @returns {Promise<{ id: number, fullName: string, serverDate: string }>} serverDate: ISO from this response's Date header */
    async getRepo() {
      const { body, res } = await get(base, 'repo');
      const date = Date.parse(res.headers.get('date') ?? '');
      if (!Number.isSafeInteger(body?.id) || typeof body.full_name !== 'string' || Number.isNaN(date)) {
        throw new GhError('protocol', 'GitHub repo: missing id, full_name or Date header', { status: res.status });
      }
      repoId = body.id;
      return { id: body.id, fullName: body.full_name, serverDate: isoSecond(date) };
    },
    /**
     * PR list, state=all sort=updated direction=desc. Yields pages (arrays of raw PR objects) and stops after the page
     * holding the first PR with updated_at < stopBefore; that PR and later ones are not yielded. stopBefore null = all.
     * @param {{ stopBefore: string | null }} opts @returns {AsyncIterable<object[]>}
     */
    async *pullsDesc({ stopBefore } = {}) {
      const stop = stopBefore == null ? null : Date.parse(stopBefore);
      for (let url = `${base}/pulls?${qs({ state: 'all', sort: 'updated', direction: 'desc' })}`; url;) {
        const { items, next } = await list(url, 'pulls');
        const cut = stop == null ? -1 : items.findIndex((p) => Date.parse(p.updated_at) < stop);
        const page = cut < 0 ? items : items.slice(0, cut);
        if (page.length) yield page;
        url = cut < 0 ? next : null;
      }
    },
    /**
     * Keyset stream sort=updated direction=asc since=S (R4). kind: 'issues' (state=all; items with pull_request are
     * dropped, R5) | 'issue-comments' | 'review-comments'. Yields pages; ids may repeat across pages (caller dedupes).
     * @param {'issues'|'issue-comments'|'review-comments'} kind @param {{ since: string | null }} opts
     * @returns {AsyncIterable<object[]>}
     */
    async *streamSince(kind, { since } = {}) {
      const s = STREAMS[kind];
      if (!s) throw new TypeError(`unknown stream: ${kind}`);
      let S = since == null ? null : isoSecond(Date.parse(since));
      for (let page = 1; ;) {
        const { items } = await list(`${base}/${s.path}?${qs({ ...s.query, ...(S && { since: S }), ...(page > 1 && { page }) })}`, kind);
        const keep = kind === 'issues' ? items.filter((it) => !it.pull_request) : items;
        if (keep.length) yield keep;
        if (items.length < PER_PAGE) return;
        // progress: S = last item's second − 1 s, from page 1. A full page that all sits in S's second: same S, next page
        const last = Date.parse(items.at(-1).updated_at) - 1000;
        if (Number.isNaN(last)) throw new GhError('protocol', `GitHub ${kind}: item without updated_at`);
        if (S == null || last > Date.parse(S)) { S = isoSecond(last); page = 1; } else page++;
      }
    },
    /** @param {number} number @returns {Promise<object[]>} every review of the PR (all pages) */
    async reviews(number) {
      const out = [];
      for (let url = `${base}/pulls/${number}/reviews?${qs({})}`; url;) {
        const { items, next } = await list(url, `pulls/${number}/reviews`);
        out.push(...items);
        url = next;
      }
      return out;
    },
    /**
     * At most 30 pages (3,000 files, GitHub's cap). truncated: a next page remains after 30, or 3,000 files came back
     * (GitHub stops there without a next link).
     * @param {number} number @returns {Promise<{ files: { filename: string, previous_filename?: string, status: string }[], truncated: boolean }>}
     */
    async files(number) {
      const files = [];
      let url = `${base}/pulls/${number}/files?${qs({})}`;
      for (let page = 0; url && page < MAX_FILE_PAGES; page++) {
        const { items, next } = await list(url, `pulls/${number}/files`);
        for (const f of items) {
          files.push(f.previous_filename ? { filename: f.filename, previous_filename: f.previous_filename, status: f.status } : { filename: f.filename, status: f.status });
        }
        url = next;
      }
      return { files, truncated: url != null || files.length >= MAX_FILE_PAGES * PER_PAGE };
    },
    /** @returns {{ requests: number, retries: number, waitedMs: number, rateLimitWaits: number }} counters for the sync report */
    stats: () => ({ ...counters }),
  };
}

/** @typedef {ReturnType<typeof createClient>} GhClient */

/**
 * Token lookup: GH_TOKEN, then GITHUB_TOKEN, then `gh auth token` (only when allowGh). null when none.
 * gh runs without a shell, with this env, stderr captured, and for github.com only (never another gh host's token).
 * @param {Record<string, string | undefined>} env @param {{ allowGh?: boolean }} [opts]
 * @returns {string | null}
 */
export function readToken(env, { allowGh = true } = {}) {
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    const v = env[name]?.trim();
    if (v) return v;
  }
  if (!allowGh) return null;
  try {
    const out = execFileSync('gh', ['auth', 'token', '--hostname', 'github.com'],
      { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 });
    return out.trim() || null;
  } catch {
    return null;
  }
}
