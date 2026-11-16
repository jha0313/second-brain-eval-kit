// GitHub REST client. Lane C owns this file. P0: contract + transport/clock defaults; methods are stubs.
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
// - every request is GET under https://api.github.com/repos/{owner}/{repo}; nothing else is fetched (R13)
import { NotImplementedError } from './errors.mjs';

/**
 * @typedef {{ method: 'GET', url: string, headers: Record<string, string> }} TransportRequest
 * @typedef {{ status: number, headers: { get(name: string): string | null }, json(): Promise<any> }} TransportResponse
 * @typedef {(req: TransportRequest) => Promise<TransportResponse>} Transport
 * @typedef {{ now(): number, sleep(ms: number): Promise<void> }} Clock
 * @typedef {(line: string) => void} Log  one progress line, already safe to print
 */

/** @type {Transport} */
export const fetchTransport = async ({ method, url, headers }) => {
  const r = await fetch(url, { method, headers });
  return { status: r.status, headers: { get: (n) => r.headers.get(n) }, json: () => r.json() };
};

/** @type {Clock} */
export const realClock = { now: () => Date.now(), sleep: (ms) => new Promise((res) => setTimeout(res, ms)) };

/**
 * @param {{ owner: string, repo: string, token: string | null, transport?: Transport, clock?: Clock, log?: Log }} opts
 * @returns {GhClient}
 */
export function createClient({ owner, repo, token, transport = fetchTransport, clock = realClock, log = () => {} }) {
  const todo = (name) => () => { throw new NotImplementedError(`gh-client.${name}`); };
  return {
    owner, repo,
    /** @returns {Promise<{ id: number, fullName: string, serverDate: string }>} serverDate: ISO from this response's Date header */
    getRepo: todo('getRepo'),
    /**
     * PR list, state=all sort=updated direction=desc. Yields pages (arrays of raw PR objects) and stops after the page
     * holding the first PR with updated_at < stopBefore; that PR and later ones are not yielded. stopBefore null = all.
     * @param {{ stopBefore: string | null }} opts @returns {AsyncIterable<object[]>}
     */
    pullsDesc: todo('pullsDesc'),
    /**
     * Keyset stream sort=updated direction=asc since=S (R4). kind: 'issues' (state=all; items with pull_request are
     * dropped, R5) | 'issue-comments' | 'review-comments'. Yields pages; ids may repeat across pages (caller dedupes).
     * @param {'issues'|'issue-comments'|'review-comments'} kind @param {{ since: string | null }} opts
     * @returns {AsyncIterable<object[]>}
     */
    streamSince: todo('streamSince'),
    /** @param {number} number @returns {Promise<object[]>} every review of the PR (all pages) */
    reviews: todo('reviews'),
    /** @param {number} number @returns {Promise<{ files: { filename: string, previous_filename?: string, status: string }[], truncated: boolean }>} */
    files: todo('files'),
    /** @returns {{ requests: number }} counters for the sync report */
    stats: () => ({ requests: 0 }),
  };
}

/** @typedef {ReturnType<typeof createClient>} GhClient */

/**
 * Token lookup: GH_TOKEN, then GITHUB_TOKEN, then `gh auth token` (only when allowGh). null when none.
 * @param {Record<string, string | undefined>} env @param {{ allowGh?: boolean }} [opts]
 * @returns {string | null}
 */
export function readToken(env, { allowGh = true } = {}) {
  throw new NotImplementedError('gh-client.readToken');
}
