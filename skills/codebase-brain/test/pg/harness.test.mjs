// Q11: the harness round-trips a Neon branch (an empty suite), hands out owner / writer / reader URLs, dumps schema
// brain, injects failures, and the proxy drops, delays or cuts a query. Needs NEON_PROJECT_ID; skipped without it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createBranch, branchExists, neonSkip, redact, scrubError, takeSlot } from './harness.mjs';
import { startProxy, Framer } from './proxy.mjs';

const skip = neonSkip();
let b = null;
after(async () => { await b?.drop(); });

test('offline: at most N slots per prefix; a bad frame length throws instead of looping', async () => {
  const prefix = `slot-test-${randomBytes(4).toString('hex')}`;
  const r1 = await takeSlot({ prefix, slots: 2, waitMs: 0 }), r2 = await takeSlot({ prefix, slots: 2, waitMs: 0 });
  await assert.rejects(takeSlot({ prefix, slots: 2, waitMs: 200 }), /no free Neon branch slot/);
  r1();
  const r3 = await takeSlot({ prefix, slots: 2, waitMs: 0 });
  r2(); r3();
  const bad = Buffer.from([0x5a, 0xff, 0xff, 0xff, 0xff]);                      // length -1
  assert.throws(() => new Framer().push(bad), /bad protocol frame length -1/);
  const z = Buffer.from([0x5a, 0, 0, 0, 5, 0x49]);                               // ReadyForQuery 'I', split in two chunks
  const f = new Framer();
  assert.deepEqual(f.push(z.subarray(0, 3)), []);
  assert.deepEqual(f.push(z.subarray(3)).map((x) => [...x]), [[...z]]);
});

