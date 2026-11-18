// Lane G test doubles, shared by gh-sync.test.mjs and the crash child: a GhClient over in-memory snapshots
// (github.json) and SyncDeps that visibly mark what they touched, so a test can tell sanitized values from raw ones.
import { readFileSync } from 'node:fs';
import { GhError } from '../../../src/errors.mjs';

// fake token shapes, built at runtime: this repo is public and push protection scans for literals
export const SECRET = 'gh' + 'p_' + 'A1b2'.repeat(9);
export const TOKEN = 'tok-' + 'Zx9'.repeat(6);
const SECRET_RE = new RegExp('gh' + 'p_[A-Za-z0-9]{36}', 'g');

/** Snapshot v1 or v2 (= v1 with the v2 objects replacing or adding by id / number). {{SECRET}} -> SECRET. */
export function loadSnapshot(name) {
  const all = JSON.parse(readFileSync(new URL('./github.json', import.meta.url), 'utf8').replaceAll('{{SECRET}}', SECRET));
  const snap = structuredClone(all.v1);
  if (name === 'v1') return snap;
  const patch = all[name], key = (x) => x.id ?? x.number;
  for (const list of ['pulls', 'issues', 'issueComments', 'reviewComments']) {
    for (const x of patch[list] ?? []) {
      const i = snap[list].findIndex((y) => key(y) === key(x));
      if (i >= 0) snap[list][i] = x; else snap[list].push(x);
    }
  }
  Object.assign(snap.reviews, patch.reviews);
  Object.assign(snap.files, patch.files);
  snap.serverDate = patch.serverDate;
  return snap;
}

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * GhClient contract over a snapshot. pageSize stands in for per_page=100. fail: { '<request key>': message } makes that
 * request throw GhError('server', message) (the client's retries are exhausted). Request keys: repo, pulls:<page>,
 * <stream>:<k-th request of that stream>, reviews:<n>, files:<n>.
 */
export function fakeClient(data, { pageSize = 2, fail = {} } = {}) {
  const requests = [], streamCalls = [], yielded = {};
  const hit = (key) => { requests.push(key); if (fail[key]) throw new GhError('server', fail[key]); };
  return {
    owner: 'o', repo: 'r', requests, streamCalls, yielded,
    async getRepo() { hit('repo'); return { id: data.repo.id, fullName: data.repo.full_name, serverDate: data.serverDate }; },
    async *pullsDesc({ stopBefore }) {
      const all = [...data.pulls].sort((a, b) => cmp(b.updated_at, a.updated_at) || b.number - a.number);
      for (let p = 0; p * pageSize < all.length; p++) {
        hit(`pulls:${p + 1}`);
        const page = all.slice(p * pageSize, (p + 1) * pageSize);
        const stop = page.findIndex((x) => stopBefore && x.updated_at < stopBefore);
        if (stop < 0) { yield structuredClone(page); continue; }
        if (stop > 0) yield structuredClone(page.slice(0, stop));
        return;
      }
    },
    // R4 keyset paging; `since` is treated as exclusive (the worst case R4 is built for); R5 drops PRs from issues
    async *streamSince(kind, { since }) {
      const src = { issues: data.issues, 'issue-comments': data.issueComments, 'review-comments': data.reviewComments }[kind];
      const all = [...src].sort((a, b) => cmp(a.updated_at, b.updated_at) || (a.id ?? a.number) - (b.id ?? b.number));
      let S = since, page = 1, k = 0;
      for (;;) {
        streamCalls.push({ kind, since: S, page });
        hit(`${kind}:${++k}`);
        const got = all.filter((x) => !S || x.updated_at > S).slice((page - 1) * pageSize, page * pageSize);
        const out = kind === 'issues' ? got.filter((x) => !x.pull_request) : got;
        (yielded[kind] ??= []).push(out.length);
        yield structuredClone(out);
        if (got.length < pageSize) return;
        const last = iso(Date.parse(got.at(-1).updated_at) - 1000);
        if (!S || last > S) { S = last; page = 1; } else page++;
      }
    },
    async reviews(n) { hit(`reviews:${n}`); return structuredClone(data.reviews[n] ?? []); },
    async files(n) { hit(`files:${n}`); const f = data.files[n]; return { files: structuredClone(f?.files ?? []), truncated: !!f?.truncated }; },
    stats: () => ({ requests: requests.length }),
  };
}

const mask = (s) => {
  let n = 0;
  const text = String(s).replace(SECRET_RE, () => { n++; return '[REDACTED:github-token]'; });
  return { text, n };
};

/** SyncDeps whose output is marked: sanitize -> 'S|…', sanitizeLine -> 'L|…'. calls records extract inputs and relinks. */
export function fakeDeps(over = {}) {
  const calls = { extract: [], relink: [] };
  return {
    calls,
    sanitize: (t) => {
      const m = mask(t);
      return { text: `S|${m.text}`, redactions: m.n, kinds: m.n ? ['github-token'] : [], suspicious: /ignore previous instructions/i.test(m.text) };
    },
    sanitizeLine: (s) => `L|${mask(s).text.replace(/\n/g, ' ')}`,
    extractRefs: (item) => { calls.extract.push(item); return refsOf(item); },
    fileRefs: (files) => files.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean).map((target) => ({ kind: 'file', target, origin: 'pr-files' }))),
    relink: async (opts) => { calls.relink.push(opts); return { linked: 0, ambiguous: 0, unlinked: 0, pending: 0, build: 'fakebld1' }; },
    ...over,
  };
}

/** What the fake extractRefs returns for a stored row (tests compare the refs table with it). */
export function refsOf(item) {
  const refs = [];
  for (const m of String(item.body ?? '').matchAll(/`([^`\n]+)`/g)) if (!m[1].includes('[REDACTED')) refs.push({ kind: 'file', target: m[1], origin: 'text' });
  for (const m of `${item.title ?? ''} ${item.body ?? ''}`.matchAll(/#(\d+)/g)) refs.push({ kind: 'item', target: `#${m[1]}`, origin: 'text' });
  if (item.merge_sha) refs.push({ kind: 'commit', target: item.merge_sha, origin: 'merge-sha' });
  if (item.path) refs.push({ kind: 'file', target: item.path, origin: 'inline' });
  return refs;
}
