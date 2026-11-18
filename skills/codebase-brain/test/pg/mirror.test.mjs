// Q4 on a Neon branch: pullMirror full and delta (V17), a killed pull, a broken mirror and a wrong server checksum
// (V18). Runs r2..r4 are the golden stores edited in SQLite, published with test/pg/write-run.mjs; the reference for
// every mirror is the state the server shows at that run (applyDelta of the published delta), read back through
// snapshot() and goldenState(). Needs NEON_PROJECT_ID; skipped without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, statSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { useBranch, neonSkip } from './harness.mjs';
import { startProxy } from './proxy.mjs';
import { writeRun } from './write-run.mjs';
import { buildStores, goldenState, expectedText, EXPECTED } from './golden/build-golden.mjs';
import { pullMirror, MIRROR_DB } from '../../src/pg/mirror.mjs';
import { snapshot } from '../../src/pg/snapshot.mjs';
import { githubDbPath } from '../../src/gh-schema.mjs';
import * as C from '../../src/pg/contract.mjs';

const skip = neonSkip();
const b = useBranch('mirror');
const work = mkdtempSync(join(tmpdir(), 'brain-mirror-'));
const BOTH = ['code', 'github'], CODE = ['code'];
const runs = [];                                   // runs[n] = the server state at run n (run set)

// r2..r4 as SQLite edits of the previous run's stores; `o` is the r1 store of the same kind (ATTACHed)
const EDITS = [
  [2, `UPDATE nodes SET line = line + 2, end_line = end_line + 2 WHERE key = 'src/lib/credits.ts#reserve';
       DELETE FROM nodes WHERE key = 'src/ui/Meter.tsx#displayName';
       INSERT INTO edges (src, dst, kind, path, line, col) SELECT s.id, d.id, 'call', 'app/dash/page.tsx', 6, 3 FROM nodes s, nodes d
         WHERE s.key = 'app/dash/page.tsx#Page' AND d.key = 'src/lib/credits.ts#InsufficientCredits';
       DELETE FROM edges WHERE kind = 'ref' AND path = 'scripts/gen.mjs';
       DELETE FROM unresolved;
       UPDATE chunks SET body = body || char(10) || 'Reserve first, then charge.' WHERE source = 'doc';
       UPDATE meta SET value = '"golden02"' WHERE key = 'build_id';`,
  `UPDATE items SET title = '크레딧 예약 순서 (정리)', updated_at = '2026-11-16T01:00:00Z' WHERE ptr = 'issue:45';
       UPDATE items SET detail_for = '2026-11-16T01:00:00Z' WHERE ptr = 'pr:1121';
       UPDATE refs SET status = 'linked', reason = NULL, resolved = '["pr:12"]', resolved_build = 'golden02' WHERE ptr = 'ic:8';
       UPDATE refs SET resolved_build = 'golden02' WHERE ptr = 'pr:1121';
       UPDATE sync_state SET cursor = '2026-11-16T01:00:00Z', last_ok_at = '2026-11-16T01:01:00Z';`],
  [3, `INSERT INTO nodes SELECT * FROM o.nodes WHERE key = 'src/ui/Meter.tsx#displayName';
       DELETE FROM edges WHERE kind = 'call' AND path = 'app/dash/page.tsx' AND line = 6;
       UPDATE meta SET value = '"golden03"' WHERE key = 'build_id';`,
  `DELETE FROM items WHERE ptr = 'ic:8';
       DELETE FROM refs WHERE ptr = 'ic:8';
       UPDATE sync_state SET cursor = '2026-11-16T02:00:00Z';`],
  [4, `UPDATE chunks SET body = (SELECT x.body FROM o.chunks x WHERE x.id = chunks.id) WHERE source = 'doc';
       UPDATE nodes SET line = line + 1, end_line = end_line + 1 WHERE key IN ('src/lib/credits.ts#Plan@variable', 'src/lib/credits.ts#reserve');
       UPDATE meta SET value = '"golden04"' WHERE key = 'build_id';`,
  `INSERT INTO items (id, ptr, kind, parent_number, author, body, url, created_at, updated_at) VALUES (11, 'ic:11', 'issue_comment', 45,
         'erin', '다시 #12 참고', 'https://github.com/o/r/issues/45#issuecomment-11', '2026-11-16T03:00:00Z', '2026-11-16T03:00:00Z');
       INSERT INTO refs (ptr, kind, target, origin, status) VALUES ('ic:11', 'item', 'pr:12', 'text', 'pending');
       UPDATE sync_state SET cursor = '2026-11-16T03:00:00Z';`],
];

