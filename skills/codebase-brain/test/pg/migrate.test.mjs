// Q1 on a Neon branch: migrate (ledger, idempotent, roles + passwords, guards, pg_trgm), V1 (no overwrite), V2 (role
// privileges, amended: the reader's large objects and ALTER ROLE on itself are recorded, not expected to fail), V14
// (Korean trigram). Needs NEON_PROJECT_ID; skipped without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { useBranch, neonSkip } from './harness.mjs';
import { migrate, migrationFiles } from '../../src/pg/migrate.mjs';
import { PUBLISH_LOCK_KEY } from '../../src/pg/contract.mjs';

const skip = neonSkip();
const b = useBranch('migrate');
const SHA = 'f'.repeat(40);
const DENIED = '42501', READ_ONLY = '25006';

/** run sql inside the open transaction of c and expect SQLSTATE code; the transaction stays usable (savepoint) */
async function refusedIn(c, sql, code = DENIED, params = []) {
  await c.query('SAVEPOINT probe');
  try {
    await assert.rejects(c.query(sql, params), (e) => { assert.equal(e.code, code, `${sql}: ${e.message}`); return true; }, sql);
  } finally { await c.query('ROLLBACK TO SAVEPOINT probe'); }
}
/** run sql on a fresh connection of who (autocommit) and expect one of the SQLSTATE codes */
async function refused(who, sql, codes = [DENIED]) {
  await assert.rejects(b.query(who, sql), (e) => { assert.ok([].concat(codes).includes(e.code), `${who}: ${sql}: ${e.code} ${e.message}`); return true; },
    `${who}: ${sql}`);
}

test('migrate: every sql file once with a ledger (two runners at once), roles log in with their defaults, a rerun applies nothing', { skip }, async () => {
  const [x, y] = await Promise.all([b.migrate(), b.migrate()]);
  assert.deepEqual([...x.applied, ...y.applied].sort(), migrationFiles(), 'each file applied by exactly one runner');
  assert.deepEqual((await b.migrate()).applied, []);
  const ledger = (await b.query('owner', 'SELECT name FROM brain_migrate.applied ORDER BY name')).rows.map((r) => r.name);
  assert.deepEqual(ledger, migrationFiles());
  const ext = (await b.query('owner', "SELECT extversion FROM pg_extension WHERE extname = 'pg_trgm'")).rows;
  assert.equal(ext.length, 1, 'pg_trgm installed (R14)');
  const guards = (await b.query('owner', `SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'brain' AND NOT t.tgisinternal`)).rows[0].n;
  assert.ok(guards >= 14 * 2, `guard triggers present (${guards})`);

  const w = (await b.query('writer', 'SELECT current_user AS u')).rows[0];
  assert.equal(w.u, 'brain_writer');
  const r = (await b.query('reader', `SELECT current_user AS u, current_setting('default_transaction_read_only') AS ro,
    current_setting('statement_timeout') AS st`)).rows[0];
  assert.deepEqual(r, { u: 'brain_reader', ro: 'on', st: '15s' });
});

test('migrate: an applied file whose text changed is refused, nothing else runs; bad inputs are refused', { skip }, async () => {
  const name = migrationFiles()[0];
  await b.query('owner', "UPDATE brain_migrate.applied SET sha256 = 'tampered' WHERE name = $1", [name]);
  try {
    await assert.rejects(b.migrate(), { code: 'migrate', message: new RegExp(`${name} was applied with different text`) });
  } finally {
    const sha = createHash('sha256').update(readFileSync(new URL(`../../sql/${name}`, import.meta.url), 'utf8')).digest('hex');
    await b.query('owner', 'UPDATE brain_migrate.applied SET sha256 = $2 WHERE name = $1', [name, sha]);
  }
  assert.deepEqual((await b.migrate()).applied, []);
  await assert.rejects(migrate({}), { code: 'usage' });
  const loose = `${b.passwordFile}.loose`;
  writeFileSync(loose, '{}');
  chmodSync(loose, 0o644);
  await assert.rejects(migrate(b.ownerUrl, { passwordFile: loose }), { code: 'usage', message: /0600/ });
  writeFileSync(loose, JSON.stringify({ neondb_owner: 'x'.repeat(20) }), { mode: 0o600 });
  chmodSync(loose, 0o600);
  await assert.rejects(migrate(b.ownerUrl, { passwordFile: loose }), { code: 'usage', message: /unknown role neondb_owner/ });
});

