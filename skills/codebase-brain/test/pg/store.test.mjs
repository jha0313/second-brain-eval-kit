// Q5: the read stores. Offline: revision pointers (@r<n>) and the SQLite store over the golden stores (same results as
// the Phase 1 API, refusals of server-only reads). On a Neon branch, as brain_reader, over runs r1 (golden seed) .. r4
// published with write-run.mjs: V4 (a doc edit gives that doc alone a new revision; @r1 keeps its text), V15 (--as-of
// run / commit / date in UTC and with an offset, against the table below), parity with a mirror of the same run read
// by the SQLite store, V16 (a publish between two statements of one command; it publishes r6 after a rolled-back run 5),
// then an old revision's refs across that run-id gap.
// Search payload (§6.9): on Neon, the search the server ranks equals rank() over its lists, and a group date that is not
// ASCII gets the lists; offline, searchIn ranks such lists with rank().
// The Neon tests need NEON_PROJECT_ID; they are skipped without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { useBranch, neonSkip } from './harness.mjs';
import { writeRun } from './write-run.mjs';
import { buildStores, goldenState } from './golden/build-golden.mjs';
import { pullMirror } from '../../src/pg/mirror.mjs';
import { githubDbPath } from '../../src/gh-schema.mjs';
import { openContext } from '../../src/context.mjs';
import { pgStore } from '../../src/store/pg.mjs';
import { sqliteStore } from '../../src/store/sqlite.mjs';
import { search, get, source, searchIn, getIn, sourceIn } from '../../src/read.mjs';
import { parseRevPtr, formatRevPtr, parsePtr } from '../../src/ptr.mjs';

const skip = neonSkip();
const b = useBranch('store');
const work = mkdtempSync(join(tmpdir(), 'brain-store-'));

const DOC = 'doc:docs/credits.md:1-6', CHANGE = 'change:changes/20261001-reserve-first.md:1-8', COMMIT = 'commit:b070cb73';
const GH_PTRS = ['pr:1121', 'review:9', 'rc:7', 'issue:45', 'ic:11'];
const SHA = (c) => `aaaaaaa${c}${'0'.repeat(32)}`;
const meta = (build, commit) => `UPDATE meta SET value = '"${build}"' WHERE key = 'build_id'; UPDATE meta SET value = '"${commit}"' WHERE key = 'commit';`;
const relink = (from, to) => `UPDATE refs SET resolved_build = '${to}' WHERE resolved_build = '${from}';`;
const ADDED = 'Reserve first, then charge.';
// r2..r5 as SQLite edits of the previous run's stores (`o`: the r1 store of the same kind, ATTACHed). at: published_at
const RUNS = [
  { n: 2, at: '2099-11-20T10:00:00.000Z', code: `UPDATE chunks SET body = body || char(10) || '${ADDED}' WHERE source = 'doc'; ${meta('golden02', SHA(1))}`,
    gh: `${relink('golden00', 'golden02')} UPDATE sync_state SET cursor = '2099-11-20T09:00:00Z';` },
  { n: 3, at: '2099-11-21T23:30:00.000Z', code: meta('golden03', SHA(2)),
    gh: `UPDATE items SET title = '크레딧 예약 순서 (정리)', updated_at = '2099-11-21T23:00:00Z' WHERE ptr = 'issue:45';
      DELETE FROM items WHERE ptr = 'ic:8'; DELETE FROM refs WHERE ptr = 'ic:8'; ${relink('golden02', 'golden03')}` },
  { n: 4, at: '2099-11-23T01:00:00.000Z', code: `UPDATE chunks SET body = (SELECT x.body FROM o.chunks x WHERE x.id = chunks.id) WHERE source = 'doc';
      ${meta('golden04', SHA(2))}`,
    gh: `INSERT INTO items (id, ptr, kind, parent_number, author, body, url, created_at, updated_at) VALUES (11, 'ic:11', 'issue_comment', 45,
        'erin', '다시 #12 참고', 'https://github.com/o/r/issues/45#issuecomment-11', '2099-11-23T00:00:00Z', '2099-11-23T00:00:00Z');
      INSERT INTO refs (ptr, kind, target, origin, status) VALUES ('ic:11', 'item', 'pr:12', 'text', 'pending'); ${relink('golden03', 'golden04')}` },
];
// published by V16 after a rolled-back publish took run id 5 (run ids have gaps): issue:45 and pr:1121 get a revision
const R6 = { n: 6, base: 4, at: '2099-11-24T00:00:00.000Z', code: meta('golden06', SHA(3)),
  gh: `UPDATE items SET title = '크레딧 예약 순서 (r6)', updated_at = '2099-11-23T23:00:00Z' WHERE ptr = 'issue:45';
    UPDATE items SET title = 'Charge after run (renamed)' WHERE ptr = 'pr:1121'; ${relink('golden04', 'golden06')}` };

