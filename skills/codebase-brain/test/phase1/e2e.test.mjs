// End to end (plan §5.2 S1–S10): bin/brain build, sync, relink and the read commands, through the replay seam and
// the real GitHub client, with recorded responses in the exact request shapes of src/gh-client.mjs. Three runs:
//   base: the first sync (server Date T1); run 2: incremental (T2, since = T1 − 1 h); run 3: incremental (T3).
// After every failure (plan §5.2): the cursor is unchanged, items = items_fts = items_tri (same text), every item is
// whole in either the state before the run or the state after a run that finished in one go (its row with its text
// refs, its files step with its pr-files refs), and last_error holds no token.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { SANITIZE_VERSION } from '../../src/sanitize.mjs';
import { githubDbPath } from '../../src/gh-schema.mjs';
import {
  BASE, REPO_ID, PULLS_Q, STREAMS, WINDOW, TOKEN_ENV, pr, issue, prAsIssue, issueComment, reviewComment, review, file, repoJson,
  setupRepo, cli, sync, parseJson, resetGithub, storeFiles, replayRequests,
} from '../security/lib.mjs';

const API = 'https://api.github.com', RB = `/repositories/${REPO_ID}`;
const t = (h, m = 0) => `2026-11-15T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;
const T1 = t(10), T2 = t(12), T3 = t(14);

// ------------------------------------------------------------------------------------------------------- data

const P = {
  107: pr({ number: 107, state: 'open', title: 'Cap the reserve retries', body: 'Retries reserve() at most three times.', head: 'feat/cap-retries', updated: t(9, 30) }),
  101: pr({ number: 101, state: 'open', title: 'Reserve credits before the run', head: 'feat/reserve-first', updated: '2026-10-05T10:00:00Z',
    body: 'Calls reserve() in src/lib/credits.ts before charge; throws InsufficientCredits when the balance is short.' }),
  102: pr({ number: 102, state: 'merged', title: 'Charge after the run', body: 'Follows #101. See docs/credits.md.', head: 'fix/charge-after', updated: '2026-10-03T10:00:00Z' }),
  103: pr({ number: 103, state: 'closed', title: 'Settle at the end', body: 'Rejected: settle() lost credits on a crash.', head: 'try/settle-end', author: 'carol', updated: '2026-10-01T10:00:00Z' }),
  104: pr({ number: 104, state: 'merged', title: 'Document the credit flow', body: 'docs/credits.md explains reserve then charge.', head: 'docs/credits', updated: '2026-09-20T10:00:00Z' }),
};
const P2 = {
  105: pr({ number: 105, state: 'open', title: 'Refund on InsufficientCredits', head: 'feat/refund', updated: t(11, 30),
    body: 'Refunds the reservation when reserve() throws InsufficientCredits. Follows #101.' }),
  101: { ...P[101], title: 'Reserve credits before the run (v2)', body: `${P[101].body} v2 also covers src/lib/charge.ts.`, updated_at: t(11, 20) },
};
const I201 = issue({ number: 201, state: 'open', title: 'Credits go negative under load', body: 'reserve() races with charge(); see src/lib/charge.ts', updated: '2026-10-06T10:00:00Z' });
const I202 = issue({ number: 202, state: 'closed', title: 'Meter shows stale balance', body: 'Fixed by #102.', updated: '2026-10-07T10:00:00Z' });
const rv9001 = review({ id: 9001, number: 101, state: 'CHANGES_REQUESTED', body: 'Check the InsufficientCredits path.' });
const rv9004 = review({ id: 9004, number: 105, state: 'APPROVED', body: 'Refund looks right.', submitted: t(11, 45) });
const rc7003 = reviewComment({ id: 7003, number: 105, review: 9004, path: 'src/lib/credits.ts', body: 'Refund only once.', updated: t(11, 40) });
// 30 pages of one file each, and page 30 still links to a page 31: the files step stops there, truncated
const truncatedFiles = { pages: Array.from({ length: 30 }, (_, i) => [file({ filename: `src/gen/part-${i + 1}.ts` })]), more: true };

const BASE_RUN = {
  date: T1, prPages: [[P[107], P[101], P[102]], [P[103], P[104]]],
  issues: [I201, I202, prAsIssue(P[101])],
  issueComments: [issueComment({ id: 8001, number: 201, body: 'Repro: two runs at once.', updated: '2026-10-08T10:00:00Z' }),
    issueComment({ id: 8002, number: 101, body: 'Ship it after the refund PR.', updated: '2026-10-09T10:00:00Z' })],
  reviewComments: [reviewComment({ id: 7001, number: 101, review: 9001, path: 'src/lib/credits.ts', body: 'reserve() must run first.', updated: '2026-10-04T11:00:00Z' }),
    reviewComment({ id: 7002, number: 101, review: 9001, path: 'src/lib/credits.ts', body: 'Done.', replyTo: 7001, updated: '2026-10-04T12:00:00Z' })],
  reviews: { 101: [rv9001], 102: [review({ id: 9002, number: 102, state: 'APPROVED', body: 'LGTM.' })], 103: [], 104: [],
    107: [review({ id: 9003, number: 107, state: 'COMMENTED', body: 'Three is fine.' })] },
  files: { 101: [file({ filename: 'src/lib/credits.ts', status: 'modified' })], 102: [file({ filename: 'src/lib/charge.ts', status: 'modified' })],
    103: [file({ filename: 'src/lib/charge.ts', status: 'modified' })], 104: [file({ filename: 'docs/credits.md', status: 'modified' })], 107: truncatedFiles },
};
// pulls page 2 holds PR 107 again with the same updated_at (the 1 h overlap, S6) and then 102, older than W: the stop
const RUN2 = {
  date: T2, since: WINDOW, prPages: [[P2[105], P2[101]], [P[107], P[102]]],
  issues: [{ ...I201, title: 'Credits go negative under load (confirmed)', updated_at: t(10, 20) }, prAsIssue(P2[105])],
  issueComments: [issueComment({ id: 8003, number: 103, body: 'Reopening the settle idea? No: see #101.', updated: t(10, 30) })],
  reviewComments: [rc7003],
  reviews: { 101: [{ ...rv9001, state: 'DISMISSED' }], 103: [], 105: [rv9004], 107: BASE_RUN.reviews[107] },
  files: { 101: [file({ filename: 'src/lib/credits.ts', status: 'modified' }), file({ filename: 'src/lib/charge.ts', status: 'modified' })],
    105: [file({ filename: 'src/lib/credits.ts', status: 'modified' }), file({ filename: 'src/lib/index.ts', status: 'modified' })] },
};
// S6: PR 105 again unchanged, PR 101 from a stale replica (older updated_at), review comment 7003 edited (newer)
const RUN3 = {
  date: T3, since: t(11), prPages: [[P2[105], { ...P2[101], title: 'Reserve credits (stale replica)', updated_at: t(11, 10) }, P[102]]],
  issues: [prAsIssue(P2[105])], issueComments: [],
  reviewComments: [{ ...rc7003, body: 'Refund only once, and log it.', updated_at: t(13) }],
  reviews: { 101: RUN2.reviews[101], 105: [rv9004], 107: BASE_RUN.reviews[107] }, files: {},
};

// ------------------------------------------------------------------------------------------------ replay dirs

const okAt = (date) => (body, headers = {}) => ({ status: 200, headers: { date: new Date(date).toUTCString(), 'x-ratelimit-remaining': '4999', ...headers }, body });
const next = (path, query) => ({ link: `<${API}${path}?${new URLSearchParams(query)}>; rel="next"` });

/** Routes of one run: date = the server Date of every response, since = the run's W (absent: first or --full sync). */
function routes({ date, since = null, repoId = REPO_ID, prPages, issues, issueComments, reviewComments, reviews, files }) {
  const ok = okAt(date);
  const out = [{ path: BASE, query: {}, responses: [ok({ ...repoJson(), id: repoId })] }];
  prPages.forEach((page, i) => {       // page 1 under /repos/o/r, later pages under /repositories/<id>: GitHub's Link form
    const link = i + 1 < prPages.length ? next(`${RB}/pulls`, { ...PULLS_Q, page: String(i + 2) }) : {};
    out.push({ path: i ? `${RB}/pulls` : `${BASE}/pulls`, query: i ? { ...PULLS_Q, page: String(i + 1) } : PULLS_Q, responses: [ok(page, link)] });
  });
  const lists = { issues, issueComments, reviewComments };
  for (const [key, path, query] of STREAMS) {
    const items = [...lists[key]].sort((a, b) => a.updated_at.localeCompare(b.updated_at));
    out.push({ path, query: since ? { ...query, since } : query, responses: [ok(items)] });
  }
  for (const [n, list] of Object.entries(reviews)) out.push({ path: `${BASE}/pulls/${n}/reviews`, query: { per_page: '100' }, responses: [ok(list)] });
  for (const [n, f] of Object.entries(files)) {
    const { pages, more } = Array.isArray(f) ? { pages: [f], more: false } : f;
    pages.forEach((page, i) => {
      const link = i + 1 < pages.length || more ? next(`${RB}/pulls/${n}/files`, { per_page: '100', page: String(i + 2) }) : {};
      out.push({ path: i ? `${RB}/pulls/${n}/files` : `${BASE}/pulls/${n}/files`, query: i ? { per_page: '100', page: String(i + 1) } : { per_page: '100' },
        responses: [ok(page, link)] });
    });
  }
  return out;
}

function replay(run, edit = (r) => r) {
  const dir = mkdtempSync(join(tmpdir(), 'brain-e2e-replay-'));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ now: run.date, routes: edit(routes(run)) }));
  return dir;
}

/** Every response of one route becomes a 500 (retries run out). */
const fail500 = (path, query) => (rs) => {
  const r = rs.find((x) => x.path === path && JSON.stringify(x.query) === JSON.stringify(query));
  assert.ok(r, `no route ${path}`);
  r.responses = [{ status: 500, headers: { date: new Date(T2).toUTCString() }, body: { message: 'Server Error' } }];
  return rs;
};

// ------------------------------------------------------------------------------------------------- the stores

const ITEM_ROW_SKIP = new Set(['id', 'detail_for', 'reviews_at', 'flags']);
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

/** github.db as plain data. Each item: row (+ its text refs), files (detail_for, files-truncated + pr-files refs), reviews_at. */
function snap(fx) {
  if (!existsSync(fx.ghDb)) return { state: null, counts: { items: 0, fts: 0, tri: 0, sameText: 0 }, items: {} };
  const db = new DatabaseSync(fx.ghDb);                      // read-write: a crash's hot journal rolls back on open
  try {
    const n = (sql) => db.prepare(sql).get().n;
    const { last_ok_at, run_pid, run_started_at, last_full_at, ...state } = db.prepare('SELECT * FROM sync_state WHERE id = 1').get() ?? {};
    const counts = { items: n('SELECT count(*) AS n FROM items'), fts: n('SELECT count(*) AS n FROM items_fts'), tri: n('SELECT count(*) AS n FROM items_tri'),
      sameText: Math.min(...['items_fts', 'items_tri'].map((f) =>
        n(`SELECT count(*) AS n FROM items i JOIN ${f} f ON f.rowid = i.id WHERE f.title = coalesce(i.title, '') AND f.body = coalesce(i.body, '')`))) };
    const items = {};
    for (const r of db.prepare('SELECT * FROM items ORDER BY ptr').all()) {
      const flags = new Set(String(r.flags || '').split(' ').filter(Boolean));
      const row = Object.fromEntries(Object.entries(r).filter(([k]) => !ITEM_ROW_SKIP.has(k)));
      row.flags = [...flags].filter((f) => f !== 'files-truncated').sort().join(' ');
      items[r.ptr] = { row: { ...row, refs: [] }, files: { detail_for: r.detail_for, truncated: flags.has('files-truncated'), refs: [] }, reviews_at: r.reviews_at, links: [] };
    }
    let orphans = 0;
    for (const r of db.prepare('SELECT * FROM refs ORDER BY ptr, origin, kind, target').all()) {
      const it = items[r.ptr];
      if (!it) { orphans++; continue; }
      (r.origin === 'pr-files' ? it.files : it.row).refs.push(`${r.origin} ${r.kind} ${r.target}`);
      it.links.push({ ...r });
    }
    assert.equal(orphans, 0, 'refs of an item that is not stored');
    return { state: { ...state }, counts, items };
  } finally { db.close(); }
}

/** The whole store minus run timestamps: what a resumed run must end with, the same as a run that finished in one go. */
const final = (s) => ({ state: s.state, counts: s.counts, items: s.items });

/** The common assertions after a failed or killed run (plan §5.2). */
function assertConsistent(s, { before, after, label }) {
  assert.equal(s.state?.cursor ?? null, before.state?.cursor ?? null, `${label}: the cursor did not move`);
  assert.deepEqual([s.counts.fts, s.counts.tri, s.counts.sameText], [s.counts.items, s.counts.items, s.counts.items], `${label}: FTS rows = items, same text`);
  for (const ptr of Object.keys(before.items)) assert.ok(s.items[ptr], `${label}: ${ptr} is still stored`);
  for (const [ptr, it] of Object.entries(s.items)) {
    // an item new in this run starts with its files and reviews steps not run yet
    const was = before.items[ptr] ?? { files: { detail_for: null, truncated: false, refs: [] }, reviews_at: null };
    for (const part of ['row', 'files', 'reviews_at']) {
      const whole = [was[part], after.items[ptr]?.[part]].some((x) => x !== undefined && JSON.stringify(x) === JSON.stringify(it[part]));
      assert.ok(whole, `${label}: ${ptr} ${part} is neither the state before the run nor the state after it`);
    }
  }
  for (const v of Object.values(TOKEN_ENV)) assert.ok(!String(s.state?.last_error ?? '').includes(v), `${label}: a token in last_error`);
}

// ----------------------------------------------------------------------------------------------------- setup

let fx, baseSnap, run2Snap, run3Snap, baseStore;

/** github.db back to the committed state after the base sync: no lock, journal or temp file. */
function restoreBase() {
  resetGithub(fx);
  copyFileSync(baseStore, fx.ghDb);
}

const syncJson = (dir, args = [], env = {}) => {
  const r = sync(fx, dir, [...args, '--json'], env);
  return { ...r, json: parseJson(r) };
};
const requestsTo = (dir, re) => replayRequests(dir).filter((q) => re.test(q.url));

before(() => {
  fx = setupRepo();
  assert.equal(fx.build.status, 0, fx.build.stderr);
  fx.ghDb = githubDbPath(fx.codeDb);
  const dir = replay(BASE_RUN);
  const r = syncJson(dir);
  assert.equal(r.json?.status, 'ok', r.stderr);
  assert.deepEqual(replayRequests(dir).filter((q) => q.unmatched), [], 'the base replay answers every request');
  baseSnap = snap(fx);
  baseStore = join(mkdtempSync(join(tmpdir(), 'brain-e2e-base-')), 'base.github.db');
  copyFileSync(fx.ghDb, baseStore);
  const d2 = replay(RUN2);
  const r2 = syncJson(d2);
  assert.equal(r2.json?.status, 'ok', r2.stderr);
  assert.deepEqual(replayRequests(d2).filter((q) => q.unmatched), [], 'the run 2 replay answers every request');
  run2Snap = snap(fx);
  const d3 = replay(RUN3);
  assert.equal(syncJson(d3).json?.status, 'ok');
  assert.deepEqual(replayRequests(d3).filter((q) => q.unmatched), []);
  run3Snap = snap(fx);
});


/** Requests a replay run made to one route: pathname and the exact query, as the replay seam matches them. */
function hits(dir, path, query) {
  return replayRequests(dir).filter((q) => {
    const u = new URL(q.url);
    const got = Object.fromEntries(u.searchParams);
    return u.pathname === path && Object.keys(got).length === Object.keys(query).length && Object.entries(query).every(([k, v]) => got[k] === v);
  }).length;
}

// ------------------------------------------------------------------------------------------- S1, S2, S3

const SINCE = (i) => ({ ...STREAMS[i][2], since: WINDOW });
const S1_STEPS = [
  ['R1 repo', BASE, {}],
  ['R3 pulls page 1', `${BASE}/pulls`, PULLS_Q],
  ['R3 pulls page 2 (a /repositories/<id> Link)', `${RB}/pulls`, { ...PULLS_Q, page: '2' }],
  ['R4 issues', STREAMS[0][1], SINCE(0)],
  ['R4 issue comments', STREAMS[1][1], SINCE(1)],
  ['R4 review comments', STREAMS[2][1], SINCE(2)],
  ['R8 reviews', `${BASE}/pulls/103/reviews`, { per_page: '100' }],
  ['R8 files', `${BASE}/pulls/105/files`, { per_page: '100' }],
];

for (const [name, path, query] of S1_STEPS) {
  test(`S1: ${name} answers 500 until the retries run out: failed, cursor kept, the same again, then a clean run converges`, () => {
    restoreBase();
    const dir = replay(RUN2, fail500(path, query));
    const r = syncJson(dir);
    assert.equal(r.status, 1, r.stdout);
    assert.equal(r.json?.status, 'failed');
    assert.equal(hits(dir, path, query), 4, 'one request and 3 retries');
    const s = snap(fx);
    assertConsistent(s, { before: baseSnap, after: run2Snap, label: name });
    assert.equal(s.state.run_status, 'failed');
    assert.match(s.state.last_error, /\S/);
    const again = syncJson(replay(RUN2, fail500(path, query)));
    assert.equal(again.json?.status, 'failed');
    assert.deepEqual(final(snap(fx)), final(s), 'the same failure again ends in the same state');
    const ok = syncJson(replay(RUN2));
    assert.equal(ok.json?.status, 'ok', ok.stdout);
    assert.deepEqual(final(snap(fx)), final(run2Snap), 'a clean run ends where a run that finished in one go ends');
  });
}

// failpoints that run 2 reaches: pages 1–5 are pulls ×2 and the three streams, 6–9 the reviews of PRs 101, 103, 105,
// 107; files are fetched for PRs 101 and 105 only (107 keeps its detail_for)
const RUN2_POINTS = ['sync:after-repo', 'sync:page:1', 'sync:page:2', 'sync:page:3', 'sync:page:5', 'sync:page:7',
  'sync:files:1', 'sync:files:2', 'sync:final:before', 'sync:final:inside'];

for (const point of RUN2_POINTS) {
  test(`S2: BRAIN_FAIL_AT=${point} on an incremental run: failed, every common assertion holds, the next run converges`, () => {
    restoreBase();
    const r = syncJson(replay(RUN2), [], { BRAIN_FAIL_AT: point });
    assert.equal(r.status, 1, r.stdout);
    assert.equal(r.json?.status, 'failed');
    assert.match(r.json.error, new RegExp(`injected failure at ${point}$`));
    const s = snap(fx);
    assertConsistent(s, { before: baseSnap, after: run2Snap, label: point });
    assert.equal(s.state.run_status, 'failed', 'sync:final:inside rolled back the cursor UPDATE with its run_status');
    const ok = syncJson(replay(RUN2));
    assert.equal(ok.json?.status, 'ok', ok.stdout);
    assert.deepEqual(final(snap(fx)), final(run2Snap));
  });
}

test('S2: a failed first sync keeps no cursor, and the next run ends like a first sync that finished in one go', () => {
  resetGithub(fx);
  const r = syncJson(replay(BASE_RUN), [], { BRAIN_FAIL_AT: 'sync:page:3' });
  assert.equal(r.json?.status, 'failed');
  const empty = { state: null, items: {} };
  assertConsistent(snap(fx), { before: empty, after: baseSnap, label: 'first sync' });
  assert.ok(Object.keys(snap(fx).items).length > 0, 'pages before the failure were committed');
  assert.equal(syncJson(replay(BASE_RUN)).json?.status, 'ok');
  assert.deepEqual(final(snap(fx)), final(baseSnap));
});

for (const point of RUN2_POINTS) {
  test(`S3: BRAIN_CRASH_AT=${point} (SIGKILL): the store is consistent, the next run clears the stale lock, resumes from the old cursor and converges`, () => {
    restoreBase();
    const crash = sync(fx, replay(RUN2), [], { BRAIN_CRASH_AT: point });
    assert.equal(crash.signal, 'SIGKILL');
    assertConsistent(snap(fx), { before: baseSnap, after: run2Snap, label: point });
    const dir = replay(RUN2);
    const next = syncJson(dir);
    assert.equal(next.json?.status, 'ok', next.stdout);
    assert.equal(next.json.staleLock, true);
    assert.equal(hits(dir, STREAMS[0][1], SINCE(0)), 1, 'the next run reads from the old cursor − 1 h');
    assert.deepEqual(final(snap(fx)), final(run2Snap));
  });
}

// ------------------------------------------------------------------------------------------------ S4, S5

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const SMALL = { date: T1, prPages: [[P[101]]], issueComments: [], reviewComments: [], reviews: { 101: [] }, files: { 101: BASE_RUN.files[101] } };
/** Replace the issues stream of a first sync with explicit pages: [query extra, items][]. */
const issuePages = (pages) => (rs) => {
  const [, path, query] = STREAMS[0];
  return [...rs.filter((r) => r.path !== path), ...pages.map(([extra, items]) => ({ path, query: { ...query, ...extra }, responses: [okAt(T1)(items)] }))];
};

test('S4: 150 issues updated in the same second span two pages: none missing, none twice', () => {
  resetGithub(fx);
  const X = '2026-10-20T10:00:00Z', S = iso(Date.parse(X) - 1000);
  const all = Array.from({ length: 150 }, (_, i) => issue({ number: 300 + i, state: 'open', title: `Bulk import ${300 + i}`, body: 'imported', updated: X }));
  const dir = replay({ ...SMALL, issues: [] }, issuePages([[{}, all.slice(0, 100)], [{ since: S }, all.slice(0, 100)], [{ since: S, page: '2' }, all.slice(100)]]));
  const r = syncJson(dir);
  assert.equal(r.json?.status, 'ok', r.stdout);
  assert.deepEqual(replayRequests(dir).filter((q) => q.unmatched), []);
  assert.equal(hits(dir, STREAMS[0][1], { ...STREAMS[0][2], since: S, page: '2' }), 1, 'paged inside the same-second batch');
  assert.equal(r.json.counts.issues, 150);
  const s = snap(fx);
  const issues = Object.keys(s.items).filter((p) => p.startsWith('issue:'));
  assert.deepEqual(issues.sort(), all.map((x) => `issue:${x.number}`).sort());
  assert.deepEqual([s.counts.items, s.counts.fts, s.counts.tri, s.counts.sameText], Array(4).fill(151));
});

test('S5: an issues page made only of PRs is dropped (R5) and the stream still goes on to the next page', () => {
  resetGithub(fx);
  const start = Date.parse('2026-10-01T00:00:00Z');
  const prs = Array.from({ length: 100 }, (_, i) => prAsIssue(pr({ number: 500 + i, state: 'open', title: `PR ${500 + i}`, body: '', head: `b/${i}`, updated: iso(start + i * 60_000) })));
  const lastAt = Date.parse(prs.at(-1).updated_at), S = iso(lastAt - 1000);
  const later = [issue({ number: 601, state: 'open', title: 'After the PR page', body: 'one', updated: iso(lastAt + 60_000) }),
    issue({ number: 602, state: 'closed', title: 'Also after it', body: 'two', updated: iso(lastAt + 120_000) })];
  const dir = replay({ ...SMALL, issues: [] }, issuePages([[{}, prs], [{ since: S }, [prs.at(-1), ...later]]]));
  const r = syncJson(dir);
  assert.equal(r.json?.status, 'ok', r.stdout);
  assert.deepEqual(replayRequests(dir).filter((q) => q.unmatched), []);
  const ptrs = Object.keys(snap(fx).items);
  assert.ok(ptrs.includes('issue:601') && ptrs.includes('issue:602'), 'the issues after the PR-only page are stored');
  assert.deepEqual(ptrs.filter((p) => /^(pr|issue):5\d\d$/.test(p)), [], 'no item from the PR entries of the issues stream');
  assert.equal(r.json.counts.issues, 2);
});

// --------------------------------------------------------------------------------------------------------- S6

test('S6: an item that comes back older is ignored, the same is a no-op, newer is applied; pr-files refs, detail_for, reviews_at and files-truncated stay', () => {
  restoreBase();
  const d2 = replay(RUN2);
  assert.equal(syncJson(d2).json?.status, 'ok');
  // run 2: PR 107 came back with the same updated_at (the overlap window): its files were not fetched again
  assert.equal(hits(d2, `${BASE}/pulls/107/files`, { per_page: '100' }), 0);
  const s2 = snap(fx);
  assert.deepEqual(s2.items['pr:107'].files, baseSnap.items['pr:107'].files, 'detail_for, files-truncated and the pr-files refs of PR 107');
  assert.equal(s2.items['pr:107'].files.truncated, true);
  assert.equal(s2.items['pr:107'].reviews_at, T2, 'an open PR gets its reviews every run');
  assert.equal(s2.items['review:9001'].row.state, 'DISMISSED', 'a review is overwritten whole (R6)');
  assert.equal(s2.items['pr:101'].row.title, 'Reserve credits before the run (v2)');
  assert.deepEqual(s2.items['pr:101'].files.refs, ['pr-files file src/lib/charge.ts', 'pr-files file src/lib/credits.ts'], 'a newer PR gets its files again');
  const d3 = replay(RUN3);
  assert.equal(syncJson(d3).json?.status, 'ok');
  assert.equal(replayRequests(d3).filter((q) => /\/files\?/.test(q.url)).length, 0, 'run 3 fetches no file list');
  const s3 = snap(fx);
  assert.deepEqual(s3.items['pr:101'].row, s2.items['pr:101'].row, 'older: ignored (title, text refs)');
  assert.deepEqual(s3.items['pr:101'].files, s2.items['pr:101'].files);
  assert.deepEqual(s3.items['pr:105'].row, s2.items['pr:105'].row, 'same: no change');
  assert.deepEqual(s3.items['pr:105'].files, s2.items['pr:105'].files);
  assert.equal(s3.items['pr:105'].reviews_at, T3);
  assert.deepEqual(s3.items['pr:107'].files, s2.items['pr:107'].files);
  assert.equal(s3.items['rc:7003'].row.body, 'Refund only once, and log it.', 'newer: applied');
  assert.equal(s3.items['rc:7003'].row.updated_at, t(13));
  assert.deepEqual(final(s3), final(run3Snap));
});

// --------------------------------------------------------------------------------------------------------- S7

const FULL = { ...BASE_RUN, date: T2 };
const search = (q) => parseJson(cli(fx, ['search', q, '--json']));

for (const point of ['sync:page:2', 'sync:final:inside', 'sync:full:before-swap']) {
  test(`S7: --full fails at ${point}: the old github.db is untouched and still answers, no temp store is left`, () => {
    restoreBase();
    const bytes = sha(fx.ghDb);
    const r = syncJson(replay(FULL), ['--full'], { BRAIN_FAIL_AT: point });
    assert.equal(r.json?.status, 'failed', r.stdout);
    assert.equal(sha(fx.ghDb), bytes, 'the old store is byte for byte the same');
    assert.deepEqual(storeFiles(fx.codeDb).map((f) => basename(f)).filter((n) => /full-tmp/.test(n)), []);
    const found = search('InsufficientCredits');
    assert.ok(found?.rows.some((x) => x.ptr === 'pr:101'), 'search still reads the old store');
    assert.equal(snap(fx).state.cursor, T1);
  });
}

test('S7: a --full killed just before the swap leaves the old store readable; the next --full replaces it and cleans up', () => {
  restoreBase();
  const bytes = sha(fx.ghDb);
  const crash = sync(fx, replay(FULL), ['--full'], { BRAIN_CRASH_AT: 'sync:full:before-swap' });
  assert.equal(crash.signal, 'SIGKILL');
  assert.equal(sha(fx.ghDb), bytes);
  assert.ok(search('InsufficientCredits')?.rows.some((x) => x.ptr === 'pr:101'));
  const r = syncJson(replay(FULL), ['--full']);
  assert.equal(r.json?.status, 'ok', r.stdout);
  assert.equal(r.json.staleLock, true);
  assert.deepEqual(storeFiles(fx.codeDb).map((f) => basename(f)).filter((n) => /full-tmp|-journal$/.test(n)), []);
  const s = snap(fx);
  assert.equal(s.state.cursor, T2);
  assert.deepEqual(Object.keys(s.items), Object.keys(baseSnap.items));
});

// ------------------------------------------------------------------------------------------------- S8, S9

test('S8: an incremental sync on a store from an older sanitizer is refused before any request and writes nothing; --full succeeds', () => {
  restoreBase();
  const db = new DatabaseSync(fx.ghDb);
  db.prepare('UPDATE sync_state SET sanitize_version = ? WHERE id = 1').run(SANITIZE_VERSION - 1);
  db.close();
  const bytes = sha(fx.ghDb);
  const dir = replay(RUN2);
  const r = syncJson(dir);
  assert.equal(r.status, 1);
  assert.equal(r.json?.code, 'rebuild-needed');
  assert.match(r.json.error, /brain sync --full/);
  assert.equal(replayRequests(dir).length, 0, 'no request');
  assert.equal(sha(fx.ghDb), bytes, 'nothing written');
  const full = syncJson(replay(FULL), ['--full']);
  assert.equal(full.json?.status, 'ok', full.stdout);
  assert.equal(snap(fx).state.sanitize_version, SANITIZE_VERSION);
});

test('S9: a repo id that differs from the bound one fails after one request and writes nothing', () => {
  restoreBase();
  const bytes = sha(fx.ghDb);
  const dir = replay({ ...RUN2, repoId: 9999 });
  const r = syncJson(dir);
  assert.equal(r.status, 1);
  assert.equal(r.json?.status, 'failed');
  assert.match(r.json.error, /bound to GitHub repo id 4242, origin is repo id 9999: nothing written/);
  assert.equal(replayRequests(dir).length, 1, 'only the repo request');
  assert.equal(sha(fx.ghDb), bytes);
});

// -------------------------------------------------------------------------------------------------------- S10

test('S10: a relink failure leaves the sync ok with the error recorded; the next build links the refs', () => {
  restoreBase();
  const r = syncJson(replay(RUN2), [], { BRAIN_FAIL_AT: 'sync:relink' });
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json?.status, 'ok');
  assert.match(r.json.relink?.error ?? '', /injected failure at sync:relink/);
  for (const v of Object.values(TOKEN_ENV)) assert.ok(!r.stdout.includes(v));
  const s = snap(fx);
  assert.equal(s.state.cursor, T2);
  const fresh = s.items['pr:105'].links;
  assert.ok(fresh.length && fresh.every((l) => l.status === 'pending' && l.resolved_build === null), 'the new refs wait for a relink');
  const b = cli(fx, ['build', '.', '--db', fx.codeDb]);
  assert.equal(b.status, 0, b.stderr);
  const build = new DatabaseSync(fx.codeDb, { readOnly: true });
  const id = JSON.parse(build.prepare("SELECT value FROM meta WHERE key = 'build_id'").get().value);
  build.close();
  const linked = snap(fx).items['pr:105'].links;
  assert.ok(linked.every((l) => l.status !== 'pending' && l.resolved_build === id), 'build relinked them against the new build');
  assert.ok(linked.some((l) => l.status === 'linked' && l.target === 'src/lib/credits.ts'));
});

// ------------------------------------------------------------------------------------ build → sync → relink → read

test('build → sync → relink → read: search, get and source answer from the store; a rebuild relinks against the new code', () => {
  const f = setupRepo();
  assert.equal(f.build.status, 0, f.build.stderr);
  f.ghDb = githubDbPath(f.codeDb);
  const run = (args) => { const r = cli(f, [...args, '--json']); return { ...r, json: parseJson(r) }; };
  for (const data of [BASE_RUN, RUN2]) {
    const r = sync(f, replay(data), ['--json']);
    assert.equal(parseJson(r)?.status, 'ok', r.stdout);
    assert.ok(parseJson(r).relink?.linked > 0, 'the sync relinked its refs');
  }
  const found = run(['search', 'InsufficientCredits']);
  assert.equal(found.status, 0, found.stdout);
  const ptrs = found.json.rows.map((x) => x.ptr);
  for (const p of ['pr:105', 'pr:101']) assert.ok(ptrs.includes(p), `search finds ${p}`);
  assert.ok(ptrs.some((p) => p.startsWith('doc:docs/credits.md')), 'and the repo memory beside it');
  const got = run(['get', 'pr:105']).json.items[0];
  assert.equal(got.untrusted.title, 'Refund on InsufficientCredits');
  assert.deepEqual(got.thread.map((e) => e.ptr).sort(), ['rc:7003', 'review:9004']);
  assert.deepEqual(got.links.files.map((l) => [l.untrusted.target, l.status]), [['src/lib/credits.ts', 'linked'], ['src/lib/index.ts', 'linked']]);
  assert.deepEqual(got.links.symbols.map((l) => [l.status, l.resolved]), [['linked', ['src/lib/credits.ts#InsufficientCredits']]]);
  assert.deepEqual(got.links.items.map((l) => l.resolved), [['pr:101']]);
  const src = run(['source', 'rc:7003']).json;
  assert.equal(src.origin, 'github');
  assert.deepEqual(src.untrusted.lines, ['Refund only once.']);
  // the code changes: the class is renamed. The rebuild relinks: the symbol ref is no longer linked, the file ref still is
  for (const rel of ['src/lib/credits.ts', 'app/api/run/route.ts']) {
    const path = join(f.repo, rel);
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('InsufficientCredits', 'OutOfCredits'));
  }
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-am', 'rename the credits error'], { cwd: f.repo });
  const b = cli(f, ['build', '.', '--db', f.codeDb]);
  assert.equal(b.status, 0, b.stderr);
  const again = run(['get', 'pr:105']).json.items[0];
  assert.notEqual(again.links.symbols[0].status, 'linked');
  assert.deepEqual(again.links.files.map((l) => l.status), ['linked', 'linked']);
  const code = new DatabaseSync(f.codeDb, { readOnly: true });
  const id = JSON.parse(code.prepare("SELECT value FROM meta WHERE key = 'build_id'").get().value);
  code.close();
  const stale = Object.values(snap(f).items).flatMap((it) => it.links).filter((l) => l.resolved_build !== id);
  assert.deepEqual(stale, [], 'every ref was judged against the new build');
});