test('migrate: a file that fails leaves neither its changes nor its ledger row; the next run resumes', { skip }, async () => {
  const setting = async () => (await b.query('owner', `SELECT s.setconfig FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole
    WHERE r.rolname = 'brain_reader'`)).rows[0].setconfig.find((c) => c.startsWith('statement_timeout='));
  await b.query('owner', `ALTER ROLE brain_reader SET statement_timeout = '20s';
    DELETE FROM brain_migrate.applied WHERE name = '002_roles.sql';
    CREATE FUNCTION brain_migrate.fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ledger write failed'; END $$;
    CREATE TRIGGER fail BEFORE INSERT ON brain_migrate.applied FOR EACH ROW EXECUTE FUNCTION brain_migrate.fail();`);
  await assert.rejects(b.migrate(), { code: 'migrate', message: /ledger write failed/ });
  assert.equal(await setting(), 'statement_timeout=20s', '002 rolled back with its ledger row');
  assert.equal((await b.query('owner', "SELECT count(*)::int AS n FROM brain_migrate.applied WHERE name = '002_roles.sql'")).rows[0].n, 0);
  await b.query('owner', 'DROP TRIGGER fail ON brain_migrate.applied; DROP FUNCTION brain_migrate.fail();');
  assert.deepEqual((await b.migrate()).applied, ['002_roles.sql']);
  assert.equal(await setting(), 'statement_timeout=15s');
});

test('migrate: roles with more than 002 grants fail the run before any password changes; errors carry no secret', { skip }, async () => {
  const fresh = `${b.passwordFile}.rotated`;
  writeFileSync(fresh, JSON.stringify({ brain_writer: 'w'.repeat(4) + Date.now().toString(36) + 'Xq9_vT3m#Lp2', brain_reader: 'r'.repeat(4) + Date.now().toString(36) + 'Zk7_uR5n#Hs8' }), { mode: 0o600 });
  for (const [grant, want] of [['GRANT brain_writer TO brain_reader', /brain_reader: member of brain_writer/],
    ['GRANT DELETE ON brain.edge TO brain_writer', /brain_writer: table privileges edge DELETE/],
    ['GRANT UPDATE (body) ON brain.item_rev TO brain_writer', /brain_writer: column UPDATE item_rev\.body/],
    ['GRANT TEMPORARY ON DATABASE neondb TO brain_reader', /brain_reader: database CREATE or TEMP/]]) {
    await b.query('owner', grant);
    try {
      await assert.rejects(migrate(b.ownerUrl, { passwordFile: fresh }), { code: 'migrate', message: want }, grant);
    } finally { await b.query('owner', grant.replace(/^GRANT/, 'REVOKE').replace(/ TO /, ' FROM ')); }
    assert.equal((await b.query('writer', 'SELECT current_user AS u')).rows[0].u, 'brain_writer', 'old writer password still works');
    assert.equal((await b.query('reader', 'SELECT current_user AS u')).rows[0].u, 'brain_reader', 'old reader password still works');
  }
  assert.deepEqual((await b.migrate()).applied, []);                            // clean again, the branch passwords re-set

  const pw = new URL(b.ownerUrl).password;
  for (const call of [() => migrate(b.ownerUrl, { passwordFile: b.ownerUrl }), () => migrate(`${b.ownerUrl}&options=bad%20option`)]) {
    const e = await call().then(() => null, (x) => x);
    assert.ok(e, 'rejected');
    assert.ok(!e.message.includes(pw) && !JSON.stringify(e).includes(pw), `no password in: ${e.message.split(pw).join('<pw>')}`);
  }
});

test('seed: the golden state goes in as run 1 through the guards', { skip }, async () => {
  await b.seed();
  const r = (await b.query('reader', `SELECT (SELECT count(*)::int FROM brain.run) AS runs, (SELECT count(*)::int FROM brain.node) AS nodes,
    (SELECT status FROM brain.attempt) AS status`)).rows[0];
  assert.equal(r.runs, 1);
  assert.ok(r.nodes > 10);
  assert.equal(r.status, 'ok');
});