// V15: --as-of -> run, and what each run shows (the doc revision search points at, issue:45's revision, ic:8 / ic:11)
const AS_OF = [['run:3', 3], ['commit:b070cb7', 1], ['commit:aaaaaaa1', 2], [`commit:${SHA(2)}`, 4], ['2099-11-19', 1], ['2099-11-20', 2],
  ['2099-11-21', 3], ['2099-11-21+09:00', 2], ['2099-11-22', 3], ['2099-11-22+09:00', 3], ['2099-11-22-05:00', 4], [null, 4]];
const SEEN = { 1: { doc: 1, issue: 1, ic8: true, ic11: false }, 2: { doc: 2, issue: 1, ic8: true, ic11: false },
  3: { doc: 2, issue: 2, ic8: false, ic11: false }, 4: { doc: 3, issue: 2, ic8: false, ic11: true } };

let r1 = null, prev = null, runs = [], setup = null, gha = 200;
function edit(spec) {
  const codeDb = join(work, `r${spec.n}.db`), ghDb = githubDbPath(codeDb);
  copyFileSync(prev.codeDb, codeDb); copyFileSync(prev.ghDb, ghDb);
  for (const [file, orig, sql] of [[codeDb, r1.codeDb, spec.code], [ghDb, r1.ghDb, spec.gh]]) {
    const db = new DatabaseSync(file);
    try { db.exec(`ATTACH '${orig}' AS o`); db.exec(sql); } finally { db.close(); }
  }
  prev = { codeDb, ghDb };
}
async function publish(spec) {
  edit(spec);
  const w = await b.connect('writer');
  try {
    const { run, state } = await writeRun(w, runs[spec.base ?? spec.n - 1], goldenState(prev.codeDb, prev.ghDb), { gha: gha++, publishedAt: spec.at });
    assert.equal(run, spec.n);
    runs[spec.n] = state;
  } finally { await w.end(); }
}
// a publish that rolls back after its run row: the run id is used up
async function rolledBack() {
  const w = await b.connect('writer');
  try {
    await w.query('BEGIN');
    const { attempt_id: att } = (await w.query(`INSERT INTO brain.attempt (gha_run_id, gha_attempt, source_sha) VALUES ($1, 1, $2) RETURNING attempt_id`, [gha++, SHA(9)])).rows[0];
    await w.query(`INSERT INTO brain.run (attempt_id, commit_sha, mode, tool_version, sanitize_version, meta, checksum) VALUES ($1, $2, 'normal', 't', 1, '{}', '{}')`, [att, SHA(9)]);
    await w.query('ROLLBACK');
  } finally { await w.end(); }
}
// once, awaited by every Neon test (root-level before() hooks run concurrently: the branch would not exist yet)
const ready = () => (setup ??= (async () => {
  await b.migrate();
  await b.seed();
  r1 = buildStores();
  prev = r1;
  runs[1] = { ...goldenState(r1.codeDb, r1.ghDb), run: 1 };
  for (const spec of RUNS) await publish(spec);
})());
async function withStore(fn) {
  await ready();
  const store = pgStore(await b.connect('reader'));
  try { return await fn(store); } finally { await store.close(); }
}
const code = (e) => e?.code;
const rejects = (p, c) => assert.rejects(p, (e) => { assert.equal(code(e), c, e?.message); return true; });
const r1Body = () => { const db = new DatabaseSync(r1.codeDb, { readOnly: true }); try { return db.prepare("SELECT body FROM chunks WHERE source = 'doc'").get().body; } finally { db.close(); } };

