// test/pg/parity.mjs (the §7.2 map parity harness), offline: normalization and classes on values, then the CLI on two
// copies of the built fixture — equal copies are all `same`, a copy with one edge removed `differs` at that list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize, unordered, diffs, compare, parity, badQuery, argvFor } from './parity.mjs';
import { fixtureRepo } from '../phase1/helpers.mjs';

delete process.env.BRAIN_READER_URL;                                     // the fixture build runs in local mode

const HARNESS = fileURLToPath(new URL('./parity.mjs', import.meta.url));
const ok = (json) => ({ exit: 0, json, text: null });

test('normalize drops ms and freshness at every depth and sorts keys; unordered sorts every list', () => {
  assert.deepEqual(normalize({ b: 1, ms: 3, a: [{ freshness: {}, y: 2, x: 1 }], c: { ms: 1, d: null } }), { a: [{ x: 1, y: 2 }], b: 1, c: { d: null } });
  assert.deepEqual(JSON.stringify(normalize({ b: 1, a: 2 })), '{"a":2,"b":1}');
  assert.deepEqual(unordered({ l: [[2, 1], [1, 0]], o: { m: ['b', 'a'] } }), { l: [[0, 1], [1, 2]], o: { m: ['a', 'b'] } });
});

test('compare: same, order, differs (lists as multisets, keys, scalars, exit codes, text output)', () => {
  assert.equal(compare(ok({ r: [1, 2], ms: 1 }), ok({ ms: 9, r: [1, 2] })).class, 'same');
  assert.equal(compare(ok({ r: [1, 2], freshness: { a: 1 } }), ok({ r: [2, 1], freshness: { b: 2 } })).class, 'order');
  const d = compare(ok({ r: [1, 2, 2, 3], k: 'x' }), ok({ r: [2, 3, 4, 1], k: 'x' }));
  assert.equal(d.class, 'differs');
  assert.deepEqual(d.diffs, [{ path: '$.r', onlyA: [2], onlyB: [4] }]);
  assert.deepEqual(diffs({ toString: 1 }, {}), [{ path: '$.toString', onlyA: [1], onlyB: [] }], 'own keys only');
  assert.deepEqual(diffs({ a: 1, b: { c: 1 } }, { b: { c: 2 }, d: 0 }),
    [{ path: '$.a', onlyA: [1], onlyB: [] }, { path: '$.b.c', onlyA: [1], onlyB: [2] }, { path: '$.d', onlyA: [], onlyB: [0] }]);
  assert.deepEqual(compare(ok({}), { exit: 1, json: null, text: 'e' }).diffs[0].path, 'exit');
  assert.equal(compare({ exit: 1, json: null, text: 'no such target' }, { exit: 1, json: null, text: 'no such target' }).class, 'same');
  assert.equal(compare({ exit: 1, json: null, text: 'a' }, { exit: 1, json: null, text: 'b' }).class, 'differs');
  assert.equal(compare(ok({ a: 1 }), { exit: 0, json: null, text: 'x' }).class, 'differs');
});

test('queries: read commands only, never the harness flags; the harness flags come first and include --local', () => {
  assert.equal(badQuery(['refs', 'src/x.ts#y', '--limit', '10']), null);
  for (const q of [['build', '.'], ['sync'], ['viz', 'x', '--out', 'f'], ['search', 'x'], [], ['find', 1], 'find',
    ['find', 'x', '--repo'], ['find', 'x', '--db', 'f'], ['find', 'x', '--db=f'], ['find', 'x', '--local'], ['find', 'x', '--json']]) {
    assert.ok(badQuery(q), JSON.stringify(q));
  }
  const argv = argvFor('/a.db', '/repo', ['find', 'x', '--limit']);
  assert.deepEqual(argv.slice(0, 6), ['--db', '/a.db', '--repo', '/repo', '--local', '--json'], 'a trailing option of the query takes nothing of the harness');
  assert.deepEqual(argv.slice(6), ['find', 'x', '--limit']);
});