test('V1: the writer cannot overwrite or delete; valid_to closes once, to the run being published; the owner is guarded too', { skip }, async () => {
  for (const sql of ["UPDATE brain.item_rev SET body = 'x'", "UPDATE brain.node_rev SET name = 'x'", 'DELETE FROM brain.item_rev',
    'DELETE FROM brain.node_rev', 'DELETE FROM brain.edge', "UPDATE brain.run SET meta = '{}'", 'DELETE FROM brain.run',
    "UPDATE brain.chunk SET body = 'x'", "UPDATE brain.node SET key = 'x'", "UPDATE brain.attempt SET gha_run_id = 0"]) {
    await refused('writer', sql);
  }
  await refused('writer', 'UPDATE brain.edge SET valid_to = 1');                // no run is being published
  for (const sql of ["UPDATE brain.item_rev SET body = 'x'", 'DELETE FROM brain.item_rev', "UPDATE brain.run SET meta = '{}'",
    'DELETE FROM brain.run', 'TRUNCATE brain.edge', 'TRUNCATE brain.attempt CASCADE', 'DELETE FROM brain.attempt']) {
    await refused('owner', sql);                                                 // the triggers hold for the owner as well
  }

  const w = await b.connect('writer');
  try {
    await w.query('BEGIN');
    await w.query('SELECT pg_advisory_xact_lock($1)', [PUBLISH_LOCK_KEY]);
    const att = (await w.query('INSERT INTO brain.attempt (gha_run_id, gha_attempt, source_sha, base_run) VALUES (900, 1, $1, 1) RETURNING attempt_id', [SHA])).rows[0].attempt_id;
    const run = Number((await w.query(`INSERT INTO brain.run (attempt_id, commit_sha, mode, tool_version, sanitize_version, meta, checksum)
      VALUES ($1, $2, 'normal', 'v1-test', 1, '{}', '{}') RETURNING run_id`, [att, SHA])).rows[0].run_id);
    const [a, c] = (await w.query('SELECT rev_id FROM brain.node_rev WHERE valid_to IS NULL ORDER BY rev_id LIMIT 2')).rows.map((x) => x.rev_id);
    await refusedIn(w, 'UPDATE brain.node_rev SET valid_to = 1 WHERE rev_id = $1', DENIED, [a]);   // not the run being published
    await refusedIn(w, "UPDATE brain.node_rev SET valid_to = $1, name = 'x' WHERE rev_id = $2", DENIED, [run, a]);
    assert.equal((await w.query('UPDATE brain.node_rev SET valid_to = $1 WHERE rev_id = $2', [run, a])).rowCount, 1);
    await refusedIn(w, 'UPDATE brain.node_rev SET valid_to = $1 WHERE rev_id = $2', DENIED, [run, a]);   // the second close
    await refusedIn(w, 'UPDATE brain.node_rev SET valid_to = NULL WHERE rev_id = $1', DENIED, [a]);       // reopening
    await refusedIn(w, 'DELETE FROM brain.node_rev WHERE rev_id = $1', DENIED, [c]);
    await w.query("UPDATE brain.attempt SET status = 'ok', finished_at = now() WHERE attempt_id = $1", [att]);
    await w.query('COMMIT');

    await w.query('BEGIN');
    const att3 = (await w.query('INSERT INTO brain.attempt (gha_run_id, gha_attempt, source_sha, base_run) VALUES (901, 1, $1, $2) RETURNING attempt_id', [SHA, run])).rows[0].attempt_id;
    const run3 = Number((await w.query(`INSERT INTO brain.run (attempt_id, commit_sha, mode, tool_version, sanitize_version, meta, checksum)
      VALUES ($1, $2, 'normal', 'v1-test', 1, '{}', '{}') RETURNING run_id`, [att3, SHA])).rows[0].run_id);
    await refusedIn(w, 'UPDATE brain.node_rev SET valid_to = $1 WHERE rev_id = $2', DENIED, [run3, a]);   // closed in an earlier run
    await w.query('ROLLBACK');
  } finally { await w.end(); }
  const row = (await b.query('reader', 'SELECT valid_to::int AS t FROM brain.node_rev WHERE valid_to IS NOT NULL')).rows;
  assert.equal(row.length, 1, 'exactly the one close survived');
});

