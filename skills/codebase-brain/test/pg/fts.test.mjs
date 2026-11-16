// sql/003_brain_english.sql: server full-text search keeps stop words, as SQLite FTS5 does. On a Neon branch: the
// golden seed (run 1) and a run 2 whose doc gains "No further changes: more of the same." Taken back to the 001 tsv
// (english), a search made only of stop words finds nothing on the server; migrate then applies 003 onto those rows,
// and the same search finds the chunk, as the SQLite store does on a mirror of the run. 003 changes no row (the dump
// without tsv is the same), no trigger and no brain function; rows are still never overwritten; run 3 publishes.
// The Neon tests need NEON_PROJECT_ID; they are skipped without it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
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
import { search, searchIn } from '../../src/read.mjs';

const skip = neonSkip();
const b = useBranch('fts');
const work = mkdtempSync(join(tmpdir(), 'brain-fts-'));
after(() => rmSync(work, { recursive: true, force: true }));
const Q = 'further more same';                                     // stop words to Postgres english, words to FTS5
const SHA = (c) => `aaaaaaa${c}${'0'.repeat(32)}`;
const meta = (build, commit) => `UPDATE meta SET value = '"${build}"' WHERE key = 'build_id'; UPDATE meta SET value = '"${commit}"' WHERE key = 'commit';`;
const relink = (from, to) => `UPDATE refs SET resolved_build = '${to}' WHERE resolved_build = '${from}';`;
const R2 = { n: 2, code: `UPDATE chunks SET body = body || char(10) || 'No further changes: more of the same.' WHERE source = 'doc'; ${meta('golden02', SHA(1))}`,
  gh: relink('golden00', 'golden02') };
const R3 = { n: 3, code: `UPDATE chunks SET body = body || char(10) || 'Once again, all of it.' WHERE source = 'doc'; ${meta('golden03', SHA(2))}`,
  gh: relink('golden02', 'golden03') };
// words whose stems differ between Porter's original algorithm (FTS5 porter) and Snowball english (Porter2)
const WORDS = ['dying', 'die', 'lying', 'tying', 'generously', 'generous', 'general', 'generate', 'skies', 'sky', 'cried', 'flies',
  'news', 'agreed', 'feed', 'knightly', 'happily', 'happy', 'relational', 'conditional', 'rational', 'valency', 'digitizer',
  'operator', 'feudalism', 'decisiveness', 'hopefulness', 'callousness', 'formality', 'sensitivity', 'sensibility', 'triplicate',
  'formative', 'formalize', 'electricity', 'electrical', 'hopeful', 'goodness', 'revival', 'allowance', 'inference', 'airliner',
  'gyroscopic', 'adjustable', 'defensible', 'irritant', 'replacement', 'adjustment', 'dependent', 'adoption', 'homologou',
  'communism', 'activate', 'angularity', 'homologous', 'effective', 'bowdlerize', 'probate', 'rate', 'cease', 'controll', 'roll',
  'caresses', 'ponies', 'ties', 'caress', 'cats', 'plastered', 'motoring', 'sing', 'conflated', 'troubled', 'sized', 'hopping',
  'tanned', 'falling', 'hissing', 'fizzed', 'failing', 'filing', 'reserve', 'reserved', 'reserving', 'credits', 'charges',
  'charged', 'further', 'more', 'same', 'once', 'again', 'because', 'before', 'any'];