// ---------- offline ----------

test('revision pointers: @r<n> on every pointer but vault; Phase 1 pointers unchanged', () => {
  for (const s of ['pr:1121@r2', 'rc:7@r1', `${DOC}@r3`, 'doc:a@r1.md:1-2@r10', `${COMMIT}@r1`, `${DOC}@golden00`, 'vault:n.md:1-2@abcd1234', 'pr:5']) {
    assert.equal(formatRevPtr(parseRevPtr(s)), s, s);
  }
  assert.deepEqual(parseRevPtr(`${DOC}@r3`), { type: 'doc', path: 'docs/credits.md', a: 1, b: 6, build: null, rev: 3 });
  assert.equal(parseRevPtr(`${DOC}@r1234567`).build, 'r1234567');   // 8 characters: a build, never a revision
  for (const s of ['vault:n.md:1-2@r1', `${DOC}@golden00@r1`, 'doc:x.md:5-2@r1', 'pr:abc@r1', 'pr:1@r0', DOC]) {
    assert.throws(() => parseRevPtr(s), (e) => code(e) === 'bad-pointer', s);
  }
  assert.throws(() => parsePtr('pr:1121@r2'), (e) => code(e) === 'bad-pointer');
});

test('SQLite store: the Phase 1 results plus view; revisions and --as-of are server reads', async () => {
  const s = buildStores();
  const ctx = openContext({ codeDbPath: s.codeDb });
  try {
    const store = sqliteStore(ctx);
    const build = ctx.meta.build_id;
    for (const q of ['credits reserve', '크레딧 예약', '#12', 'src/lib/credits.ts']) {
      const { view, ...rest } = await searchIn(store, q, { limit: 50 });
      assert.deepEqual(rest, search(ctx, q, { limit: 50 }), q);
      assert.deepEqual(view, { run: null, runCommit: null, publishedAt: null, sync: ctx.sync, codeSanitizeVersion: ctx.meta.sanitize_version,
        githubSanitizeVersion: ctx.sync.sanitize_version });
    }
    const ptrs = ['pr:1121', 'issue:45', `${DOC}@${build}`, COMMIT];
    const { view, ...g } = await getIn(store, ptrs);
    assert.deepEqual(g, get(ctx, ptrs));
    const { view: v2, ...src } = await sourceIn(store, `${DOC}@${build}`);
    assert.deepEqual(src, source(ctx, `${DOC}@${build}`));
    await rejects(getIn(store, [`${DOC}@r1`]), 'needs-server');
    await rejects(sourceIn(store, 'pr:1121@r1'), 'needs-server');
    await rejects(store.candidates('x', { asOf: 3 }), 'needs-server');
    await rejects(store.resolveAsOf('run:1'), 'needs-server');
    assert.equal((await store.resolveAsOf(null)).run, null);
  } finally { ctx.close(); }
});

test('searchIn: lists from a store asked to rank (the server, when a group d is not ASCII) are ranked by rank(), in JS string order', async () => {
  // two groups with one score; descending d is U+E000, U+10000 in JS (UTF-16 code units), the other way in bytes
  const a = { key: 'c1', grp: 'c1', d: '\u{10000}', ptr: null, flags: null }, z = { key: 'c2', grp: 'c2', d: '\ue000', ptr: null, flags: null };
  const asked = [];
  const store = {
    async candidates(q, o) {
      asked.push(o.top);
      return { lists: [{ name: 'x', rows: [a, z], truncated: false }, { name: 'y', rows: [z, a], truncated: false }],
        facts: { pathRefsPending: 0, filesTruncated: 0, githubPresent: false }, view: { run: 1 } };
    },
    async rows(keys) { return { rows: keys.map((key) => ({ key, ptr: `doc:${key}.md:1-1@r1`, source: 'doc', origin: 'repo', title: key, body: key, date: null })), view: { run: 1 } }; },
  };
  const r = await searchIn(store, 'q', { limit: 5, cursor: 0 });
  assert.deepEqual(asked, [{ cursor: 0, limit: 5 }]);
  assert.deepEqual([r.rows.map((x) => x.untrusted.title), r.total, r.next], [['c2', 'c1'], 2, null]);
});

