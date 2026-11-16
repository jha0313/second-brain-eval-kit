// Replay transport + virtual clock (P0, implemented). Tests and the CLI seam BRAIN_REPLAY_DIR use it so that
// `brain sync` runs end to end with recorded GitHub responses and no network.
//
// Fixture directory format:
//   manifest.json  { "now": "2026-11-15T10:00:00Z",              // virtual clock start (optional)
//                    "routes": [ { "path": "/repos/o/r/pulls",     // URL pathname, no host
//                                  "query": { "state": "all", "page": "2" },   // every query param must match exactly
//                                  "responses": [ { "status": 200, "headers": { "date": "Sun, 15 Nov 2026 10:00:00 GMT" },
//                                                   "body": [...] }               // inline JSON
//                                               | { "status": 200, "bodyFile": "pulls-2.json" } ] } ] }
//   Each call to a route takes the next response; the last one repeats. An unmatched request gets 404
//   { "message": "replay: no route" } and is listed in transport.unmatched.
//   requests.log  written here: one line per request, "METHOD <full URL>" (+ " unmatched"); headers are never written,
//                 so black-box tests can check the host and path of every request without seeing the token.
import { readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const sameQuery = (a, b) => {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => String(a[k]) === String(b[k]));
};

/** @param {string} dir @returns {import('./gh-client.mjs').Transport & { requests: string[], unmatched: string[] }} */
export function replayTransport(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const routes = (manifest.routes || []).map((r) => ({ ...r, query: r.query || {}, used: 0 }));
  const requests = [], unmatched = [];
  const transport = async ({ method, url }) => {
    const u = new URL(url);
    const query = Object.fromEntries(u.searchParams);
    const key = `${method} ${u.pathname}${u.search}`;
    requests.push(key);
    const route = routes.find((r) => r.path === u.pathname && sameQuery(r.query, query));
    appendFileSync(join(dir, 'requests.log'), `${method} ${url}${route ? '' : ' unmatched'}\n`, { mode: 0o600 });
    if (!route) {
      unmatched.push(key);
      return { status: 404, headers: { get: () => null }, json: async () => ({ message: 'replay: no route' }) };
    }
    const res = route.responses[Math.min(route.used++, route.responses.length - 1)];
    const headers = Object.fromEntries(Object.entries(res.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const body = res.bodyFile ? JSON.parse(readFileSync(join(dir, res.bodyFile), 'utf8')) : res.body;
    return { status: res.status ?? 200, headers: { get: (n) => headers[n.toLowerCase()] ?? null }, json: async () => body };
  };
  return Object.assign(transport, { requests, unmatched, now: manifest.now || null });
}

/** sleep() advances virtual time instantly. @returns {import('./gh-client.mjs').Clock & { advance(ms: number): void, slept: number[] }} */
export function virtualClock(startIso) {
  let t = startIso ? Date.parse(startIso) : Date.parse('2026-01-01T00:00:00Z');
  const slept = [];
  return { now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; }, advance: (ms) => { t += ms; }, slept };
}
