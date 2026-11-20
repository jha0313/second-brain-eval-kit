// Answers must not depend on rowids. A mirror's rows carry the server's ids, so a tie that SQLite breaks by rowid comes
// out in another order than in the local build (§7.2 parity). A copy of the built fixture with every id reversed (nodes,
// chunks, the rowids of edges and links) must answer the map and memory queries exactly as the original, order included.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { parity, runQuery } from './parity.mjs';
import * as T from './ties.mjs';
import { fixtureRepo, makeGithubDb } from '../phase1/helpers.mjs';
import { openContext } from '../../src/context.mjs';
import { githubDbPath } from '../../src/gh-schema.mjs';
import { core } from '../../src/store/sqlite.mjs';
import { search } from '../../src/read.mjs';

delete process.env.BRAIN_READER_URL;                                     // the fixture build runs in local mode

const SHY = '\u00ad';                                               // a soft hyphen: localeCompare finds a<SHY>b.ts equal to ab.ts
const TIES = {
  'src/tie/methods.ts': 'export class A { runTask() {} }; export class B { runTask() {} }\n',   // alike but for their key
  'src/tie/a.ts': 'export {};\n',
  'src/tie/b.ts': "import './a'; export * from './a';\n",                // two module edges at one site
  'src/tie/ab.ts': 'export const x = 1;\n',
  [`src/tie/a${SHY}b.ts`]: 'export const y = 2;\n',
  'src/tie/root.ts': `import { x } from './ab';\nimport { y } from './a${SHY}b';\nexport const z = x + y;\n`,
  'src/tie/start/a.ts': "import { x } from '../ab';\n",                  // a directory whose files pull in the look-alikes
  'src/tie/start/b.ts': `import { y } from '../a${SHY}b';\n`,
};

function reverseIds(file) {
  const db = new DatabaseSync(file);
  const n = db.prepare('SELECT max(id) + 1 AS m FROM nodes').get().m, c = db.prepare('SELECT max(id) + 1 AS m FROM chunks').get().m;
  db.exec(`BEGIN;
    UPDATE nodes SET id = -id; UPDATE nodes SET id = ${n} + id, parent = ${n} - parent;
    UPDATE chunks SET id = -id; UPDATE chunks SET id = ${c} + id;
    UPDATE edges SET src = ${n} - src, dst = ${n} - dst;
    UPDATE links SET node = ${n} - node, chunk = ${c} - chunk;
    CREATE TEMP TABLE e AS SELECT * FROM edges ORDER BY rowid DESC; DELETE FROM edges; INSERT INTO edges SELECT * FROM e ORDER BY rowid;
    CREATE TEMP TABLE l AS SELECT * FROM links ORDER BY rowid DESC; DELETE FROM links; INSERT INTO links SELECT * FROM l ORDER BY rowid;
    INSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild'); INSERT INTO chunks_tri(chunks_tri) VALUES ('rebuild');
    COMMIT; ANALYZE;`);
  return db;
}