/** a child process that creates a branch, prints its name, then ends the way `how` says */
function childBranch(how) {
  const code = `const h = await import(${JSON.stringify(new URL('./harness.mjs', import.meta.url).href)});
    const b = await h.createBranch('exit');
    process.stdout.write(b.name + '\\n');
    ${how === 'exit' ? 'process.exit(3);' : 'setInterval(() => {}, 1000);'}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; if (how === 'sigterm' && out.includes('\n')) child.kill('SIGTERM'); });
  child.stderr.on('data', (d) => { err += d; });
  return new Promise((res) => child.on('exit', (code, signal) => res({ name: out.trim(), code, signal, err })));
}

test('exit cleanup: a suite process that exits or gets SIGTERM deletes its branch', { skip }, async () => {
  for (const [how, want] of [['exit', 3], ['sigterm', 143]]) {
    const r = await childBranch(how);
    assert.equal(r.code, want, redact(r.err));
    assert.match(r.name, /-exit-/);
    assert.equal(await branchExists(r.name), false, `${how}: branch deleted`);
  }
});

test('an empty suite: a branch from production, owner connects, role URLs are shaped right', { skip }, async () => {
  b = await createBranch('harness');
  assert.match(b.name, /^[a-z0-9-]+-harness-/);
  const r = (await b.query('owner', `SELECT current_user AS u, current_database() AS d, current_setting('server_version_num')::int AS v,
    to_regnamespace('brain') IS NULL AS empty`)).rows[0];
  assert.deepEqual([r.u, r.d, r.empty], ['neondb_owner', 'neondb', true]);   // production has no schema brain yet
  assert.ok(r.v >= 170000, 'transaction_timeout (R9) needs PostgreSQL 17+');
  const host = (u) => new URL(u).hostname, user = (u) => new URL(u).username;
  assert.equal(user(b.writerUrl), 'brain_writer');
  assert.equal(user(b.readerUrl), 'brain_reader');
  assert.equal(host(b.writerUrl), host(b.ownerUrl), 'writer: direct endpoint');
  assert.ok(host(b.readerUrl).includes('-pooler.'), 'reader: pooled endpoint');
  assert.equal(new URL(b.readerUrl).searchParams.get('sslmode'), 'verify-full');
  assert.equal(redact(`x ${b.writerUrl} y`), 'x <redacted> y');
  assert.ok(!redact(b.readerUrl).includes(new URL(b.readerUrl).password));
  const pw = new URL(b.ownerUrl).password;
  const e = Object.assign(new Error(`boom ${pw}`), { code: '42501', input: b.ownerUrl, detail: `d ${pw}` });
  const s = scrubError(e);
  assert.deepEqual([s.message, s.code, s.detail, s.input], ['boom <redacted>', '42501', 'd <redacted>', undefined]);
});

test('dump: every brain row as JSON, by table and primary key; failOn raises from the (after + 1)-th row', { skip }, async () => {
  await b.query('owner', `CREATE SCHEMA brain; CREATE TABLE brain.t (id int PRIMARY KEY, v text); CREATE TABLE brain.attempt (id int PRIMARY KEY);
    INSERT INTO brain.t VALUES (2, 'b'), (1, 'a'); INSERT INTO brain.attempt VALUES (1);`);
  const before = await b.dump();
  assert.equal(before, 't {"v": "a", "id": 1}\nt {"v": "b", "id": 2}');          // attempt is never in the dump
  await b.failOn('t', { after: 1 });
  await assert.rejects(b.query('owner', "INSERT INTO brain.t VALUES (3, 'c'), (4, 'd')"), { code: 'P0001', message: /injected failure on brain\.t INSERT/ });
  await b.query('owner', "INSERT INTO brain.t VALUES (3, 'c')");                // a new transaction counts from zero
  await b.clearFailures();
  await b.query('owner', "INSERT INTO brain.t VALUES (4, 'd'), (5, 'e')");
  assert.equal((await b.query('owner', 'SELECT count(*)::int AS n FROM brain.t')).rows[0].n, 5);
  assert.equal((await b.query('owner', "SELECT to_regnamespace('brain_test') IS NULL AS gone")).rows[0].gone, true);
});

test('proxy: COMMIT reaches the server but its reply is dropped; delay holds it; cut loses the transaction', { skip }, async () => {
  const p = await startProxy(b.ownerUrl);
  try {
    const matches = [];
    p.on('match', (m) => matches.push(m.sql));
    const viaProxy = async () => {
      const pg = (await import('pg')).default, c = new pg.Client({ connectionString: p.url(b.ownerUrl) });
      c.on('error', () => {});
      await c.connect();
      return c;
    };
    const count = async () => (await b.query('owner', 'SELECT count(*)::int AS n FROM brain.t WHERE id >= 100')).rows[0].n;

    // drop: the client sees the connection end, the row is committed
    let c = await viaProxy();
    await c.query('BEGIN');
    await c.query("INSERT INTO brain.t VALUES (100, 'dropped reply')");
    p.when(/^\s*COMMIT\b/i, { dropReply: true });
    await assert.rejects(c.query('COMMIT'), /Connection terminated|ECONNRESET|connection/i);
    assert.equal(await count(), 1, 'committed although the client never heard it');

    // delay: COMMIT waits in the proxy, another connection does not see the row yet
    c = await viaProxy();
    await c.query('BEGIN');
    await c.query("INSERT INTO brain.t VALUES (101, 'delayed')");
    p.when(/^\s*COMMIT\b/i, { delayMs: 3000 });
    const t0 = Date.now(), commit = c.query('COMMIT');
    await new Promise((res) => setTimeout(res, 1000));
    assert.equal(await count(), 1, 'not visible while COMMIT is held');
    await commit;
    assert.ok(Date.now() - t0 >= 3000);
    assert.equal(await count(), 2);
    await c.end();

    // cut: the INSERT is done, COMMIT never reaches the server, the server rolls the transaction back
    const before = await b.dump();
    c = await viaProxy();
    await c.query('BEGIN');
    await c.query("INSERT INTO brain.t VALUES (102, 'cut')");
    p.when(/^\s*COMMIT\b/i, { cut: true });
    await assert.rejects(c.query('COMMIT'));
    assert.equal(await count(), 2);
    assert.equal(await b.dump(), before, 'dump unchanged');
    assert.deepEqual(matches.map((s) => s.trim().split(/\s/)[0]), ['COMMIT', 'COMMIT', 'COMMIT']);
  } finally { await p.close(); }
});

test('drop() deletes the branch', { skip }, async () => {
  const id = b.id;
  await b.drop();
  assert.equal(await branchExists(id), false);
  await b.drop();                                                                 // idempotent
});
