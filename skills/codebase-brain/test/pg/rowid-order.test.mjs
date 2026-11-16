// Answers must not depend on rowids. A mirror's rows carry the server's ids, so a tie that SQLite breaks by rowid comes
// out in another order than in the local build (§7.2 parity). A copy of the built fixture with every id reversed (nodes,
// chunks, the rowids of edges and links) must answer the map and memory queries exactly as the original, order included.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { parity, runQuery } from './parity.mjs';
import { fixtureRepo } from '../phase1/helpers.mjs';

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