test('a copy of the fixture with every id reversed answers every query as the original, order included', async () => {
  const { repo, codeDb } = fixtureRepo({ extraFiles: TIES });
  const b = join(repo, '..', `${repo.split('/').pop()}-reversed.db`);
  copyFileSync(codeDb, b);
  const rb = reverseIds(b), ra = new DatabaseSync(codeDb, { readOnly: true });

  // the copy holds the same rows, and the ties SQLite used to break by rowid now come out reversed
  for (const t of ['nodes', 'edges', 'chunks', 'links']) assert.equal(rb.prepare(`SELECT count(*) AS n FROM ${t}`).get().n, ra.prepare(`SELECT count(*) AS n FROM ${t}`).get().n, t);
  const raw = (db, sql, ...args) => db.prepare(sql).all(...args).map((r) => Object.values(r).join(' '));
  const reversed = (sql, ...args) => {
    const x = raw(ra, sql, ...args), y = raw(rb, sql, ...args);
    assert.deepEqual([...y].sort(), [...x].sort(), sql);
    return x.length > 1 && x.join() !== y.join();
  };
  const linksOf = `SELECT n.key, l.kind FROM links l JOIN nodes n ON n.id = l.node WHERE l.chunk = (SELECT id FROM chunks WHERE title = ?)`;
  assert.ok(raw(ra, 'SELECT title FROM chunks').some((t) => reversed(linksOf, t)), 'a citation\'s links come out in another order');
  assert.ok(reversed('SELECT key FROM nodes WHERE name = ?', 'displayName'), 'same-name symbols come out in another order');
  assert.ok(reversed(`SELECT key FROM nodes WHERE name = 'runTask' AND path = 'src/tie/methods.ts'`), 'two methods on one line');
  assert.equal(new Set(raw(ra, `SELECT path, line, kind, name FROM nodes WHERE name = 'runTask'`)).size, 1, 'that differ only in their key');
  // two edges into a.ts at one site: only the new terms order them (SQLite happens to walk edges_dst by kind; no rowid
  // order to reverse here, so this case checks the order, not the old failure)
  const site = `SELECT e.path, e.line, e.col FROM edges e JOIN nodes d ON d.id = e.dst WHERE d.key = 'src/tie/a.ts'`;
  assert.deepEqual(raw(ra, site), ['src/tie/b.ts 1 0', 'src/tie/b.ts 1 0'], 'two edges into a.ts at one site');
  assert.ok(reversed(`SELECT d.path FROM edges e JOIN nodes s ON s.id = e.src JOIN nodes d ON d.id = e.dst WHERE s.key = 'src/tie/root.ts' AND e.kind = 'imports'`), 'root.ts imports come out in another order');
  assert.equal('src/tie/ab.ts'.localeCompare(`src/tie/a${SHY}b.ts`), 0, 'and the CLI\'s locale sort cannot order them');
  assert.ok(reversed(`SELECT path FROM nodes WHERE kind = 'file' AND path LIKE 'src/tie/start/%'`), 'a directory\'s files come out in another order');
  ra.close();
  rb.close();

  const queries = [['why', 'why do we reserve credits first'], ['why', 'credits'], ['why', '#12'],
    ['find', 'displayName'], ['find', 'Plan'], ['find', 'credit'], ['find', 'Meter'], ['find', 'runTask'], ['find', 'runTask', '--limit', '1'],
    ['refs', 'displayName'], ['refs', 'src/lib/credits.ts#Plan'], ['callers', 'displayName'], ['refs', 'runTask'], ['refs', 'src/tie/methods.ts#runTask'],
    ['refs', 'src/tie/a.ts'], ['refs', 'src/tie/a.ts', '--limit', '1'],
    ['impact', 'src/lib/credits.ts'], ['deps', 'src/lib/credits.ts'], ['deps', 'src/tie/root.ts'], ['deps', 'src/tie/start'], ['shared', 'src/lib', 'src/ui']];
  const r = await parity({ a: codeDb, b, repo, queries, jobs: 2 });
  assert.deepEqual(r.summary, { same: queries.length, order: 0, differs: 0 },
    JSON.stringify(r.results.filter((x) => x.class !== 'same').map((x) => ({ query: x.query, class: x.class, diffs: x.diffs }))));
  assert.deepEqual(r.results.map((x) => x.exit), [0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 2, 2, 2, 0, 0, 0, 0, 0, 0, 0],
    `each query answers; ambiguous names list their candidates: ${JSON.stringify(r.results.map((x) => [x.query.join(' '), x.exit]))}`);
  const json = async (q) => (await runQuery(codeDb, repo, q)).json;
  assert.deepEqual((await json(queries[15])).sites.map((s) => s.kind), ['imports'], 'refs a.ts --limit 1: imports before reexports');
  assert.equal((await json(queries[18])).files.length, 2, 'deps of root.ts: both look-alike files');
  assert.deepEqual((await json(queries[19])).files.map((f) => f.path), ['src/tie/ab.ts', `src/tie/a${SHY}b.ts`], 'deps of the directory: in the order of its files');
});

// search lists (sqlite.mjs): three docs that link to src/lib/credits.ts and match 예약 (the fixture's docs have no date).
// tie-a and tie-b match outside their titles: they tie in the 예약 list (title match, date) and in the linked chunks
// (date), and the content key orders them; tie-z matches in its title, so it comes first in the 예약 list and last in
// the linked chunks. tie-a and tie-z have the same bm25 in chunks_fts for src/lib/credits.ts (an exact tie: the fixture
// is small, so every idf is the 1e-6 floor), and the content key orders them there too
const KO = { 'docs/tie-b.md': '# 메모\n\n예약 순서는 src/lib/credits.ts 에 있다.\n', 'docs/tie-a.md': '# 메모\n\n예약은 실행 전에 한다: src/lib/credits.ts 참고, 그 뒤에 정산.\n',
  'docs/tie-z.md': '# 예약 안내\n\n실행하기 전에 src/lib/credits.ts 의 reserve 를 부른다.\n' };

