// Lane G: brain sync (design §6.2 R1–R13, §6.3; plan §5.2 S1–S10). Fakes only: no network, no other lane's code.
// The fake sanitizer marks what it touched ('S|' bodies, 'L|' one-line values), so unsanitized text is visible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sync, upsertPage, ingestRaw } from '../../src/gh-sync.mjs';
import { githubDbPath, openGithubDb, readSyncState, writeSyncState } from '../../src/gh-schema.mjs';
import { GuardError } from '../../src/errors.mjs';
import { SANITIZE_VERSION } from '../../src/sanitize.mjs';
import { fakeClock, ghItem } from './helpers.mjs';
import { SECRET, TOKEN, fakeClient, fakeDeps, loadSnapshot, refsOf } from './gh-fixture/fakes.mjs';

const CHILD = join(dirname(fileURLToPath(import.meta.url)), 'gh-fixture', 'sync-child.mjs');
const T1 = '2026-11-10T10:00:00Z', T2 = '2026-11-15T10:00:00Z', NOW = '2026-11-15T10:05:00Z';
const boom = (what) => `${what}: 500 after 3 retries ${SECRET} ${TOKEN}`;   // an error text carrying both secrets

function store() {
  const dir = mkdtempSync(join(tmpdir(), 'gh-sync-'));
  const codeDbPath = join(dir, 'brain.db');
  return { dir, codeDbPath, ghPath: githubDbPath(codeDbPath), lock: `${codeDbPath}.lock` };
}

async function run(s, snap, { full = false, fail = {}, failAt = null, client = fakeClient(loadSnapshot(snap), { fail }), deps = fakeDeps() } = {}) {
  if (failAt) process.env.BRAIN_FAIL_AT = failAt;
  try {
    const r = await sync({ codeDbPath: s.codeDbPath, repoDir: s.dir, client, full, deps, token: TOKEN, clock: fakeClock(NOW) });
    return { r, client, deps };
  } finally { delete process.env.BRAIN_FAIL_AT; }
}

function crash(s, at, full = false) {
  const c = spawnSync(process.execPath, [CHILD, 'v2', s.codeDbPath, ...(full ? ['--full'] : [])],
    { encoding: 'utf8', env: { ...process.env, BRAIN_CRASH_AT: at } });
  assert.equal(c.signal, 'SIGKILL', `the child was not killed at ${at}: ${c.stdout}${c.stderr}`);
}

// read-write open: a hot journal left by a crash is rolled back, as the next writer would do
const withDb = (path, fn) => { const db = openGithubDb(path); try { return fn(db); } finally { db.close(); } };
const rows = (db, sql, ...args) => db.prepare(sql).all(...args).map((r) => ({ ...r }));
const row = (path, ptr) => withDb(path, (db) => ({ ...db.prepare('SELECT * FROM items WHERE ptr = ?').get(ptr) }));
const stateOf = (path) => withDb(path, readSyncState);
const refsAt = (path, ptr, origin) => withDb(path, (db) => rows(db, 'SELECT kind, target FROM refs WHERE ptr = ? AND origin = ? ORDER BY kind, target', ptr, origin));
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));
const noTemp = (s) => { for (const f of [`${s.ghPath}.full-tmp`, `${s.ghPath}.full-tmp-journal`]) assert.equal(existsSync(f), false, f); };

function dump(path) {
  return withDb(path, (db) => {
    const s = readSyncState(db);
    return {
      items: rows(db, 'SELECT * FROM items ORDER BY ptr').map(({ id: _id, ...r }) => r),
      fts: rows(db, 'SELECT i.ptr, f.title, f.body FROM items i JOIN items_fts f ON f.rowid = i.id ORDER BY i.ptr'),
      tri: rows(db, 'SELECT i.ptr, f.title, f.body FROM items i JOIN items_tri f ON f.rowid = i.id ORDER BY i.ptr'),
      refs: rows(db, 'SELECT ptr, kind, target, origin, status FROM refs ORDER BY ptr, origin, kind, target'),
      state: pick(s, ['repo_id', 'repo', 'cursor', 'run_status', 'last_error', 'limits', 'sanitize_version']),
    };
  });
}

