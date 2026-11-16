// P0 contract tests: the shared pieces every lane builds on. Must stay green on every merge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parsePtr, formatPtr } from '../../src/ptr.mjs';
import { openGithubDb, githubDbPath, withWriteLock, readSyncState, writeSyncState } from '../../src/gh-schema.mjs';
import { LockBusyError, PtrError } from '../../src/errors.mjs';
import { ext, safe } from '../../src/fmt.mjs';
import { replayTransport, virtualClock } from '../../src/replay.mjs';
import * as sanitizeMod from '../../src/sanitize.mjs';
import * as client from '../../src/gh-client.mjs';
import * as link from '../../src/link.mjs';
import * as ghSync from '../../src/gh-sync.mjs';
import * as read from '../../src/read.mjs';
import * as answer from '../../src/answer.mjs';
import { pathIndex, PATH_RE, IDENT_RE } from '../../src/index-knowledge.mjs';
import { fixtureRepo, makeGithubDb } from './helpers.mjs';

test('pointer grammar round-trips and rejects junk', () => {
  for (const s of ['pr:1121', 'issue:45', 'review:2391', 'rc:88123', 'ic:99120', 'commit:6b820f87',
    'doc:changes/20261001-reserve-first.md:1-24@k3f9ab12', 'vault:Changes/a:b@c.md:3-9@0a1b2c3d', 'changelog:CHANGELOG.md:5-5@zzzzzzzz']) {
    assert.equal(formatPtr(parsePtr(s)), s, s);
  }
  assert.deepEqual(parsePtr('vault:Changes/a:b@c.md:3-9@0a1b2c3d'), { type: 'vault', path: 'Changes/a:b@c.md', a: 3, b: 9, build: '0a1b2c3d' });
  for (const bad of ['pr:0', 'pr:-1', 'PR:1', 'doc:a.md:9-3@abcdefgh', 'doc:a.md:1-2', 'commit:XYZ', 'pr:1\nx', '']) {
    assert.throws(() => parsePtr(bad), PtrError, bad);
  }
});

test('every lane module exports its contract', () => {
  for (const [mod, names] of [
    [sanitizeMod, ['SANITIZE_VERSION', 'normalize', 'mask', 'flagSuspicious', 'sanitize', 'sanitizeLine', 'sanitizeIdent', 'isRedacted', 'sweepSecrets', 'redactValues']],
    [client, ['createClient', 'readToken', 'fetchTransport', 'realClock']],
    [link, ['extractRefs', 'fileRefs', 'relink']],
    [ghSync, ['sync', 'upsertPage', 'ingestRaw', 'parseRemote']],
    [read, ['search', 'get', 'source', 'envelope']],
    [answer, ['coverage', 'freshness', 'footer', 'guard']],
  ]) for (const n of names) assert.ok(n in mod, n);
  const c = client.createClient({ owner: 'o', repo: 'r', token: null });
  for (const m of ['getRepo', 'pullsDesc', 'streamSince', 'reviews', 'files', 'stats']) assert.equal(typeof c[m], 'function', m);
});

test('github.db: schema, 0600, sync_state single row, reopen read-only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghdb-'));
  const p = githubDbPath(join(dir, 'brain.db'));
  assert.equal(p, join(dir, 'brain.github.db'));
  assert.equal(openGithubDb(p), null);
  const db = openGithubDb(p, { create: true });
  writeSyncState(db, { repo_id: 7, limits: { filesTruncated: 1 } });
  assert.equal(readSyncState(db).repo_id, 7);
  assert.deepEqual(readSyncState(db).limits, { filesTruncated: 1 });
  db.close();
  assert.equal(statSync(p).mode & 0o777, 0o600);
  const ro = openGithubDb(p, { readOnly: true });
  assert.throws(() => ro.exec("UPDATE sync_state SET repo = 'x'"));
  ro.close();
});

// a child process that takes the lock and waits; resolves once it holds it
function holdLockInChild(code) {
  const mod = new URL('../../src/gh-schema.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e',
    `import { withWriteLock } from ${JSON.stringify(mod)};
     await withWriteLock(process.argv[1], async () => { process.stdout.write('held\\n'); await new Promise(() => setInterval(() => {}, 1000)); });`, code]);
  return new Promise((res, rej) => {
    child.stdout.on('data', (d) => { if (String(d).includes('held')) res(child); });
    child.on('exit', (c) => rej(new Error(`child exited ${c}`)));
  });
}

test('withWriteLock: another live holder is busy; a killed holder releases it (staleLock); clean release is not stale', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lock-'));
  const code = join(dir, 'brain.db');
  const child = await holdLockInChild(code);
  await assert.rejects(withWriteLock(code, () => 1), (e) => e instanceof LockBusyError && e.pid === child.pid);
  child.kill('SIGKILL');
  await new Promise((r) => child.on('exit', r));
  assert.deepEqual(await withWriteLock(code, () => 42), { value: 42, staleLock: true });   // the OS dropped the dead holder's lock
  assert.deepEqual(await withWriteLock(code, () => 43), { value: 43, staleLock: false });
  await assert.rejects(withWriteLock(code, () => { throw new Error('boom'); }), /boom/);
  assert.deepEqual(await withWriteLock(code, () => 44), { value: 44, staleLock: false });  // released after a throw
  assert.equal(statSync(`${code}.lock`).mode & 0o777, 0o600);
  assert.equal(existsSync(`${code}.lock.pid`), false);
});