test('search: a copy with every id reversed gives the same lists and results (a short Korean term, a name\'s linked chunks)', () => {
  const { repo, codeDb } = fixtureRepo({ extraFiles: KO });
  const b = join(repo, '..', `${repo.split('/').pop()}-reversed.db`);
  copyFileSync(codeDb, b);
  reverseIds(b).close();
  const ca = openContext({ codeDbPath: codeDb }), cb = openContext({ codeDbPath: b });
  try {
    const paths = (ctx, name, q) => {
      const l = core.candidates(ctx, q, {}).lists.find((x) => x.name === name);
      return l.rows.map((r) => ctx.code.prepare('SELECT path FROM chunks WHERE id = ?').get(Number(r.key.slice(1))).path);
    };
    const TIE = ['docs/tie-a.md', 'docs/tie-b.md', 'docs/tie-z.md'];
    for (const [name, q, want] of [['chunks_tri', '예약', ['docs/tie-z.md', 'docs/tie-a.md', 'docs/tie-b.md']], ['chunks_links', 'src/lib/credits.ts', TIE],
      ['chunks_fts', 'src/lib/credits.ts', ['docs/tie-b.md', 'docs/tie-a.md', 'docs/tie-z.md']]]) {
      const x = paths(ca, name, q);
      assert.deepEqual(x.filter((p) => TIE.includes(p)), want, `${name}: ${x.join(' ')}`);
      assert.deepEqual(paths(cb, name, q), x, name);
    }
    for (const q of ['예약', 'src/lib/credits.ts', '예약 순서', 'credits.ts']) assert.deepEqual(search(cb, q, { limit: 50 }), search(ca, q, { limit: 50 }), q);
  } finally { ca.close(); cb.close(); }
});

// github.db items ids reversed (their FTS rows follow: rowid = id)
function reverseItemIds(file) {
  const db = new DatabaseSync(file);
  const n = db.prepare('SELECT max(id) + 1 AS m FROM items').get().m;
  db.exec(`BEGIN; UPDATE items SET id = -id; UPDATE items SET id = ${n} + id;
    DELETE FROM items_fts; INSERT INTO items_fts(rowid, title, body) SELECT id, coalesce(title, ''), coalesce(body, '') FROM items;
    DELETE FROM items_tri; INSERT INTO items_tri(rowid, title, body) SELECT id, coalesce(title, ''), coalesce(body, '') FROM items; COMMIT;`);
  db.close();
}

// search ties (test/pg/ties.mjs): groups with one final score and one date come in the order of their content on the
// build (ids planted against it) and on a copy with every chunk and item id reversed; a vault note sorts as vault:<path>
test('search: groups that tie on score and date come in one order by content, whatever the ids (commits, docs, items, a child-only PR, vault)', () => {
  const { repo, codeDb } = fixtureRepo();
  makeGithubDb(codeDb);
  for (const [file, sql] of [[codeDb, T.codeSql([T.VAULT.chunk])], [githubDbPath(codeDb), T.ghSql()]]) { const db = new DatabaseSync(file); db.exec(sql); db.close(); }
  const b = join(repo, '..', `${repo.split('/').pop()}-reversed.db`);
  copyFileSync(codeDb, b);
  copyFileSync(githubDbPath(codeDb), githubDbPath(b));
  reverseIds(b).close();
  reverseItemIds(githubDbPath(b));
  const ca = openContext({ codeDbPath: codeDb }), cb = openContext({ codeDbPath: b });
  try {
    // the ids run against the order on the build, along it on the copy
    const ids = (ctx) => [...T.ID_ORDER.items, ...T.ID_ORDER.children].map((p) => ctx.gh.prepare('SELECT id FROM items WHERE ptr = ?').get(p).id)
      .concat(T.ID_ORDER.chunks.map((t) => ctx.code.prepare('SELECT id FROM chunks WHERE body = ?').get(t).id));
    const falling = (xs) => xs.every((x, i) => i === 0 || x < xs[i - 1]);
    const [ia, ib] = [ids(ca), ids(cb)];
    assert.ok([ia.slice(0, 3), ia.slice(3, 7), ia.slice(7)].every(falling), `build ids ${ia}`);
    assert.ok([ib.slice(0, 3), ib.slice(3, 7), ib.slice(7)].every((xs) => falling([...xs].reverse())), `copy ids ${ib}`);
    const want = [...T.PAGE, T.VAULT_ROW];
    for (const [ctx, q] of [[ca, T.VAULT.query], [cb, T.VAULT.query], [ca, `${T.QUERY_BACK} 고추`], [cb, `${T.QUERY_BACK} 고추`]]) {
      const r = search(ctx, q, { limit: 50 });
      assert.deepEqual([r.rows.map(T.rowOf), r.total, r.next], [want, 23, null], q);
      // one row a page (each tied pair split), and pages of 5
      assert.deepEqual(want.map((_, cursor) => search(ctx, q, { limit: 1, cursor }).rows.map(T.rowOf)), want.map((x) => [x]), q);
      const pages = [0, 5, 10, 15].map((cursor) => search(ctx, q, { limit: 5, cursor }));
      assert.deepEqual(pages.flatMap((p) => p.rows.map(T.rowOf)), want, q);
      assert.deepEqual(pages.map((p) => p.next), [5, 10, 15, null], q);
    }
  } finally { ca.close(); cb.close(); }
});