// plan §5.2 common invariants: cursor as given, items = items_fts = items_tri, refs match the committed rows, no secret
function assertInvariants(s, cursor) {
  for (const f of [s.ghPath, `${s.ghPath}-journal`]) {
    if (!existsSync(f)) continue;
    const bytes = readFileSync(f);
    for (const v of [SECRET, TOKEN]) assert.equal(bytes.includes(v), false, `secret bytes in ${f}`);
  }
  withDb(s.ghPath, (db) => {
    const st = readSyncState(db);
    assert.equal(st.cursor, cursor, 'cursor');
    for (const v of [SECRET, TOKEN]) assert.equal(String(st.last_error ?? '').includes(v), false, 'secret in last_error');
    const n = (sql) => db.prepare(sql).get().n;
    const items = n('SELECT COUNT(*) AS n FROM items');
    for (const t of ['items_fts', 'items_tri']) {
      assert.equal(n(`SELECT COUNT(*) AS n FROM ${t}`), items, t);
      assert.equal(n(`SELECT COUNT(*) AS n FROM items i JOIN ${t} f ON f.rowid = i.id WHERE f.title IS coalesce(i.title, '') AND f.body IS coalesce(i.body, '')`), items, t);
    }
    const key = (r) => `${r.kind}|${r.target}|${r.origin}`;
    for (const it of rows(db, 'SELECT * FROM items')) {
      const have = rows(db, "SELECT kind, target, origin FROM refs WHERE ptr = ? AND origin != 'pr-files'", it.ptr).map(key).sort();
      assert.deepEqual(have, [...new Set(refsOf(it).map(key))].sort(), `refs of ${it.ptr}`);
    }
    assert.equal(n('SELECT COUNT(*) AS n FROM refs WHERE ptr NOT IN (SELECT ptr FROM items)'), 0, 'orphan refs');
    assert.equal(n("SELECT COUNT(*) AS n FROM refs r JOIN items i USING (ptr) WHERE r.origin = 'pr-files' AND i.detail_for IS NULL"), 0, 'pr-files without detail_for');
  });
}

let reference_;
async function reference() {   // what runs without failures end with: v1 then v2, incremental and --full
  if (reference_) return reference_;
  const inc = store(); await run(inc, 'v1'); await run(inc, 'v2');
  const full = store(); await run(full, 'v1'); await run(full, 'v2', { full: true });
  return (reference_ = { inc: dump(inc.ghPath), full: dump(full.ghPath) });
}
async function base() { const s = store(); await run(s, 'v1'); return s; }

const LINE_COLS = ['title', 'author', 'author_assoc', 'url', 'base', 'head', 'path', 'side', 'start_side'];