// ---------- Neon ----------

test('V4: a doc edit gives that doc alone a new revision; @r1 keeps its text', { skip }, () => withStore(async (store) => {
  const at2 = (await b.query('reader', `SELECT i.ptr FROM brain.item_rev r JOIN brain.item i USING (item_id) WHERE r.valid_from = 2 ORDER BY i.ptr`)).rows;
  assert.deepEqual(at2.map((x) => x.ptr), ['doc:docs/credits.md']);
  const revs = async (ptrs, asOf) => (await getIn(store, ptrs, { asOf })).items.map((i) => i.revs.map((x) => `r${x.rev}@${x.run}`).join(' '));
  assert.deepEqual(await revs([`${DOC}@r1`, `${CHANGE}@r1`, COMMIT, 'pr:1121'], 2), ['r1@1 r2@2', 'r1@1', 'r1@1', 'r1@1']);
  assert.deepEqual(await revs([`${DOC}@r1`, `${CHANGE}@r1`, COMMIT, 'pr:1121'], null), ['r1@1 r2@2 r3@4', 'r1@1', 'r1@1', 'r1@1']);
  const text = async (ptr, asOf = null) => (await sourceIn(store, ptr, { asOf })).untrusted.lines.join('\n');
  const old = r1Body();
  assert.equal(await text(`${DOC}@r1`), old);
  assert.equal(await text(`${DOC}@r2`), `${old}\n${ADDED}`);
  assert.equal(await text(`${DOC}@r3`), old);
  assert.equal((await sourceIn(store, `${DOC}@r2`)).ptr, `${DOC}@r2`);
  await rejects(sourceIn(store, `${DOC}@r4`), 'not-found');
  await rejects(sourceIn(store, `${DOC}@r3`, { asOf: 2 }), 'not-found');     // published after the run asked for
}));

test('V15: --as-of run / commit / date (UTC, offset) picks the run; the run shows its revisions', { skip }, () => withStore(async (store) => {
  for (const [spec, want] of AS_OF) {
    const { run, view } = await store.resolveAsOf(spec);
    assert.equal(run, want, String(spec));
    assert.equal(view.run, want);
    assert.equal(view.publishedAt, want === 1 ? view.publishedAt : RUNS[want - 2].at);
    const seen = SEEN[run];
    const s = await searchIn(store, 'Credits', { asOf: run, kind: ['doc'] });
    assert.equal(s.view.run, run);
    assert.deepEqual(s.rows.map((r) => r.ptr), [`${DOC}@r${seen.doc}`], String(spec));
    assert.equal((await store.get(['issue:45'], { asOf: run })).items[0].rev, seen.issue);
    for (const [ptr, there] of [['ic:8', seen.ic8], ['ic:11', seen.ic11]]) {
      const got = await getIn(store, [ptr], { asOf: run }).then(() => true, (e) => { assert.equal(code(e), 'not-found'); return false; });
      assert.equal(got, there, `${ptr} at run ${run}`);
    }
  }
  assert.equal((await store.resolveAsOf('run:4')).view.runCommit, SHA(2));
  await rejects(store.resolveAsOf('run:9'), 'not-found');
  await rejects(store.resolveAsOf('2026-01-01'), 'not-found');                 // before run 1
  await rejects(store.resolveAsOf('commit:aaaaaaa'), 'ambiguous');             // runs of two commits
  for (const bad of ['yesterday', '2099-02-30', '2099-11-21+25:00', 'run:0', 'commit:xyz']) await rejects(store.resolveAsOf(bad), 'usage');
  await rejects(store.candidates('x', { asOf: 9 }), 'not-found');
}));