test('the CLI on two copies of the fixture: equal copies are all same (exit 0); one edge removed differs at sites (exit 1)', async () => {
  const { repo, codeDb } = fixtureRepo();
  const a = join(repo, '..', `${repo.split('/').pop()}-a.db`), b = join(repo, '..', `${repo.split('/').pop()}-b.db`);
  copyFileSync(codeDb, a);
  copyFileSync(codeDb, b);
  assert.ok(!existsSync(`${codeDb}-wal`), 'the build left no WAL beside code.db');
  const db = new DatabaseSync(b);
  const e = db.prepare(`SELECT e.rowid AS id, n.key, n.name FROM edges e JOIN nodes n ON n.id = e.dst WHERE e.kind = 'call' ORDER BY n.key, e.rowid LIMIT 1`).get();
  assert.ok(e, 'the fixture has a call edge');
  const queries = [['find', e.name], ['refs', e.key], ['callers', e.key], ['impact', e.key.split('#')[0]], ['deps', e.key.split('#')[0]],
    ['why', 'why do we reserve credits first'], ['refs', 'no/such/file.ts#nothing']];
  const qfile = join(repo, '..', `${repo.split('/').pop()}-q.json`);
  writeFileSync(qfile, JSON.stringify(queries));

  process.env.BRAIN_READER_URL = 'postgresql://brain_reader:' + 'q9fake' + 'pass' + '@127.0.0.1:9/none';   // never reached: stripped, and --local
  const same = await parity({ a, b, repo, queries, jobs: 2 });
  assert.deepEqual(same.summary, { same: queries.length, order: 0, differs: 0 }, JSON.stringify(same.results.filter((r) => r.class !== 'same')));
  assert.ok(same.results.at(-1).exit !== 0, 'a missing target fails on both sides, and the error text matches (db paths replaced)');
  const run = (...args) => spawnSync(process.execPath, [HARNESS, ...args], { encoding: 'utf8' });
  assert.equal(run('--a', a, '--b', b, '--repo', repo, '--queries', qfile).status, 0);

  db.prepare('DELETE FROM edges WHERE rowid = ?').run(e.id);
  db.close();
  const out = join(repo, '..', `${repo.split('/').pop()}-out.json`);
  writeFileSync(out, '{}', { mode: 0o644 });
  const r = run('--a', a, '--b', b, '--repo', repo, '--queries', qfile, '--out', out);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(statSync(out).mode & 0o777, 0o600, 'an existing output file is made 0600');
  const rec = JSON.parse(readFileSync(out, 'utf8'));
  const refs = rec.results[1];
  assert.equal(refs.class, 'differs');
  assert.ok(refs.diffs.some((d) => d.path === '$.sites' && d.onlyA.length === 1 && d.onlyB.length === 0), JSON.stringify(refs.diffs));
  assert.equal(rec.results[0].query[0], 'find');

  assert.equal(run('--a', a).status, 2, 'usage: missing flags');
  for (const j of ['0', 'wat', 'Infinity', '65']) assert.equal(run('--a', a, '--b', b, '--repo', repo, '--queries', qfile, '--jobs', j).status, 2, `--jobs ${j}`);
  writeFileSync(qfile, JSON.stringify([['build', repo]]));
  assert.equal(run('--a', a, '--b', b, '--repo', repo, '--queries', qfile).status, 2, 'a write command is refused');
  assert.ok(existsSync(a) && existsSync(b));
  assert.equal(run('--a', a, '--b', b, '--repo', repo, '--queries', a).status, 2, 'queries must be JSON');
  writeFileSync(qfile, JSON.stringify([['find', 1]]));
  assert.equal(run('--a', a, '--b', b, '--repo', repo, '--queries', qfile).status, 2, 'queries must be string arrays');
});