test('first sync: every kind stored, R10 states, only sanitized values bound, cursor = Date of getRepo', async () => {
  const s = store();
  let lockHeld = null;
  const deps = fakeDeps({ relink: async (o) => { lockHeld = existsSync(`${o.codeDbPath}.lock`); deps.calls.relink.push(o); return { linked: 0 }; } });
  const { r, client } = await run(s, 'v1', { deps });
  assert.deepEqual(pick(r, ['status', 'cursor', 'error', 'staleLock']), { status: 'ok', cursor: T1, error: null, staleLock: false });
  assert.deepEqual(r.counts, { prs: 6, issues: 2, reviews: 2, reviewComments: 3, issueComments: 3, files: 6, requests: client.requests.length });
  assert.deepEqual(r.relink, { linked: 0 });
  assert.equal(lockHeld, true);                                            // relink ran inside the lock
  assert.deepEqual(deps.calls.relink.map((o) => [o.codeDbPath, o.repoDir]), [[s.codeDbPath, s.dir]]);
  assert.equal(existsSync(s.lock), false);
  assert.equal(statSync(s.ghPath).mode & 0o777, 0o600);
  assert.deepEqual(pick(stateOf(s.ghPath), ['cursor', 'run_status', 'last_ok_at', 'last_full_at', 'last_error', 'sanitize_version', 'repo_id', 'repo', 'limits']),
    { cursor: T1, run_status: 'ok', last_ok_at: NOW, last_full_at: null, last_error: null, sanitize_version: SANITIZE_VERSION, repo_id: 4242, repo: 'L|o/r', limits: { filesTruncated: 1 } });

  const get = (p) => row(s.ghPath, p);
  assert.deepEqual(['pr:1', 'pr:2', 'pr:3', 'pr:4', 'pr:5', 'pr:7'].map((p) => [get(p).state, get(p).draft]),
    [['merged', 0], ['closed_unmerged', 0], ['open', 1], ['open', 0], ['closed_unmerged', 0], ['open', 0]]);
  assert.deepEqual(pick(get('pr:1'), ['number', 'merge_sha', 'merged_at', 'base', 'head', 'author', 'author_assoc']),
    { number: 1, merge_sha: '6b820f87aa11bb22cc33dd44ee55ff6677889900', merged_at: '2026-11-01T10:00:00Z', base: 'L|main', head: 'L|alice/reserve-first', author: 'L|alice', author_assoc: 'L|MEMBER' });
  assert.equal(get('pr:4').merge_sha, null);                               // an open PR's merge_commit_sha is a test merge
  assert.deepEqual([get('issue:10').state, get('issue:11').state, get('issue:11').closed_at], ['open', 'closed', '2026-10-16T10:00:00Z']);
  assert.equal(get('issue:1').ptr, undefined);                             // R5: PRs in the issues stream are not issues
  assert.deepEqual(pick(get('review:300'), ['kind', 'parent_number', 'state', 'submitted_at', 'commit_id', 'body']),
    { kind: 'review', parent_number: 1, state: 'L|APPROVED', submitted_at: '2026-11-01T08:00:00Z', commit_id: '6b820f87aa11bb22cc33dd44ee55ff6677889900', body: 'S|Reserve first is right.' });
  assert.deepEqual(pick(get('rc:200'), ['parent_number', 'review_id', 'in_reply_to', 'path', 'side', 'line', 'original_line', 'commit_id']),
    { parent_number: 1, review_id: 300, in_reply_to: null, path: 'L|src/lib/credits.ts', side: 'L|RIGHT', line: 12, original_line: 12, commit_id: '6b820f87aa11bb22cc33dd44ee55ff6677889900' });
  assert.equal(get('rc:201').in_reply_to, 200);
  assert.deepEqual(pick(get('rc:202'), ['parent_number', 'line', 'start_line', 'original_start_line', 'original_line', 'start_side', 'original_commit_id']),
    { parent_number: 4, line: null, start_line: null, original_start_line: 5, original_line: 7, start_side: 'L|RIGHT', original_commit_id: 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd' });
  assert.deepEqual(['ic:100', 'ic:101', 'ic:103'].map((p) => get(p).parent_number), [10, 2, 7]);

  // masking + injection flag, from the fake sanitizer
  const pr2 = get('pr:2');
  assert.equal(pr2.redactions, 1);
  assert.deepEqual(pr2.flags.split(' ').sort(), ['files-truncated', 'suspicious']);
  assert.match(pr2.body, /^S\|Simpler.*\ntoken: `\[REDACTED:github-token\]`\n/);
  assert.equal(get('pr:5').head, 'L|erin/[REDACTED:github-token]');
  withDb(s.ghPath, (db) => {
    for (const it of rows(db, 'SELECT * FROM items')) {
      for (const c of LINE_COLS) if (it[c] != null) assert.ok(it[c].startsWith('L|'), `${it.ptr}.${c} = ${it[c]}`);
      if (it.body != null) assert.ok(it.body.startsWith('S|'), `${it.ptr}.body`);
      if (it.kind === 'review') assert.ok(it.state.startsWith('L|'));
    }
    for (const rf of rows(db, "SELECT target FROM refs WHERE origin IN ('pr-files', 'inline')")) assert.ok(rf.target.startsWith('L|'), rf.target);
  });
  assert.ok(deps.calls.extract.length >= 17 && deps.calls.extract.every((it) => (it.body == null || it.body.startsWith('S|')) && (it.title == null || it.title.startsWith('L|'))));

  // files and reviews steps (R8: everything is new on a first sync)
  assert.deepEqual(refsAt(s.ghPath, 'pr:1', 'pr-files').map((x) => x.target), ['L|src/lib/charge.ts', 'L|src/lib/credits.ts', 'L|src/lib/old-charge.ts']);
  assert.deepEqual(refsAt(s.ghPath, 'pr:2', 'pr-files').map((x) => x.target), ['L|app/api/run/route.ts', 'L|config/[REDACTED:github-token].env']);
  for (const p of ['pr:1', 'pr:2', 'pr:3', 'pr:4', 'pr:5', 'pr:7']) {
    assert.equal(get(p).detail_for, get(p).updated_at, p);
    assert.equal(get(p).reviews_at, T1, p);
  }
  assert.deepEqual(refsAt(s.ghPath, 'pr:1', 'merge-sha'), [{ kind: 'commit', target: '6b820f87aa11bb22cc33dd44ee55ff6677889900' }]);
  assert.deepEqual(refsAt(s.ghPath, 'rc:200', 'inline'), [{ kind: 'file', target: 'L|src/lib/credits.ts' }]);
  assert.equal(withDb(s.ghPath, (db) => db.prepare("SELECT COUNT(*) AS n FROM refs WHERE status != 'pending'").get().n), 0);
  assertInvariants(s, T1);
});

test('R1: a getRepo response without a usable Date fails the run before any collection', async () => {
  const s = store();
  const data = loadSnapshot('v1');
  data.serverDate = null;
  const { r, client } = await run(s, 'v1', { client: fakeClient(data) });
  assert.deepEqual(pick(r, ['status', 'cursor']), { status: 'failed', cursor: null });
  assert.match(r.error, /Date header/);
  assert.deepEqual(client.requests, ['repo']);
  assert.equal(stateOf(s.ghPath).run_status, 'failed');
});

test('incremental sync: W = cursor − 1h, the PR list stops at the first older PR, reviews and files only where R8 says', async () => {
  const s = await base();
  const { r, client } = await run(s, 'v2');
  assert.deepEqual(pick(r, ['status', 'cursor', 'error']), { status: 'ok', cursor: T2, error: null });
  assert.deepEqual(client.requests.filter((k) => k.startsWith('pulls')), ['pulls:1', 'pulls:2']);
  for (const k of ['issues', 'issue-comments', 'review-comments']) assert.equal(client.streamCalls.find((c) => c.kind === k).since, '2026-11-10T09:00:00Z');
  // pr:4 pr:6 pr:7 are in the window, pr:2 got a comment, pr:3 is open; pr:7's and pr:2's files are current (detail_for)
  assert.deepEqual(client.requests.filter((k) => /^(reviews|files):/.test(k)), ['reviews:2', 'reviews:3', 'reviews:4', 'files:4', 'reviews:6', 'files:6', 'reviews:7']);
  assert.deepEqual(r.counts, { prs: 3, issues: 1, reviews: 2, reviewComments: 1, issueComments: 2, files: 3, requests: client.requests.length });

  const get = (p) => row(s.ghPath, p);
  assert.deepEqual(pick(get('pr:4'), ['state', 'title', 'merge_sha', 'detail_for']),
    { state: 'merged', title: 'L|Retry worker with backoff', merge_sha: 'abcdef0123456789abcdef0123456789abcdef01', detail_for: '2026-11-12T10:00:00Z' });
  assert.deepEqual(refsAt(s.ghPath, 'pr:4', 'pr-files').map((x) => x.target), ['L|packages/worker/backoff.ts', 'L|packages/worker/main.ts']);
  assert.deepEqual([get('pr:7').detail_for, refsAt(s.ghPath, 'pr:7', 'pr-files').map((x) => x.target)], ['2026-11-10T09:30:00Z', ['L|src/lib/limits.ts']]);
  assert.equal(get('pr:6').state, 'open');
  assert.deepEqual([get('issue:10').state, get('issue:10').closed_at], ['closed', '2026-11-14T10:00:00Z']);
  assert.equal(get('rc:202').body, 'S|Backoff here? (edited)');
  assert.equal(get('review:301').state, 'L|DISMISSED');
  assert.equal(get('review:302').parent_number, 3);
  assert.equal(get('ic:104').parent_number, 2);
  assert.deepEqual(['pr:1', 'pr:2', 'pr:3', 'pr:4', 'pr:5', 'pr:6', 'pr:7'].map((p) => get(p).reviews_at), [T1, T2, T2, T2, T1, T2, T2]);
  assert.equal(withDb(s.ghPath, (db) => db.prepare("SELECT COUNT(*) AS n FROM items WHERE ptr IN ('pr:7', 'ic:103', 'ic:104')").get().n), 3);
  const st = stateOf(s.ghPath);
  assert.deepEqual(pick(st, ['sanitize_version', 'last_full_at', 'limits']), { sanitize_version: SANITIZE_VERSION, last_full_at: null, limits: { filesTruncated: 1 } });
  assertInvariants(s, T2);
});

test('S1 first sync: retries exhausted on PR page 2: failed, no cursor, the next run ends like a clean one', async () => {
  const s = store();
  const { r } = await run(s, 'v1', { fail: { 'pulls:2': boom('pulls') } });
  assert.deepEqual(pick(r, ['status', 'cursor']), { status: 'failed', cursor: null });
  assertInvariants(s, null);
  assert.equal((await run(s, 'v1')).r.status, 'ok');
  const clean = store(); await run(clean, 'v1');
  assert.deepEqual(dump(s.ghPath), dump(clean.ghPath));
});

for (const key of ['repo', 'pulls:2', 'issues:1', 'issue-comments:2', 'review-comments:1', 'reviews:4', 'files:6']) {
  test(`S1 retries exhausted at ${key}: failed, cursor kept, sanitized last_error, the next run ends like a clean one`, async () => {
    const s = await base();
    const { r, deps } = await run(s, 'v2', { fail: { [key]: boom(key) } });
    assert.deepEqual(pick(r, ['status', 'cursor']), { status: 'failed', cursor: T1 });
    const st = stateOf(s.ghPath);
    assert.equal(st.run_status, 'failed');
    assert.equal(st.last_error, r.error);
    assert.equal(st.last_error, `L|${key}: 500 after 3 retries [REDACTED:github-token] [REDACTED:active-token]`);
    assert.equal(deps.calls.relink.length, key === 'repo' ? 0 : 1);       // relink follows a failed final state too
    assertInvariants(s, T1);
    assert.equal((await run(s, 'v2')).r.status, 'ok');
    assert.deepEqual(dump(s.ghPath), (await reference()).inc);
  });
}

const FAILPOINTS = [['sync:after-repo'], ['sync:page:1'], ['sync:page:9'], ['sync:files:2'], ['sync:final:before'], ['sync:final:inside'], ['sync:full:before-swap', true]];

for (const [at, full = false] of FAILPOINTS) {
  test(`S2 BRAIN_FAIL_AT=${at}${full ? ' (--full)' : ''}: failed, cursor kept, the next run ends like a clean one`, async () => {
    const s = await base();
    const before = readFileSync(s.ghPath);
    const { r } = await run(s, 'v2', { full, failAt: at });
    assert.deepEqual(pick(r, ['status', 'cursor', 'error']), { status: 'failed', cursor: T1, error: `L|injected failure at ${at}` });
    if (full) { assert.ok(readFileSync(s.ghPath).equals(before), 'old store untouched'); noTemp(s); }
    else assert.equal(stateOf(s.ghPath).run_status, 'failed');            // final:inside: the cursor UPDATE rolled back
    assertInvariants(s, T1);
    assert.equal((await run(s, 'v2', { full })).r.status, 'ok');
    assert.deepEqual(dump(s.ghPath), (await reference())[full ? 'full' : 'inc']);
  });
}

for (const [at, full = false] of [...FAILPOINTS, ['sync:relink']]) {
  test(`S3 BRAIN_CRASH_AT=${at}${full ? ' (--full)' : ''}: the next run clears the stale lock and ends like a clean one`, async () => {
    const s = await base();
    const before = readFileSync(s.ghPath);
    crash(s, at, full);
    assert.equal(existsSync(s.lock), true);                               // SIGKILL: no finally, the lock stays
    if (full) assert.ok(readFileSync(s.ghPath).equals(before), 'old store untouched');
    assertInvariants(s, at === 'sync:relink' ? T2 : T1);                  // relink runs after the final commit
    const { r } = await run(s, 'v2', { full });
    assert.deepEqual(pick(r, ['status', 'staleLock']), { status: 'ok', staleLock: true });
    assert.equal(existsSync(s.lock), false);
    noTemp(s);
    assert.deepEqual(dump(s.ghPath), (await reference())[full ? 'full' : 'inc']);
  });
}

test('a run left marked running by a crash is marked interrupted by the next run', async () => {
  const s = await base();
  crash(s, 'sync:page:2');
  assert.equal(stateOf(s.ghPath).run_status, 'running');
  const fork = fakeClient({ ...loadSnapshot('v2'), repo: { id: 999, full_name: 'x/fork' } });
  const { r } = await run(s, 'v2', { client: fork });                     // refused before it writes its own state
  assert.deepEqual(pick(r, ['status', 'staleLock']), { status: 'failed', staleLock: true });
  assert.deepEqual(pick(stateOf(s.ghPath), ['run_status', 'cursor']), { run_status: 'interrupted', cursor: T1 });
});

test('S4 more same-second items than one page: every id stored once, none lost', async () => {
  const s = store();
  const data = loadSnapshot('v1');
  data.issueComments = Array.from({ length: 12 }, (_, i) => ({ id: 500 + i, body: `burst ${i}`, user: { login: 'zed' },
    issue_url: 'https://api.github.com/repos/o/r/issues/10', html_url: `https://github.com/o/r/issues/10#issuecomment-${500 + i}`,
    created_at: '2026-11-05T10:00:00Z', updated_at: i < 7 ? '2026-11-05T10:00:00Z' : '2026-11-05T10:00:01Z' }));
  const client = fakeClient(data, { pageSize: 3 });
  const { r } = await run(s, 'v1', { client });
  assert.equal(r.status, 'ok');
  assert.ok(client.yielded['issue-comments'].reduce((a, b) => a + b) > 12, 'pages overlapped');
  assert.ok(client.streamCalls.some((c) => c.kind === 'issue-comments' && c.page > 1), 'paged inside a same-second batch');
  const ics = withDb(s.ghPath, (db) => rows(db, "SELECT ptr FROM items WHERE kind = 'issue_comment' ORDER BY ptr").map((x) => x.ptr));
  assert.deepEqual(ics, Array.from({ length: 12 }, (_, i) => `ic:${500 + i}`));
  assert.equal(r.counts.issueComments, 12);
  assertInvariants(s, T1);
});

test('S5 an issues page made only of PRs is dropped and the stream goes on to the next page', async () => {
  const s = store();
  const data = loadSnapshot('v1');
  data.issues = [
    { number: 1, pull_request: {}, title: 'pr one', updated_at: '2026-11-01T10:00:00Z' },
    { number: 2, pull_request: {}, title: 'pr two', updated_at: '2026-11-02T10:00:00Z' },
    { number: 12, state: 'open', title: 'After the PRs', body: 'x', user: { login: 'ivy' }, html_url: 'https://github.com/o/r/issues/12',
      created_at: '2026-11-03T09:00:00Z', updated_at: '2026-11-03T10:00:00Z' },
  ];
  const client = fakeClient(data);
  const { r } = await run(s, 'v1', { client });
  assert.equal(r.status, 'ok');
  assert.equal(client.yielded.issues[0], 0);                              // the first page held only PRs
  assert.equal(row(s.ghPath, 'issue:12').state, 'open');
  assert.equal(row(s.ghPath, 'issue:1').ptr, undefined);
  const viaIngest = withDb(s.ghPath, (db) => ingestRaw(db, 'issue', [{ number: 2, pull_request: {}, updated_at: '2026-11-20T00:00:00Z' }], { selfRepo: 'o/r', deps: fakeDeps() }));
  assert.deepEqual(viaIngest, { inserted: 0, updated: 0, skipped: 0, items: [] });   // R5 holds at the storage path too
});

test('S6 the same item again: older ignored, same idempotent, newer applied; step-owned columns and pr-files refs kept', async () => {
  const s = await base();
  const deps = fakeDeps();
  const v1 = loadSnapshot('v1');
  const pr2 = v1.pulls.find((p) => p.number === 2);
  const ingest = (kind, raws) => withDb(s.ghPath, (db) => { const { items: _items, ...n } = ingestRaw(db, kind, raws, { selfRepo: 'o/r', deps }); return n; });
  const kept = () => {
    const r = row(s.ghPath, 'pr:2');
    return { detail_for: r.detail_for, reviews_at: r.reviews_at, truncated: r.flags.split(' ').includes('files-truncated'), files: refsAt(s.ghPath, 'pr:2', 'pr-files') };
  };
  const keep = kept();
  assert.deepEqual(keep, { detail_for: '2026-11-02T10:00:00Z', reviews_at: T1, truncated: true,
    files: [{ kind: 'file', target: 'L|app/api/run/route.ts' }, { kind: 'file', target: 'L|config/[REDACTED:github-token].env' }] });
  const d0 = dump(s.ghPath);
  assert.deepEqual(ingest('pr', [{ ...pr2, title: 'older', updated_at: '2026-10-30T00:00:00Z' }]), { inserted: 0, updated: 0, skipped: 1 });
  assert.deepEqual(dump(s.ghPath), d0);
  assert.deepEqual(ingest('pr', [pr2]), { inserted: 0, updated: 1, skipped: 0 });
  assert.deepEqual(dump(s.ghPath), d0);
  assert.deepEqual(ingest('pr', [{ ...pr2, title: 'newer', body: 'see `src/x.ts`', updated_at: '2026-11-20T00:00:00Z' }]), { inserted: 0, updated: 1, skipped: 0 });
  assert.deepEqual(pick(row(s.ghPath, 'pr:2'), ['title', 'updated_at', 'flags', 'redactions']), { title: 'L|newer', updated_at: '2026-11-20T00:00:00Z', flags: 'files-truncated', redactions: 0 });
  assert.deepEqual(kept(), keep);
  assert.deepEqual(refsAt(s.ghPath, 'pr:2', 'text'), [{ kind: 'file', target: 'src/x.ts' }]);
  // reviews have no updated_at: a new state always overwrites
  ingest('review', [{ ...v1.reviews[1][0], state: 'DISMISSED', pull_number: 1 }]);
  assert.equal(row(s.ghPath, 'review:300').state, 'L|DISMISSED');
  // upsertPage never writes the step-owned columns or pr-files refs, whatever the entry carries
  withDb(s.ghPath, (db) => upsertPage(db, [{ item: ghItem({ number: 2, updated_at: '2026-12-01T00:00:00Z', detail_for: 'x', reviews_at: 'y', flags: '' }),
    refs: [{ kind: 'file', target: 'zzz', origin: 'pr-files' }] }]));
  assert.deepEqual(kept(), keep);
  assertInvariants(s, T1);
});

test('S7 --full that fails part-way or right before the swap: the old store is unchanged and readable, no temp file', async () => {
  for (const opt of [{ fail: { 'pulls:2': boom('pulls') } }, { fail: { 'files:4': boom('files') } }, { failAt: 'sync:full:before-swap' }]) {
    const s = await base();
    const before = readFileSync(s.ghPath);
    const { r, deps } = await run(s, 'v2', { full: true, ...opt });
    assert.deepEqual(pick(r, ['status', 'cursor', 'relink']), { status: 'failed', cursor: T1, relink: null });
    assert.equal(deps.calls.relink.length, 0);
    assert.ok(readFileSync(s.ghPath).equals(before), 'old store untouched');
    noTemp(s);
    const ro = openGithubDb(s.ghPath, { readOnly: true });
    assert.equal(ro.prepare('SELECT COUNT(*) AS n FROM items').get().n, 16);
    ro.close();
    assertInvariants(s, T1);
  }
});

test('--full builds a new store: a leftover temp store is replaced, items gone from GitHub disappear, last_full_at set', async () => {
  const s = await base();
  withDb(s.ghPath, (db) => ingestRaw(db, 'issue', [{ number: 99, state: 'open', title: 'deleted on GitHub', updated_at: '2026-11-09T00:00:00Z' }], { selfRepo: 'o/r', deps: fakeDeps() }));
  writeFileSync(`${s.ghPath}.full-tmp`, 'junk');
  writeFileSync(`${s.ghPath}.full-tmp-journal`, 'junk');
  const { r, deps } = await run(s, 'v2', { full: true });
  assert.deepEqual(pick(r, ['status', 'cursor']), { status: 'ok', cursor: T2 });
  assert.equal(deps.calls.relink.length, 1);
  noTemp(s);
  assert.equal(row(s.ghPath, 'issue:99').ptr, undefined);
  assert.deepEqual(pick(stateOf(s.ghPath), ['last_full_at', 'last_ok_at', 'sanitize_version']), { last_full_at: NOW, last_ok_at: NOW, sanitize_version: SANITIZE_VERSION });
  assert.equal(statSync(s.ghPath).mode & 0o777, 0o600);
  assert.deepEqual(dump(s.ghPath), (await reference()).full);
  assertInvariants(s, T2);
});

test('S8 incremental sync on a store masked by an older sanitizer: GuardError, nothing written; --full succeeds', async () => {
  const s = await base();
  withDb(s.ghPath, (db) => writeSyncState(db, { sanitize_version: SANITIZE_VERSION - 1 }));
  const before = readFileSync(s.ghPath);
  const client = fakeClient(loadSnapshot('v2'));
  await assert.rejects(run(s, 'v2', { client }), (e) => e instanceof GuardError && e.store === 'github' && e.code === 'rebuild-needed');
  assert.deepEqual(client.requests, []);
  assert.ok(readFileSync(s.ghPath).equals(before), 'nothing written');
  assert.equal(existsSync(s.lock), false);
  const { r } = await run(s, 'v2', { full: true });
  assert.equal(r.status, 'ok');
  assert.equal(stateOf(s.ghPath).sanitize_version, SANITIZE_VERSION);
});

test('S9 repo id mismatch: failed, nothing written, nothing else requested', async () => {
  const s = await base();
  const before = readFileSync(s.ghPath);
  const client = fakeClient({ ...loadSnapshot('v2'), repo: { id: 999, full_name: 'x/fork' } });
  for (const full of [false, true]) {
    const { r, deps } = await run(s, 'v2', { client, full });
    assert.deepEqual(pick(r, ['status', 'cursor', 'relink']), { status: 'failed', cursor: T1, relink: null });
    assert.match(r.error, /repo id 4242, origin is repo id 999/);
    assert.equal(deps.calls.relink.length, 0);
  }
  assert.deepEqual(client.requests, ['repo', 'repo']);
  assert.ok(readFileSync(s.ghPath).equals(before), 'nothing written');
  noTemp(s);
});

test('S10 relink failure (an error, or BRAIN_FAIL_AT=sync:relink) is reported and the sync is still ok', async () => {
  const s = await base();
  const deps = fakeDeps({ relink: async () => { throw new Error(`relink broke on ${SECRET}`); } });
  const a = (await run(s, 'v2', { deps })).r;
  assert.deepEqual(pick(a, ['status', 'cursor', 'error']), { status: 'ok', cursor: T2, error: null });
  assert.deepEqual(a.relink, { error: 'L|relink broke on [REDACTED:github-token]' });
  const b = (await run(s, 'v2', { failAt: 'sync:relink' })).r;
  assert.deepEqual(pick(b, ['status', 'relink']), { status: 'ok', relink: { error: 'L|injected failure at sync:relink' } });
  assert.equal(stateOf(s.ghPath).run_status, 'ok');
  assertInvariants(s, T2);
});

test('another write holding the lock: status busy, no store created', async () => {
  const s = store();
  writeFileSync(s.lock, String(process.ppid));                            // a live process that is not us
  const { r, client } = await run(s, 'v1');
  assert.deepEqual(pick(r, ['status', 'cursor', 'staleLock', 'relink']), { status: 'busy', cursor: null, staleLock: false, relink: null });
  assert.match(r.error, /another brain write is running/);
  assert.deepEqual(client.requests, []);
  assert.equal(existsSync(s.ghPath), false);
});