test('V2: the reader writes nothing, read-only on or off; the writer has no DDL, TRUNCATE, DELETE or TEMP; the reader check', { skip }, async () => {
  const before = await b.dump();
  const writes = ["INSERT INTO brain.binding (source_repo_id, source_repo, ops_repo, workflow) VALUES (2, 'x', 'y', 'z')",
    "UPDATE brain.item_rev SET body = 'x'", 'DELETE FROM brain.item_rev', 'CREATE TABLE brain.x (i int)', 'CREATE TABLE public.x (i int)',
    'CREATE TEMP TABLE x (i int)', 'CREATE SCHEMA x', 'TRUNCATE brain.edge'];
  for (const who of ['reader', 'readerDirect']) {
    for (const sql of writes) {
      await refused(who, sql, [READ_ONLY, DENIED]);                              // read-only default
      await refused(who, `BEGIN READ WRITE; ${sql}`);                            // read-only off: the GRANTs refuse it
    }
  }
  const rd = await b.connect('readerDirect');                                    // session-level SET (direct endpoint)
  try {
    await rd.query('SET default_transaction_read_only = off');
    assert.equal((await rd.query("SELECT current_setting('default_transaction_read_only') AS v")).rows[0].v, 'off');
    for (const sql of writes) await assert.rejects(rd.query(sql), { code: DENIED }, sql);
  } finally { await rd.end(); }

  for (const sql of ['CREATE TABLE brain.x (i int)', 'ALTER TABLE brain.node ADD COLUMN x int', 'DROP TABLE brain.edge',
    'CREATE INDEX ON brain.edge (kind)', 'ALTER TABLE brain.run DISABLE TRIGGER refuse', 'DROP TRIGGER refuse ON brain.run',
    'TRUNCATE brain.edge', 'DELETE FROM brain.edge', 'DELETE FROM brain.attempt', 'CREATE TEMP TABLE x (i int)', 'CREATE SCHEMA x',
    'CREATE TABLE public.x (i int)', 'CREATE FUNCTION brain.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$']) {
    await refused('writer', sql);
  }

  // the reader check the CLI runs first (§6.2); the CLI itself is Q6
  const check = "SELECT current_user = 'brain_reader' AND NOT has_table_privilege(current_user, 'brain.run', 'INSERT') AS ok";
  assert.equal((await b.query('reader', check)).rows[0].ok, true);
  assert.equal((await b.query('owner', check)).rows[0].ok, false, 'an owner URL fails the reader check');
  assert.equal((await b.query('writer', check)).rows[0].ok, false, 'a writer URL fails the reader check');
  assert.equal(await b.dump(), before, 'schema brain unchanged');
});

test('V2 known limits (§10), recorded: reader large objects, ALTER ROLE on itself, the publish advisory lock; brain unchanged', { skip }, async (t) => {
  const before = await b.dump();
  const rd = await b.connect('readerDirect');
  const outcome = async (sql, params) => {
    await rd.query('BEGIN READ WRITE');
    try { await rd.query(sql, params); return 'works'; } catch (e) { return `refused ${e.code}`; } finally { await rd.query('ROLLBACK'); }
  };
  try {
    const rec = {
      'lo_from_bytea': await outcome("SELECT lo_from_bytea(0, 'x'::bytea)"),
      'ALTER ROLE self SET': await outcome('ALTER ROLE brain_reader SET statement_timeout = 0'),
      'ALTER ROLE self PASSWORD (same password)': await outcome(`ALTER ROLE brain_reader PASSWORD ${rd.escapeLiteral(new URL(b.readerUrl).password)}`),
      'pg_try_advisory_xact_lock(publish key)': await outcome('SELECT pg_try_advisory_xact_lock($1)', [PUBLISH_LOCK_KEY]),
    };
    for (const [k, v] of Object.entries(rec)) t.diagnostic(`reader ${k}: ${v}`);
  } finally { await rd.end(); }
  assert.equal(await b.dump(), before, 'schema brain unchanged');
  assert.equal((await b.query('reader', 'SELECT current_user AS u')).rows[0].u, 'brain_reader', 'the reader still logs in');
  const st = (await b.query('reader', "SELECT current_setting('statement_timeout') AS st")).rows[0].st;
  assert.equal(st, '15s', 'role defaults unchanged after the rollback');
});