test('parity: the Postgres store and a mirror of the same run read by the SQLite store give the same results', { skip }, () => withStore(async (store) => {
  const m = await pullMirror({ url: b.readerUrl, dir: join(work, 'mirror'), shapes: ['code', 'github'] });
  const ctx = openContext({ codeDbPath: m.codeDb });
  try {
    assert.deepEqual((await store.candidates('x')).view, (await sqliteStore(ctx).candidates('x')).view);
    const noRevs = ({ revs, ...i }) => i;
    const pg = await getIn(store, GH_PTRS);
    assert.deepEqual({ items: pg.items.map(noRevs), facts: pg.facts }, get(ctx, GH_PTRS));
    const build = ctx.meta.build_id;
    const local = get(ctx, [`${DOC}@${build}`, `${CHANGE}@${build}`, COMMIT]);
    const server = await getIn(store, [`${DOC}@r3`, `${CHANGE}@r1`, COMMIT]);
    const noPtr = ({ ptr, revs, ...i }) => i;
    assert.deepEqual(server.items.map(noPtr), local.items.map(noPtr));
    assert.deepEqual((await getIn(store, [`${DOC}@${build}`])).items.map(noPtr), [local.items[0]].map(noPtr));   // this run's build
    await rejects(getIn(store, [`${DOC}@golden01`]), 'stale-pointer');
    await rejects(getIn(store, [`vault:n.md:1-2@${build}`]), 'not-found');      // vault is local only
    // PRs and issues share numbers: a miss on one kind names the other where it exists, the same on both stores
    for (const [miss, also] of [['pr:45', 'issue:45'], ['issue:1121', 'pr:1121'], ['pr:9999', undefined], ['review:45', undefined]]) {
      for (const read of [(s) => getIn(s, ['pr:1121', miss]), (s) => sourceIn(s, miss)]) {
        const [e, l] = [await read(store).catch((x) => x), await read(sqliteStore(ctx)).catch((x) => x)];
        assert.equal(code(e), 'not-found', miss);
        assert.deepEqual([e.also, e.message], [l.also, l.message], miss);
        assert.equal(e.also, also, miss);
      }
    }
    assert.equal((await getIn(store, ['pr:45@r1']).catch((x) => x)).also, 'issue:45');
    for (const [ptr, mine] of [['issue:45', 'issue:45'], ['rc:7', 'rc:7'], [`${DOC}@${build}`, `${DOC}@r3`], [COMMIT, COMMIT]]) {
      const { view, ...s } = await sourceIn(store, mine);
      assert.deepEqual({ ...s, ptr: null }, { ...source(ctx, ptr), ptr: null }, ptr);
    }
    // search: same rows, totals and facts; the order within a list may differ (ts_rank vs bm25), so rows are sorted
    const base = (p) => p.replace(/@(r\d+|[0-9a-z]{8})$/, '');
    const norm = (r) => ({ rows: r.rows.map((x) => ({ ...x, ptr: base(x.ptr), matched: [...x.matched].sort() })).sort((a, c) => (a.ptr < c.ptr ? -1 : 1)),
      total: r.total, next: r.next, facts: r.facts });
    const QUERIES = [['credits reserve'], ['크레딧 예약'], ['예약'], ['#12'], ['b070cb7'], ['src/lib/credits.ts'], ['InsufficientCredits'], ['reserve', { path: 'src/lib' }],
      ['reserve', { kind: ['pr', 'review'] }], ['credits', { state: ['open'] }], ['reserve', { author: 'dave' }], ['credits', { since: '2026-09-12' }]];
    for (const [q, o = {}] of QUERIES) {
      const pgR = await searchIn(store, q, { limit: 50, ...o });
      assert.equal(pgR.view.run, 4);
      assert.ok(pgR.rows.length > 0, `${q}: no rows (the comparison would prove nothing)`);
      assert.deepEqual(norm(pgR), norm(search(ctx, q, { limit: 50, ...o })), `${q} ${JSON.stringify(o)}`);
    }
  } finally { ctx.close(); }
}));

