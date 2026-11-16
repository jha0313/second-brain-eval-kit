// sql/003_brain_english.sql: server full-text search finds what SQLite FTS5 finds. On a Neon branch: the golden seed
// (run 1) and a run 2 whose doc gains stop words, identifiers and a diacritic. 003 on a fresh schema makes unaccent in
// schema brain. Taken back to the 001 tsv (english) with unaccent already installed elsewhere (public, on this
// throwaway branch), a search made only of stop words finds nothing on the server; migrate then applies 003 onto those
// rows and uses that unaccent. After each:
// stop words, identifiers (foo_bar, HEALTH_SECRET, __init__, a_b_c, oauth2_token for oauth2_tokens), parts of a host,
// a hyphenated word and a number (js / next of next.js, flight of mid-flight, 34 of 12.34) and resume (for résumé)
// find the chunk through the same candidate lists as the SQLite store on a mirror of the run, and foo / init /
// foobar / health find nothing on either; ~160 words fall into the same stem classes as FTS5's. 003 changes no row (the dump without tsv is the same),
// no trigger and no brain function it did not add; rows are still never overwritten; run 3 publishes a chunk revision
// that search finds.
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
const DOC2 = 'doc:docs/credits.md:1-6@r2';
// found by full-text search (the doc of run 2), and found by nothing (FTS5 keeps foo_bar and __init__ one token).
// resume finds résumé; a query term is ASCII only (why.mjs terms), so diacritics matter in the indexed text alone
const FOUND = [Q, 'foo_bar', 'HEALTH_SECRET', '__init__', 'a_b_c', 'oauth2_token', 'js', 'next', 'flight', '34', 'resume'];
const NOTHING = ['foo', 'init', 'foobar', 'health'];
const SHA = (c) => `aaaaaaa${c}${'0'.repeat(32)}`;
const meta = (build, commit) => `UPDATE meta SET value = '"${build}"' WHERE key = 'build_id'; UPDATE meta SET value = '"${commit}"' WHERE key = 'commit';`;
const relink = (from, to) => `UPDATE refs SET resolved_build = '${to}' WHERE resolved_build = '${from}';`;
const R2 = { n: 2, code: `UPDATE chunks SET body = body || char(10) || 'No further changes: more of the same.' || char(10) ||
    'Set HEALTH_SECRET, then call foo_bar, __init__ and a_b_c (see the résumé).' || char(10) ||
    'Deployed with next.js; oauth2_tokens rotate mid-flight, timeout 12.34 s.' WHERE source = 'doc'; ${meta('golden02', SHA(1))}`,
  gh: relink('golden00', 'golden02') };
const R3 = { n: 3, code: `UPDATE chunks SET body = body || char(10) || 'Once again, all of it.' WHERE source = 'doc'; ${meta('golden03', SHA(2))}`,
  gh: relink('golden02', 'golden03') };
// words whose stems differ between Porter's original algorithm (FTS5 porter) and Snowball english (Porter2), then
// identifiers, digits, short and long words (FTS5 leaves tokens under 3 or over 64 bytes unstemmed), words the
// encoding must keep apart (q, qj, zxz), and diacritics
const WORDS = ['dying', 'die', 'lying', 'tying', 'generously', 'generous', 'general', 'generate', 'skies', 'sky', 'cried', 'flies',
  'news', 'agreed', 'feed', 'knightly', 'happily', 'happy', 'relational', 'conditional', 'rational', 'valency', 'digitizer',
  'operator', 'feudalism', 'decisiveness', 'hopefulness', 'callousness', 'formality', 'sensitivity', 'sensibility', 'triplicate',
  'formative', 'formalize', 'electricity', 'electrical', 'hopeful', 'goodness', 'revival', 'allowance', 'inference', 'airliner',
  'gyroscopic', 'adjustable', 'defensible', 'irritant', 'replacement', 'adjustment', 'dependent', 'adoption', 'homologou',
  'communism', 'activate', 'angularity', 'homologous', 'effective', 'bowdlerize', 'probate', 'rate', 'cease', 'controll', 'roll',
  'caresses', 'ponies', 'ties', 'caress', 'cats', 'plastered', 'motoring', 'sing', 'conflated', 'troubled', 'sized', 'hopping',
  'tanned', 'falling', 'hissing', 'fizzed', 'failing', 'filing', 'reserve', 'reserved', 'reserving', 'credits', 'charges',
  'charged', 'further', 'more', 'same', 'once', 'again', 'because', 'before', 'any',
  'foo_bar', 'foobar', 'foo', 'bar', 'health_secret', 'health_secrets', 'health', 'secret', '__init__', 'init', 'a_b_c', 'abc',
  'enable_headline_standalone', 'headline', 'ts', 't', 'js', 'j', 'os', 'o', 'is', 'us', 'u',
  'oauth2_tokens', 'oauth2_token', 'v2', 'tokens2', '_query', 'qquery', 'query', 'queries', '_', '_s', 'tsqj', 'tszxz', 'tsqqj',
  'ti', 'gas', 'ga', 'go_ing', 'go_', 'iraqing', 'iraq',
  // undoubled after -ed / -ing by FTS5, not by Snowball's Porter (c h j k q v w x y, digits, '_'), when the stem has a
  // vowel (a y after the first letter is one: yykk, byy, yy); kking and ykking have none
  'trekking', 'trekkings', 'trek', 'revving', 'revved', 'rev', 'zoccing', 'zoc', 'sayying', 'say', 'foo22ing', 'foo2',
  'foo__ing', 'foo_', 'yykking', 'yyk', 'byying', 'by', 'yying', 'y', 'kking', 'kk', 'ykking', 'ykk',
  // 64 bytes (stemmed: one class with the 60-byte base), 65 bytes (passed through: apart from base + x, 61 bytes)
  `${'ab'.repeat(30)}ings`, 'ab'.repeat(30), `${'ab'.repeat(30)}xings`, `${'ab'.repeat(30)}x`,
  'résumé', 'resume', 'café', 'cafe', 'naïve', 'naive', 'sí', 'si'];