test('withWriteLock: a nested write in the same process is busy', async () => {
  const code = join(mkdtempSync(join(tmpdir(), 'lock2-')), 'brain.db');
  const inner = await withWriteLock(code, async () => withWriteLock(code, () => 1).catch((e) => e.code));
  assert.equal(inner.value, 'lock-busy');
});

test('ext() quotes and escapes so an external string cannot close its quote', () => {
  assert.equal(ext('a "b" \\ c'), '"a \\"b\\" \\\\ c"');
  assert.equal(safe('line1\nline2'), 'line1 line2');
  assert.ok(ext('x'.repeat(50), 10).length <= 11);
});

test('replay transport: exact query match, queued responses, unmatched -> 404', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'replay-'));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ routes: [
    { path: '/repos/o/r', responses: [{ status: 200, headers: { Date: 'Sun, 15 Nov 2026 10:00:00 GMT' }, body: { id: 1 } }, { status: 500, body: {} }] },
  ] }));
  const t = replayTransport(dir);
  const a = await t({ method: 'GET', url: 'https://api.github.com/repos/o/r', headers: {} });
  assert.equal(a.status, 200); assert.equal(a.headers.get('date'), 'Sun, 15 Nov 2026 10:00:00 GMT');
  assert.equal((await t({ method: 'GET', url: 'https://api.github.com/repos/o/r', headers: {} })).status, 500);
  assert.equal((await t({ method: 'GET', url: 'https://api.github.com/repos/o/r?x=1', headers: {} })).status, 404);
  assert.deepEqual(t.unmatched, ['GET /repos/o/r?x=1']);
  const clock = virtualClock('2026-11-15T10:00:00Z');
  await clock.sleep(3_600_000);
  assert.equal(new Date(clock.now()).toISOString(), '2026-11-15T11:00:00.000Z');
});

test('pathIndex exposes the Phase 0 path rules', () => {
  const ix = pathIndex(['src/lib/credits.ts', 'src/lib/index.ts', 'docs/a.md']);
  assert.deepEqual(ix.resolvePath('src/lib/credits'), { kind: 'file', path: 'src/lib/credits.ts' });
  assert.deepEqual(ix.resolvePath('src/lib/'), { kind: 'file', path: 'src/lib/index.ts' });
  assert.equal(ix.resolvePath('nope/x.ts'), null);
  assert.deepEqual(ix.resolveBase('credits.ts'), { kind: 'file', path: 'src/lib/credits.ts' });
  assert.ok(PATH_RE.flags.includes('g') && IDENT_RE.flags.includes('g'));   // use matchAll or a copy: never .exec on the shared object
});

test('build writes build_id, sanitize_version, body_line column; code.db is 0600; build releases the lock', async () => {
  const { codeDb } = fixtureRepo();
  const db = new DatabaseSync(codeDb, { readOnly: true });
  const meta = Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map((r) => [r.key, JSON.parse(r.value)]));
  assert.match(meta.build_id, /^[0-9a-z]{8}$/);
  assert.equal(meta.sanitize_version, sanitizeMod.SANITIZE_VERSION);
  assert.ok(db.prepare("SELECT 1 FROM pragma_table_info('chunks') WHERE name = 'body_line'").get());
  db.close();
  assert.equal(statSync(codeDb).mode & 0o777, 0o600);
  assert.deepEqual(await withWriteLock(codeDb, () => 'free'), { value: 'free', staleLock: false });   // build released it cleanly
  const gh = makeGithubDb(codeDb, { items: [{ number: 1121 }] });
  assert.ok(existsSync(gh));
});

test('seams: replay only when BRAIN_REPLAY_DIR is set; failpoints throw only for their own name', async () => {
  const { replaySeams, failpoint } = await import('../../src/seams.mjs');
  assert.equal(replaySeams({}), null);
  const dir = mkdtempSync(join(tmpdir(), 'seam-'));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ now: '2026-11-15T10:00:00Z', routes: [] }));
  const s = replaySeams({ BRAIN_REPLAY_DIR: dir });
  assert.equal(s.token, 'replay-token');
  assert.equal(new Date(s.clock.now()).toISOString(), '2026-11-15T10:00:00.000Z');
  failpoint('sync:page:1', { BRAIN_FAIL_AT: 'sync:page:2' });
  assert.throws(() => failpoint('sync:page:2', { BRAIN_FAIL_AT: 'sync:page:2' }), (e) => e.code === 'injected');
});

test('a build that fails part-way leaves no database file behind', async () => {
  const { build } = await import('../../src/build.mjs');
  const { repo, codeDb } = fixtureRepo({ build: false });
  assert.throws(() => build({ repo, dbPath: codeDb, log: (s) => { if (s.includes('typescript')) throw new Error('boom'); } }), /boom/);
  assert.equal(existsSync(codeDb), false);
});