function ftsStems(words) {                                         // the terms FTS5 stores, with db.mjs's tokenizer
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE VIRTUAL TABLE t USING fts5(x, tokenize = "porter unicode61 tokenchars '_'"); CREATE VIRTUAL TABLE v USING fts5vocab(t, 'instance');`);
    const ins = db.prepare('INSERT INTO t (rowid, x) VALUES (?, ?)');
    words.forEach((w, i) => ins.run(i + 1, w));
    return Object.fromEntries(db.prepare('SELECT doc, term FROM v ORDER BY doc').all().map((r) => [words[r.doc - 1], r.term]));
  } finally { db.close(); }
}
// chunk.tsv as 001 made it, and no 003 in the ledger: the state of a server migrated before 003
const UNDO_003 = `DELETE FROM brain_migrate.applied WHERE name = '003_brain_english.sql';
  ALTER TABLE brain.chunk DROP COLUMN tsv;
  ALTER TABLE brain.chunk ADD COLUMN tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english'::regconfig, coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english'::regconfig, coalesce(body, '')), 'B')) STORED;
  CREATE INDEX chunk_tsv ON brain.chunk USING gin (tsv);
  DROP TEXT SEARCH CONFIGURATION brain.brain_english;
  DROP TEXT SEARCH DICTIONARY brain.porter_stem;`;
// every trigger on a brain table and every brain function body
const SCHEMA_FACTS = `SELECT
  (SELECT string_agg(pg_get_triggerdef(t.oid), E'\\n' ORDER BY c.relname, t.tgname) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'brain' AND NOT t.tgisinternal) AS triggers,
  (SELECT string_agg(p.proname || ' ' || md5(p.prosrc), E'\\n' ORDER BY p.proname) FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'brain') AS functions`;

let prev = null, runs = [], setup = null;
async function publish(spec) {
  const codeDb = join(work, `r${spec.n}.db`), ghDb = githubDbPath(codeDb);
  copyFileSync(prev.codeDb, codeDb); copyFileSync(prev.ghDb, ghDb);
  for (const [file, sql] of [[codeDb, spec.code], [ghDb, spec.gh]]) {
    const db = new DatabaseSync(file);
    try { db.exec(sql); } finally { db.close(); }
  }
  prev = { codeDb, ghDb };
  const w = await b.connect('writer');
  try {
    const { run, state } = await writeRun(w, runs[spec.n - 1], goldenState(codeDb, ghDb), { gha: 400 + spec.n });
    assert.equal(run, spec.n);
    runs[spec.n] = state;
  } finally { await w.end(); }
}
const ready = () => (setup ??= (async () => {
  await b.migrate();
  await b.seed();
  prev = buildStores();
  runs[1] = { ...goldenState(prev.codeDb, prev.ghDb), run: 1 };
  await publish(R2);
})());
// the dump of schema brain with chunk.tsv left out (its value is what 003 changes)
const dumpNoTsv = async () => (await b.dump()).split('\n').map((l) => {
  if (!l.startsWith('chunk ')) return l;
  const { tsv, ...row } = JSON.parse(l.slice(6));
  return `chunk ${JSON.stringify(row)}`;
}).join('\n');
const englishHits = async () => (await b.query('reader', `SELECT count(*)::int AS n FROM brain.chunk
  WHERE tsv @@ websearch_to_tsquery('english', '"further" OR "more" OR "same"')`)).rows[0].n;
const norm = (r) => ({ ptrs: r.rows.map((x) => x.ptr.replace(/@(r\d+|[0-9a-z]{8})$/, '')).sort(), total: r.total, facts: r.facts });
const found = async (store) => (await store.candidates(Q)).lists.filter((l) => l.rows.length).map((l) => [l.name, l.rows.length]);

let before = null;
test('before 003 (the 001 tsv, english): a search made only of stop words finds nothing on the server', { skip }, async () => {
  await ready();
  await b.query('owner', UNDO_003);
  assert.equal(await englishHits(), 0);
  before = { facts: (await b.query('owner', SCHEMA_FACTS)).rows[0], dump: await dumpNoTsv() };
  assert.match(before.dump, /No further changes: more of the same/);
});

test('003 applied onto those rows: the search finds the chunk as FTS5 does; no row, trigger or guard changed', { skip }, async () => {
  assert.ok(before, 'the test before sets the 001 state up');
  assert.deepEqual((await b.migrate()).applied, ['003_brain_english.sql']);
  assert.deepEqual((await b.query('owner', SCHEMA_FACTS)).rows[0], before.facts);
  assert.equal(await dumpNoTsv(), before.dump);
  const store = pgStore(await b.connect('reader'));
  const m = await pullMirror({ url: b.readerUrl, dir: join(work, 'mirror'), shapes: ['code', 'github'] });
  const ctx = openContext({ codeDbPath: m.codeDb });
  try {
    const server = await searchIn(store, Q, { limit: 50 });
    assert.equal(server.view.run, 2);
    assert.ok(server.rows.some((r) => r.ptr === 'doc:docs/credits.md:1-6@r2'), JSON.stringify(server.rows.map((r) => r.ptr)));
    assert.deepEqual(await found(store), [['chunks_fts', 1]]);                       // by full-text search alone
    assert.deepEqual(await found(sqliteStore(ctx)), [['chunks_fts', 1]]);
    assert.deepEqual(norm(server), norm(search(ctx, Q, { limit: 50 })));
  } finally { ctx.close(); await store.close(); }
  await assert.rejects(b.query('owner', "UPDATE brain.chunk SET body = 'x'"), /brain\.chunk: UPDATE is not allowed/);
  // the run guard and the insert guards as before; a new chunk revision gets its tsv
  await publish(R3);
  const store3 = pgStore(await b.connect('reader'));
  try {
    const r = await searchIn(store3, 'once again', { limit: 50 });
    assert.equal(r.view.run, 3);
    assert.ok(r.rows.some((x) => x.ptr === 'doc:docs/credits.md:1-6@r3'), JSON.stringify(r.rows.map((x) => x.ptr)));
  } finally { await store3.close(); }
});

test('stems: the server config stems words as FTS5 porter does', { skip }, async () => {
  assert.ok(before, 'runs after 003 is applied');
  const pg = Object.fromEntries((await b.query('reader', `SELECT w, (SELECT lexeme FROM unnest(to_tsvector('brain.brain_english', w)) LIMIT 1) AS term
    FROM unnest($1::text[]) w`, [WORDS])).rows.map((r) => [r.w, r.term]));
  const fts = ftsStems(WORDS);
  const differ = WORDS.filter((w) => pg[w] !== fts[w]).map((w) => `${w}: fts5 ${fts[w]} / server ${pg[w]}`);
  assert.deepEqual(differ, []);
});