// what 003 adds to schema brain's functions: brain.fts_text, and the unaccent extension's when it makes it there
const ADDED = ['fts_text', 'unaccent', 'unaccent_init', 'unaccent_lexize'];
function ftsTerms(words) {                                         // the terms FTS5 stores per word, with db.mjs's tokenizer
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE VIRTUAL TABLE t USING fts5(x, tokenize = "porter unicode61 tokenchars '_'"); CREATE VIRTUAL TABLE v USING fts5vocab(t, 'instance');`);
    const ins = db.prepare('INSERT INTO t (rowid, x) VALUES (?, ?)');
    words.forEach((w, i) => ins.run(i + 1, w));
    return Object.fromEntries(db.prepare("SELECT doc, group_concat(term, ' ') AS t FROM v GROUP BY doc").all().map((r) => [words[r.doc - 1], r.t]));
  } finally { db.close(); }
}
// chunk.tsv as 001 made it, and no 003 in the ledger: the state of a server migrated before 003, whose database has
// unaccent already (in public)
const UNDO_003 = `DELETE FROM brain_migrate.applied WHERE name = '003_brain_english.sql';
  ALTER TABLE brain.chunk DROP COLUMN tsv;
  ALTER TABLE brain.chunk ADD COLUMN tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english'::regconfig, coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english'::regconfig, coalesce(body, '')), 'B')) STORED;
  CREATE INDEX chunk_tsv ON brain.chunk USING gin (tsv);
  DROP FUNCTION brain.fts_text(text);
  DROP TEXT SEARCH DICTIONARY brain.porter_stem;
  DROP EXTENSION unaccent;
  CREATE EXTENSION unaccent SCHEMA public;`;
// every trigger on a brain table and every brain function body but those 003 adds; and the names of those
const SCHEMA_FACTS = `SELECT
  (SELECT string_agg(pg_get_triggerdef(t.oid), E'\\n' ORDER BY c.relname, t.tgname) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'brain' AND NOT t.tgisinternal) AS triggers,
  (SELECT string_agg(p.proname || ' ' || md5(p.prosrc), E'\\n' ORDER BY p.proname) FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'brain' AND p.proname <> ALL ($1::text[])) AS functions,
  (SELECT coalesce(array_agg(DISTINCT p.proname::text ORDER BY p.proname::text), '{}'::text[]) FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'brain' AND p.proname = ANY ($1::text[])) AS added`;

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
const facts = async () => (await b.query('owner', SCHEMA_FACTS, [ADDED])).rows[0];
const englishHits = async () => (await b.query('reader', `SELECT count(*)::int AS n FROM brain.chunk
  WHERE tsv @@ websearch_to_tsquery('english', '"further" OR "more" OR "same"')`)).rows[0].n;
const norm = (r) => ({ ptrs: r.rows.map((x) => x.ptr.replace(/@(r\d+|[0-9a-z]{8})$/, '')).sort(), total: r.total, facts: r.facts });
// the non-empty candidate lists of a search, by name, with their keys (both stores use the mirror's ids)
const found = async (store, q) => (await store.candidates(q)).lists.filter((l) => l.rows.length).map((l) => [l.name, l.rows.map((r) => r.key).sort()]);

// FOUND find the run's doc through the same candidate lists in both stores; NOTHING finds nothing in either
async function searches(run) {
  const store = pgStore(await b.connect('reader'));
  const m = await pullMirror({ url: b.readerUrl, dir: join(work, `mirror-${run}`), shapes: ['code', 'github'] });
  const ctx = openContext({ codeDbPath: m.codeDb });
  try {
    for (const q of FOUND) {
      const server = await searchIn(store, q, { limit: 50 });
      assert.equal(server.view.run, run);
      assert.ok(server.rows.some((r) => r.ptr === DOC2), `${q}: ${JSON.stringify(server.rows.map((r) => r.ptr))}`);
      const lists = await found(store, q);
      assert.ok(lists.some(([name]) => name === 'chunks_fts'), `${q}: ${JSON.stringify(lists)}`);   // by full-text search
      assert.deepEqual(lists, await found(sqliteStore(ctx), q), q);
      assert.deepEqual(norm(server), norm(search(ctx, q, { limit: 50 })), q);
    }
    for (const q of NOTHING) {
      assert.deepEqual(await found(store, q), [], q);
      assert.deepEqual(await found(sqliteStore(ctx), q), [], q);
    }
    assert.deepEqual(await found(store, Q), [['chunks_fts', (await found(sqliteStore(ctx), Q))[0][1]]]);   // stop words: FTS alone
  } finally { ctx.close(); await store.close(); }
}

test('003 on a fresh schema (unaccent made in schema brain): searches find what FTS5 finds', { skip }, async () => {
  await ready();
  assert.deepEqual((await facts()).added, ADDED);
  await searches(2);
});

let before = null;
test('before 003 (the 001 tsv, english): a search made only of stop words finds nothing on the server', { skip }, async () => {
  await ready();
  await b.query('owner', UNDO_003);
  assert.equal(await englishHits(), 0);
  before = { facts: await facts(), dump: await dumpNoTsv() };
  assert.deepEqual(before.facts.added, []);
  assert.match(before.dump, /No further changes: more of the same/);
});

test('003 applied onto those rows (unaccent used in public): searches as before; no row, trigger or guard changed', { skip }, async () => {
  assert.ok(before, 'the test before sets the 001 state up');
  assert.deepEqual((await b.migrate()).applied, ['003_brain_english.sql']);
  const now = await facts();
  assert.deepEqual({ triggers: now.triggers, functions: now.functions }, { triggers: before.facts.triggers, functions: before.facts.functions });
  assert.deepEqual(now.added, ['fts_text']);                                         // unaccent stays in public
  assert.equal(await dumpNoTsv(), before.dump);
  await searches(2);
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

test('stems: ~160 words fall into the same stem classes on the server as in FTS5', { skip }, async () => {
  assert.ok(before, 'runs after 003 is applied');
  // without brain.fts_text the parser splits foo_bar and keeps next.js / 12.34 whole, and Porter cuts ts to t
  const raw = (await b.query('reader', "SELECT to_tsvector('simple', 'foo_bar next.js 12.34')::text AS v, ts_lexize('brain.porter_stem', 'ts')::text AS ts")).rows[0];
  assert.deepEqual(raw, { v: "'12.34':4 'bar':2 'foo':1 'next.js':3", ts: '{t}' });
  const pg = Object.fromEntries((await b.query('reader', `SELECT w, (SELECT string_agg(lexeme, ' ') FROM unnest(to_tsvector('simple', brain.fts_text(w)))) AS t
    FROM unnest($1::text[]) w`, [WORDS])).rows.map((r) => [r.w, r.t]));
  const fts = ftsTerms(WORDS);
  for (const w of WORDS) assert.ok(/^\S+$/.test(fts[w] ?? '') && /^\S+$/.test(pg[w] ?? ''), `${w}: one token each (fts5 ${fts[w]}, server ${pg[w]})`);
  const differ = [];
  for (let i = 0; i < WORDS.length; i++) {
    for (let j = i + 1; j < WORDS.length; j++) {
      const [x, y] = [WORDS[i], WORDS[j]], f = fts[x] === fts[y], s = pg[x] === pg[y];
      if (f !== s) differ.push(`${x} ~ ${y}: fts5 ${f ? 'one stem' : 'two'} (${fts[x]}, ${fts[y]}), server ${s ? 'one stem' : 'two'} (${pg[x]}, ${pg[y]})`);
    }
  }
  assert.deepEqual(differ, []);
});