let r1Stores = null, gha = 100;
function edit(prev, name, codeSql, ghSql) {
  const codeDb = join(work, `${name}.db`), ghDb = githubDbPath(codeDb);
  copyFileSync(prev.codeDb, codeDb); copyFileSync(prev.ghDb, ghDb);
  for (const [file, orig, sql] of [[codeDb, r1Stores.codeDb, codeSql], [ghDb, r1Stores.ghDb, ghSql]]) {
    const db = new DatabaseSync(file);
    try { db.exec(`ATTACH '${orig}' AS o`); db.exec(sql); } finally { db.close(); }
  }
  return { codeDb, ghDb };
}

// setup once, awaited by every test: root-level before() hooks run concurrently (Node 25), so a second before() next
// to useBranch's would start before the branch exists
let setup = null;
const ready = () => (setup ??= publishRuns());
async function publishRuns() {
  await b.migrate();
  await b.seed();
  r1Stores = buildStores();
  runs[1] = { ...goldenState(r1Stores.codeDb, r1Stores.ghDb), run: 1 };
  const w = await b.connect('writer');
  try {
    let prev = r1Stores;
    for (const [n, codeSql, ghSql] of EDITS) {
      prev = edit(prev, `r${n}`, codeSql, ghSql);
      const { run, state } = await writeRun(w, runs[n - 1], goldenState(prev.codeDb, prev.ghDb), { gha: gha++ });
      assert.equal(run, n);
      runs[n] = state;
    }
  } finally { await w.end(); }
}

const ANY = C.validateManifest({ map: 'full', docs: 'full', commits: 'append', github: 'full' });
/** the code-shaped part of a state, as text */
const codeText = (s) => expectedText({ ...s, items: new Map([...s.items].filter(([, i]) => i.origin === 'repo')), ref_link: new Map(), sync: { github: null } });
/** the search tables agree with their rows: chunks_fts / chunks_tri against chunks (external content), items_fts /
 * items_tri hold title / body of every item (as gh-sync writes them). Snapshot and checksum do not read them. */
function ftsOk(m) {
  for (const [file, tables] of [[m.codeDb, ['chunks_fts', 'chunks_tri']], [m.githubDb, ['items_fts', 'items_tri']]]) {
    if (!file) continue;
    const copy = join(work, `fts-check-${process.hrtime.bigint()}.db`);        // the check needs a writable handle
    copyFileSync(file, copy);
    const db = new DatabaseSync(copy);
    try { for (const t of tables) db.exec(`INSERT INTO ${t} (${t}, rank) VALUES ('integrity-check', 1)`); }
    finally { db.close(); rmSync(copy); }
  }
  if (!m.githubDb) return;
  const g = new DatabaseSync(m.githubDb, { readOnly: true });
  try {
    const want = g.prepare("SELECT id, coalesce(title, '') AS title, coalesce(body, '') AS body FROM items ORDER BY id").all();
    for (const t of ['items_fts', 'items_tri']) assert.deepEqual(g.prepare(`SELECT rowid AS id, title, body FROM ${t} ORDER BY rowid`).all(), want, t);
  } finally { g.close(); }
}
/** what the search tables find for terms that come and go in r2..r4 */
function hits(m) {
  const c = new DatabaseSync(m.codeDb, { readOnly: true }), g = new DatabaseSync(m.githubDb, { readOnly: true });
  try {
    const chunk = (t, q) => c.prepare(`SELECT c.path FROM ${t} f JOIN chunks c ON c.id = f.rowid WHERE ${t} MATCH ? ORDER BY c.id`).all(q).map((r) => r.path);
    const item = (t, q) => g.prepare(`SELECT i.ptr FROM ${t} f JOIN items i ON i.id = f.rowid WHERE ${t} MATCH ? ORDER BY i.id`).all(q).map((r) => r.ptr);
    return { 'then charge': chunk('chunks_fts', '"then charge"'), 'first, then': chunk('chunks_tri', '"first, then"'),
      '(정리)': item('items_tri', '"(정리)"'), '실행': item('items_fts', '실행'), '참고': item('items_fts', '참고') };
  } finally { c.close(); g.close(); }
}
const HITS = {
  1: { 'then charge': [], 'first, then': [], '(정리)': [], '실행': ['ic:8'], '참고': [] },
  2: { 'then charge': ['docs/credits.md'], 'first, then': ['docs/credits.md'], '(정리)': ['issue:45'], '실행': ['ic:8'], '참고': [] },
  3: { 'then charge': ['docs/credits.md'], 'first, then': ['docs/credits.md'], '(정리)': ['issue:45'], '실행': [], '참고': [] },
  4: { 'then charge': [], 'first, then': [], '(정리)': ['issue:45'], '실행': [], '참고': ['ic:11'] },
};