test('V16: a publish between two statements of one command: the command reads one run', { skip }, () => withStore(async (store) => {
  let published = false;
  const racing = { ...store, async candidates(q, o) { const c = await store.candidates(q, o); await rolledBack(); await publish(R6); published = true; return c; } };
  const s = await searchIn(racing, '크레딧 예약', { kind: ['issue'] });
  assert.ok(published);
  assert.equal(s.view.run, 4);
  assert.deepEqual(s.rows.map((r) => [r.ptr, r.untrusted.title]), [['issue:45', '크레딧 예약 순서 (정리)']]);
  const after = await searchIn(store, '크레딧 예약', { kind: ['issue'] });
  assert.equal(after.view.run, 6);
  assert.deepEqual(after.rows.map((r) => r.untrusted.title), ['크레딧 예약 순서 (r6)']);
  const pinned = await getIn(store, ['issue:45'], { asOf: s.view.run });
  assert.equal(pinned.items[0].untrusted.title, '크레딧 예약 순서 (정리)');
  assert.deepEqual(pinned.items[0].revs.map((x) => x.rev), [1, 2]);
}));

test('an old revision shows its refs as of the last run it was visible in, across a run-id gap', { skip }, () => withStore(async (store) => {
  await ready();
  assert.equal((await store.resolveAsOf('run:5').catch((e) => e)).code, 'not-found');     // the rolled-back publish
  const files = async (ptr) => (await getIn(store, [ptr])).items[0].links.files.map((l) => `${l.untrusted.target} ${l.status}`);
  assert.deepEqual(await files('pr:1121'), ['src/lib/credits.ts linked']);
  assert.deepEqual(await files('pr:1121@r1'), ['src/lib/credits.ts linked']);              // run 4's link and build, not "run 5"
  assert.deepEqual((await getIn(store, ['pr:1121@r1'])).items[0].revs.map((x) => `r${x.rev}@${x.run}`), ['r1@1', 'r2@6']);
}));

// the store as searchIn read it before the search payload change: every list, ranked by read.mjs rank()
const plainOf = (store) => ({ ...store, candidates: (q, { top, ...o }) => store.candidates(q, o) });

test('search payload: the server ranks, and the results are rank() over its lists', { skip }, () => withStore(async (store) => {
  const plain = plainOf(store);
  const c = await store.candidates('credits', { top: { cursor: 0, limit: 10 } });
  assert.ok(!c.lists && c.ranked.shown.length > 0);
  const OPTS = [{}, { limit: 1 }, { limit: 2, cursor: 1 }, { cursor: 3 }, { cursor: 1000 }, { limit: 50 }, { kind: ['pr', 'review'] }, { kind: ['doc', 'commit'] },
    { path: 'src/lib' }, { limit: 2.7, cursor: 0.5 }, { limit: Infinity }, { cursor: 1e308, limit: 1e308 }];
  for (const q of ['credits reserve', '크레딧 예약', '예약', '#12', 'b070cb7', 'src/lib/credits.ts', 'InsufficientCredits', 'reserve', 'credits', '', 'zzzz none']) {
    for (const o of OPTS) assert.deepEqual(await searchIn(store, q, o), await searchIn(plain, q, o), `${q} ${JSON.stringify(o)}`);
  }
}));

test('search payload: a group date that is not ASCII gets the lists, and rank() orders them', { skip }, () => withStore(async (store) => {
  // JS compares UTF-16 code units and Postgres "C" bytes: U+10000 sorts below U+E000 in JS, above it in Postgres
  const last = Number((await b.query('reader', 'SELECT max(run_id) AS m FROM brain.run')).rows[0].m);
  await publish({ n: last + 1, base: last, at: '2099-11-25T00:00:00.000Z', gh: '',
    code: `UPDATE chunks SET date = char(65536) WHERE source = 'doc'; UPDATE chunks SET date = char(57344) WHERE source = 'change'; ${meta('golden07', SHA(4))}` });
  const plain = plainOf(store);
  for (const q of ['credits', 'reserve', 'credits reserve']) {
    const c = await store.candidates(q, { kind: ['doc', 'change'], top: { cursor: 0, limit: 10 } });
    assert.ok(c.lists && !c.ranked, q);
    for (const o of [{}, { kind: ['doc', 'change'] }]) assert.deepEqual(await searchIn(store, q, o), await searchIn(plain, q, o), `${q} ${JSON.stringify(o)}`);
  }
}));