test('V14: Korean trigram — show_trgm, 크레딧 and 크레딧 예약 match through the trigram index; 예약 recorded', { skip }, async (t) => {
  const c = await b.connect('reader');
  try {
    const trgm = (await c.query("SELECT public.show_trgm('크레딧 예약') AS t")).rows[0].t;
    assert.ok(trgm.length > 0, 'show_trgm is not empty');
    t.diagnostic(`show_trgm('크레딧 예약'): ${trgm.length} trigrams`);
    const ptrs = async (where, params) => (await c.query(`SELECT DISTINCT i.ptr FROM brain.chunk ch JOIN brain.item_rev r USING (rev_id)
      JOIN brain.item i USING (item_id) WHERE ${where} ORDER BY 1`, params)).rows.map((r) => r.ptr);
    assert.deepEqual(await ptrs('ch.body ILIKE $1', ['%크레딧%']), ['ic:8']);
    assert.deepEqual(await ptrs('ch.title ILIKE $1 OR ch.body ILIKE $1', ['%크레딧%']), ['ic:8', 'issue:45']);
    assert.deepEqual(await ptrs('ch.title % $1 OR $1 <% ch.body', ['크레딧 예약']), ['ic:8', 'issue:45']);
    const sim = (await c.query("SELECT public.word_similarity('크레딧 예약', body) AS w FROM brain.chunk WHERE body LIKE '%크레딧을%'")).rows[0].w;
    t.diagnostic(`word_similarity('크레딧 예약', ic:8 body) = ${sim}`);

    await c.query('BEGIN');
    await c.query('SET LOCAL enable_seqscan = off');
    const plan = (await c.query("EXPLAIN SELECT chunk_id FROM brain.chunk WHERE body ILIKE '%크레딧%'")).rows.map((r) => r['QUERY PLAN']).join('\n');
    assert.match(plan, /chunk_body_trgm/, 'the GIN trigram index serves the Korean query');
    const orPlan = (await c.query("EXPLAIN SELECT chunk_id FROM brain.chunk WHERE title ILIKE '%크레딧%' OR body ILIKE '%크레딧%'")).rows.map((r) => r['QUERY PLAN']).join('\n');
    assert.match(orPlan, /chunk_title_trgm/, `title ILIKE takes the title index (sql/004): ${orPlan}`);
    assert.match(orPlan, /chunk_body_trgm/, orPlan);
    const two = await ptrs('ch.title ILIKE $1 OR ch.body ILIKE $1', ['%예약%']);
    const twoPlan = (await c.query("EXPLAIN SELECT chunk_id FROM brain.chunk WHERE body ILIKE '%예약%'")).rows.map((r) => r['QUERY PLAN']).join(' | ');
    await c.query('ROLLBACK');
    t.diagnostic(`two-letter '예약': ${JSON.stringify(two)} · plan: ${twoPlan}`);
    assert.deepEqual(two, ['ic:8', 'issue:45']);
  } finally { await c.end(); }
});

// last: the rolled-back runs advance the run_id identity, and the seed above expects run 1
test('the run guard: one run per transaction even with a multi-row insert or a reset setting; not inside a SAVEPOINT', { skip }, async () => {
  const w = await b.connect('writer');
  const attempts = async (n) => {
    const out = [];
    for (let i = 0; i < n; i++) out.push((await w.query('INSERT INTO brain.attempt (gha_run_id, gha_attempt, source_sha) VALUES ($1, 1, $2) RETURNING attempt_id', [800 + i + Math.floor(Math.random() * 1e6), SHA])).rows[0].attempt_id);
    return out;
  };
  const runSql = (att) => `INSERT INTO brain.run (attempt_id, commit_sha, mode, tool_version, sanitize_version, meta, checksum)
    VALUES (${att}, '${SHA}', 'normal', 'guard-test', 1, '{}', '{}')`;
  try {
    await w.query('BEGIN');
    const [a1, a2] = await attempts(2);
    await assert.rejects(w.query(`${runSql(a1)}, (${a2}, '${SHA}', 'normal', 'guard-test', 1, '{}', '{}')`), { code: DENIED, message: /one run per transaction/ });
    await w.query('ROLLBACK');

    await w.query('BEGIN');
    const [c1, c2] = await attempts(2);
    await w.query(runSql(c1));
    await w.query("SELECT set_config('brain.publishing_run', '', true)");
    await assert.rejects(w.query(runSql(c2)), { code: DENIED, message: /one run per transaction/ });
    await w.query('ROLLBACK');

    await w.query('BEGIN');
    const [d1] = await attempts(1);
    await w.query('SAVEPOINT s');
    await assert.rejects(w.query(runSql(d1)), { code: DENIED, message: /not inside a SAVEPOINT/ });
    await w.query('ROLLBACK');
  } finally { await w.end(); }
});