/** the mirror holds exactly state (domain content: what snapshot and the golden reading see), its search tables too */
function same(m, state, shapes) {
  ftsOk(m);
  const snap = snapshot({ codeDb: m.codeDb, githubDb: m.githubDb, manifest: ANY });
  assert.equal(snap.run, state.run, 'meta brain_run');
  assert.deepEqual(C.checksum(snap, shapes), C.checksum(state, shapes));
  if (shapes.includes('github')) {
    assert.equal(expectedText(snap), expectedText(state), 'snapshot(mirror) = the server state');
    assert.equal(expectedText(goldenState(m.codeDb, m.githubDb)), expectedText(state), 'golden reading of the mirror = the server state');
  } else {
    assert.equal(m.githubDb, null);
    assert.equal(codeText(snap), codeText(state));
  }
}
const files = (dir) => readdirSync(dir).sort();
const hashOf = (dir) => Object.fromEntries(files(dir).map((f) => [f, createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')]));
const mode = (f) => (statSync(f).mode & 0o777).toString(8);
function pull(o) {
  const logs = [];
  return pullMirror({ log: (s) => logs.push(s), ...o }).then((r) => ({ ...r, logs }));
}

test('V17: a full pull of run 1 is the golden state; files 0600 in a 0700 directory, nothing else left', { skip }, async () => {
  await ready();
  const dir = join(work, 'a');
  const m = await pull({ url: b.writerUrl, dir, run: 1, shapes: BOTH });
  assert.equal(m.run, 1);
  assert.equal(m.codeDb, join(dir, MIRROR_DB));
  assert.equal(m.githubDb, githubDbPath(m.codeDb));
  same(m, runs[1], BOTH);
  assert.deepEqual(hits(m), HITS[1]);
  const snap = snapshot({ codeDb: m.codeDb, githubDb: m.githubDb, manifest: ANY });
  assert.equal(expectedText(snap), readFileSync(EXPECTED, 'utf8'), 'SQLite -> server -> mirror -> snapshot is the committed golden, byte for byte');
  assert.deepEqual(files(dir), ['brain.db', 'brain.github.db']);
  assert.deepEqual([mode(m.codeDb), mode(m.githubDb), mode(dir)], ['600', '600', '700']);
  assert.equal((await pull({ url: b.writerUrl, dir, run: 1, shapes: BOTH })).logs.at(-1), 'mirror already at run 1');
});

test('V17: delta r1 -> r2 equals a full pull of r2 and sends fewer bytes; r2 -> r3 -> r4 step by step', { skip }, async () => {
  await ready();
  const dir = join(work, 'a');                              // at run 1 (the test above)
  const d = await pull({ url: b.writerUrl, dir, run: 2, shapes: BOTH });
  assert.match(d.logs.join('\n'), /run 1 -> 2 \(delta\)/);
  same(d, runs[2], BOTH);
  assert.deepEqual(hits(d), HITS[2], 'search after the delta: added text found');
  const f = await pull({ url: b.writerUrl, dir: join(work, 'b'), run: 2, shapes: BOTH });
  assert.match(f.logs.join('\n'), /run 2 \(full\)/);
  same(f, runs[2], BOTH);
  assert.ok(d.bytes < f.bytes, `delta ${d.bytes} bytes < full ${f.bytes} bytes`);
  for (const n of [3, 4]) {
    const s = await pull({ url: b.writerUrl, dir, run: n, shapes: BOTH });
    assert.match(s.logs.join('\n'), new RegExp(`run ${n - 1} -> ${n} \\(delta\\)`));
    same(s, runs[n], BOTH);
    assert.deepEqual(hits(s), HITS[n], `search at run ${n}: removed text gone, replaced text found`);
  }
  assert.deepEqual(files(dir), ['brain.db', 'brain.github.db']);
});

test('V17: r1 -> r4 in one delta (reserve changed twice, an edge opened in r2 and closed in r3, a node closed and reopened, a doc text that came back) equals a full pull of r4', { skip }, async () => {
  await ready();
  const dir = join(work, 'c');
  await pull({ url: b.writerUrl, dir, run: 1, shapes: BOTH });
  const d = await pull({ url: b.writerUrl, dir, shapes: BOTH });               // latest
  assert.equal(d.run, 4);
  assert.match(d.logs.join('\n'), /run 1 -> 4 \(delta\)/);
  same(d, runs[4], BOTH);
  assert.deepEqual(hits(d), HITS[4]);
  same(await pull({ url: b.writerUrl, dir: join(work, 'd'), run: 4, shapes: BOTH }), runs[4], BOTH);
});

test('V17: the code shape through the reader (pooled, read-only): no github file, meta.repo from the checkout', { skip }, async () => {
  await ready();
  const dir = join(work, 'e');
  const m = await pull({ url: b.readerUrl, dir, run: 2, shapes: CODE, repo: work });
  same(m, runs[2], CODE);
  assert.deepEqual(files(dir), ['brain.db']);
  const db = new DatabaseSync(m.codeDb, { readOnly: true });
  try {
    const meta = Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map((r) => [r.key, JSON.parse(r.value)]));
    assert.equal(meta.repo, work);
    assert.equal(meta.brain_run, 2);
    assert.equal(meta.worktree, undefined);
    assert.deepEqual(meta.brain_checksum, (await b.query('owner', 'SELECT checksum FROM brain.run WHERE run_id = 2')).rows[0].checksum);
  } finally { db.close(); }
  const d = await pull({ url: b.readerUrl, dir, run: 4, shapes: CODE, repo: work });
  assert.match(d.logs.join('\n'), /run 2 -> 4 \(delta\)/);
  same(d, runs[4], CODE);
  await assert.rejects(pull({ url: b.readerUrl, dir, shapes: ['github'] }), { code: 'usage' });
});

test('V18: a pull killed mid-way leaves the old mirror as it was; the next pull removes its temporary files', { skip }, async () => {
  await ready();
  const dir = join(work, 'f');
  await pull({ url: b.writerUrl, dir, run: 1, shapes: BOTH });
  const old = hashOf(dir);
  const proxy = await startProxy(b.writerUrl);
  try {
    proxy.when(/FROM brain\.node_rev r JOIN brain\.node n/, { delayMs: 20000 });
    const matched = new Promise((res) => proxy.once('match', res));
    const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e',
      `import { pullMirror } from ${JSON.stringify(new URL('../../src/pg/mirror.mjs', import.meta.url).href)};
       await pullMirror({ url: process.env.MIRROR_URL, dir: process.env.MIRROR_DIR, run: 2, shapes: ['code', 'github'] });
       console.log('finished');`],
    { env: { ...process.env, MIRROR_URL: proxy.url(b.writerUrl), MIRROR_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const exited = new Promise((res) => child.on('exit', (code, signal) => res(signal)));
    await matched;
    for (let i = 0; i < 50 && !files(dir).some((f) => f.startsWith('.pull-')); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(files(dir).some((f) => f.startsWith(`.pull-${child.pid}-`)), `temporary copy while the pull runs: ${files(dir)}`);
    child.kill('SIGKILL');
    assert.equal(await exited, 'SIGKILL');
    assert.equal(out, '');
    const left = hashOf(dir);
    assert.ok(Object.keys(left).some((f) => f.startsWith('.pull-')), 'the killed pull left its temporary files');
    for (const f of ['brain.db', 'brain.github.db']) assert.equal(left[f], old[f], `${f} unchanged`);
  } finally { await proxy.close(); }
  same(await pull({ url: b.writerUrl, dir, run: 2, shapes: BOTH }), runs[2], BOTH);
  assert.deepEqual(files(dir), ['brain.db', 'brain.github.db'], 'leftovers of the dead pull swept');
});

test('V18: a mirror changed in place is pulled again in full (code shape: by the checksum after the delta; CI: before it)', { skip }, async () => {
  await ready();
  const poke = (file, sql) => { const db = new DatabaseSync(file); try { db.exec(sql); } finally { db.close(); } };
  const code = join(work, 'g');
  await pull({ url: b.readerUrl, dir: code, run: 2, shapes: CODE });
  poke(join(code, MIRROR_DB), "UPDATE nodes SET line = 99 WHERE key = 'src/lib/charge.ts#charge'");
  const c = await pull({ url: b.readerUrl, dir: code, run: 3, shapes: CODE });
  assert.match(c.logs.join('\n'), /delta 2 -> 3: run 3 checksum differs \(node\); pulling the full run/);
  same(c, runs[3], CODE);

  const ci = join(work, 'h');
  await pull({ url: b.writerUrl, dir: ci, run: 2, shapes: BOTH });
  poke(githubDbPath(join(ci, MIRROR_DB)), "UPDATE items SET title = 'edited here' WHERE ptr = 'pr:1121'");
  const g = await pull({ url: b.writerUrl, dir: ci, run: 3, shapes: BOTH });
  assert.match(g.logs.join('\n'), /the mirror at run 2 is not that run \(item\.github, ref_link\); pulling the full run/);
  same(g, runs[3], BOTH);
  assert.deepEqual(files(ci), ['brain.db', 'brain.github.db']);

  // a pull killed between its two renames: github.db of run 4 next to brain.db of run 3. CI asks for run 3 again
  copyFileSync(githubDbPath(join(work, 'a', MIRROR_DB)), githubDbPath(join(ci, MIRROR_DB)));
  const mixed = await pull({ url: b.writerUrl, dir: ci, run: 3, shapes: BOTH });
  assert.match(mixed.logs.join('\n'), /mirror at run 3 is not that run \(item\.github, ref_link, sync\.github\); pulling the full run/);
  same(mixed, runs[3], BOTH);
  assert.equal((await pull({ url: b.writerUrl, dir: ci, run: 3, shapes: BOTH })).logs.at(-1), 'mirror already at run 3');
});

test('V18: the connection lost at COMMIT (after every read): the pull fails and the old mirror is not replaced', { skip }, async () => {
  await ready();
  const dir = join(work, 'j');
  await pull({ url: b.writerUrl, dir, run: 1, shapes: BOTH });
  const old = hashOf(dir);
  const proxy = await startProxy(b.writerUrl);
  try {
    proxy.when(/^COMMIT/, { cut: true });
    await assert.rejects(pull({ url: proxy.url(b.writerUrl), dir, run: 2, shapes: BOTH }), (e) => e.code !== 'mirror-checksum');
  } finally { await proxy.close(); }
  assert.deepEqual(hashOf(dir), old, 'old mirror byte for byte, no temporary files');
});

test('V18: a run whose stored checksum is wrong is refused (mirror-checksum); the old mirror stays, a new one is not made', { skip }, async () => {
  await ready();
  const dir = join(work, 'c');                              // at run 4
  const old = hashOf(dir);
  const w = await b.connect('writer');
  try {
    const { run } = await writeRun(w, runs[4], { ...runs[4], run: null }, { gha: gha++, checksum: C.checksum(runs[1]) });
    assert.equal(run, 5);
  } finally { await w.end(); }
  await assert.rejects(pull({ url: b.writerUrl, dir, shapes: BOTH }), { code: 'mirror-checksum', message: /run 5 checksum differs/ });
  assert.deepEqual(hashOf(dir), old, 'old mirror byte for byte');
  const fresh = join(work, 'i');
  await assert.rejects(pull({ url: b.readerUrl, dir: fresh, shapes: CODE }), { code: 'mirror-checksum' });
  assert.deepEqual(existsSync(fresh) ? files(fresh) : [], [], 'no partial mirror');
});

test('pullMirror errors carry no URL or password (a refused connection, an unparsable URL)', async () => {
  const pw = 'Mirror' + 'Sentinel' + '7q_Z';
  for (const url of [`postgresql://u:${pw}@127.0.0.1:1/db?connect_timeout=5`, `postgresql://u:${pw}@[not-a-host/db`]) {
    const e = await pullMirror({ url, dir: join(work, 'k'), shapes: CODE }).then(() => null, (x) => x);
    assert.ok(e, 'rejected');
    for (const text of [e.message, String(e.stack), JSON.stringify(e)]) assert.ok(!text.includes(pw), text.split(pw).join('<pw>'));
  }
});
