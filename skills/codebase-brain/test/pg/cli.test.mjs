// Q6: bin/brain in server mode (design §6.2, §6.4, §6.8, V2), black-box. Offline: where the reader URL comes from,
// and --as-of on a local index. On a Neon branch over runs r1 (golden seed) .. r3 (r4 published by the byte test):
// search / get / source read the server run and the footer names it; --as-of; the map commands read a mirror of the
// run under ~/.cache/brain/mirror/<source repo id>/{latest,as-of}; two sessions pull one at a time; full and delta
// mirror bytes (criterion 6); only the reader account of this checkout's brain is used (V2: owner / writer URLs, a
// .env.local in a copy of the kit); build and sync refuse; no URL or password in any output.
// The Neon tests need NEON_PROJECT_ID; they are skipped without it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawn, execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { useBranch, neonSkip } from './harness.mjs';
import { writeRun } from './write-run.mjs';
import { buildStores, goldenState } from './golden/build-golden.mjs';
import { githubDbPath } from '../../src/gh-schema.mjs';
import { readerUrl, secretsOf, ensureMirror, mirrorDir } from '../../src/store/server.mjs';
import { pgStore } from '../../src/store/pg.mjs';
import { holdLockInChild, killChild } from '../phase1/helpers.mjs';

const skip = neonSkip();
const b = useBranch('cli');
const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BRAIN = join(KIT, 'bin', 'brain');
const work = mkdtempSync(join(tmpdir(), 'brain-cli-'));
after(() => rmSync(work, { recursive: true, force: true }));             // the V2 kit copy's .env.local holds an owner URL
const SHA = (c) => `aaaaaaa${c}${'0'.repeat(32)}`;
const DOC = 'doc:docs/credits.md:1-7';
const meta = (build, commit) => `UPDATE meta SET value = '"${build}"' WHERE key = 'build_id'; UPDATE meta SET value = '"${commit}"' WHERE key = 'commit';`;
const relink = (from, to) => `UPDATE refs SET resolved_build = '${to}' WHERE resolved_build = '${from}';`;
// r2: the GitHub state written by the current sanitizer (the guard refuses version 0), a doc edit; r3: an issue title
const RUNS = [
  { n: 2, code: `UPDATE chunks SET body = body || char(10) || 'Reserve first, then charge.' WHERE source = 'doc'; ${meta('golden02', SHA(1))}`,
    gh: () => `${relink('golden00', 'golden02')} UPDATE sync_state SET sanitize_version = 1, cursor = '${new Date().toISOString()}', last_ok_at = '${new Date().toISOString()}';` },
  { n: 3, code: meta('golden03', SHA(2)),
    gh: () => `UPDATE items SET title = '크레딧 예약 순서 (정리)' WHERE ptr = 'issue:45'; ${relink('golden02', 'golden03')}` },
];
const R4 = { n: 4, code: meta('golden04', SHA(3)), gh: () => `UPDATE items SET title = 'Charge after run (r4)' WHERE ptr = 'pr:1121'; ${relink('golden03', 'golden04')}` };

let r1 = null, prev = null, setup = null, gha = 300;
const runs = [];
function edit(spec) {
  const codeDb = join(work, `r${spec.n}.db`), ghDb = githubDbPath(codeDb);
  copyFileSync(prev.codeDb, codeDb); copyFileSync(prev.ghDb, ghDb);
  for (const [file, sql] of [[codeDb, spec.code], [ghDb, spec.gh()]]) {
    const db = new DatabaseSync(file);
    try { db.exec(sql); } finally { db.close(); }
  }
  prev = { codeDb, ghDb };
}
async function publish(spec) {
  edit(spec);
  const w = await b.connect('writer');
  try {
    const { run, state } = await writeRun(w, runs[spec.n - 1], goldenState(prev.codeDb, prev.ghDb), { gha: gha++ });
    assert.equal(run, spec.n);
    runs[spec.n] = state;
  } finally { await w.end(); }
}

// a checkout whose origin is the binding's repo (o/r, golden seed), and a HOME of its own
function checkout(remote = 'https://github.com/o/r.git') {
  const dir = mkdtempSync(join(work, 'repo-'));
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  writeFileSync(join(dir, 'README.md'), '# r\n');
  git('add', '-A'); git('commit', '-q', '-m', 'init');
  if (remote) git('remote', 'add', 'origin', remote);
  return dir;
}
let repo = null, home = null;
const ready = () => (setup ??= (async () => {
  await b.migrate();
  await b.seed();
  r1 = buildStores();
  prev = r1;
  runs[1] = { ...goldenState(r1.codeDb, r1.ghDb), run: 1 };
  for (const spec of RUNS) await publish(spec);
  repo = checkout();
  home = mkdtempSync(join(work, 'home-'));
})());

const outputs = [];
/** bin/brain with a bare environment (no DATABASE_URL, no token): PATH, HOME, NO_COLOR + env; onStderr sees stderr so far */
function brain(args, { env = {}, cwd = repo, bin = BRAIN, homeDir = home, onStderr = () => {} } = {}) {
  return new Promise((res) => {
    const c = spawn(bin, args, { cwd, env: { PATH: process.env.PATH, HOME: homeDir, NO_COLOR: '1', ...env } });
    let stdout = '', stderr = '';
    c.stdout.on('data', (d) => { stdout += d; });
    c.stderr.on('data', (d) => { stderr += d; onStderr(stderr); });
    c.on('close', (status) => { outputs.push(stdout, stderr); res({ stdout, stderr, status }); });
  });
}
const reader = () => ({ BRAIN_READER_URL: b.readerUrl });
const runOf = (codeDb) => { const db = new DatabaseSync(codeDb, { readOnly: true }); try { return JSON.parse(db.prepare("SELECT value FROM meta WHERE key = 'brain_run'").get().value); } finally { db.close(); } };

// ---------- offline ----------

test('the reader URL: BRAIN_READER_URL from the environment, else from .env.local; DATABASE_URL is never read', () => {
  const file = join(work, 'env-local');
  const u = (s) => `postgresql://brain_reader:${'pw'}${s}@host.example/neondb`;
  writeFileSync(file, `DATABASE_URL=${u('owner')}\nDATABASE_URL_UNPOOLED=${u('owner2')}\n`);
  assert.equal(readerUrl({}, file), null);
  assert.equal(readerUrl({ DATABASE_URL: u('env') }, file), null);
  writeFileSync(file, `# team brain\nexport BRAIN_READER_URL="${u('file')}"\nDATABASE_URL=${u('owner')}\n`);
  assert.equal(readerUrl({}, file), u('file'));
  assert.equal(readerUrl({ BRAIN_READER_URL: u('env') }, file), u('env'));
  assert.equal(readerUrl({}, join(work, 'missing')), null);
});

test('the reader password is cut from every output before any input is checked; a short one is refused', async () => {
  const pw = 'pw' + '123456';
  const url = `postgresql://brain_reader:${pw}@host.invalid/neondb?sslmode=require`;
  const q = `postgresql://brain_reader@host.invalid/neondb?password=${'q' + pw}&password=${'r' + pw}`;   // pg takes the last
  assert.deepEqual(secretsOf(q), [q, 'q' + pw, 'r' + pw]);
  const s = { codeDb: join(mkdtempSync(join(work, 'code-')), 'code.db') }, html = join(work, 'viz.html');
  copyFileSync(buildStores().codeDb, s.codeDb);                                     // the map alone (golden GitHub data is v0)
  const env = { BRAIN_READER_URL: url, BRAIN_DB: s.codeDb };
  const runs = [await brain(['get', pw], { env, homeDir: work }),                  // a usage error echoes the pointer
    await brain(['source', `doc:${pw}:1-2`, '--json'], { env, homeDir: work }),
    await brain(['why', pw, '--json', '--local'], { env, cwd: dirname(s.codeDb), homeDir: work }),
    await brain(['viz', 'src/lib/credits.ts#reserve', '--why', `about ${pw}`, '--out', html, '--local'], { env, cwd: dirname(s.codeDb), homeDir: work })];
  assert.equal(runs[2].status, 0, runs[2].stdout + runs[2].stderr);
  assert.equal(runs[3].status, 0, runs[3].stdout + runs[3].stderr);
  for (const r of runs) assert.ok(!(r.stdout + r.stderr).includes(pw), r.stdout + r.stderr);
  assert.match(runs[0].stdout, /REDACTED:reader-url/);
  assert.ok(!readFileSync(html, 'utf8').includes(pw), 'the viz page holds the password');
  const last = await brain(['get', 'r' + pw, '--json'], { env: { ...env, BRAIN_READER_URL: q }, homeDir: work });
  assert.ok(!last.stdout.includes('r' + pw), last.stdout);
  // a password that is also a JSON key: values are cut, keys and literals stay
  const word = 'cover' + 'age';
  const j = await brain(['search', word, '--json', '--local'], { env: { ...env, BRAIN_READER_URL: `postgresql://brain_reader:${word}@host.invalid/neondb` },
    cwd: dirname(s.codeDb), homeDir: work });
  const parsed = JSON.parse(j.stdout);
  assert.equal(parsed.query, '[REDACTED:reader-url]');
  assert.ok(parsed.coverage && parsed.freshness, j.stdout);
  // a password a JSON string escapes (an error message quotes the input)
  const quoted = 'abcd"' + 'efgh';
  for (const args of [['get', quoted], ['get', quoted, '--json']]) {
    const r = await brain(args, { env: { ...env, BRAIN_READER_URL: `postgresql://brain_reader:${encodeURIComponent(quoted)}@host.invalid/neondb` }, homeDir: work });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.ok(!r.stdout.includes(quoted) && !r.stdout.includes(JSON.stringify(quoted).slice(1, -1)), r.stdout);
  }
  for (const short of ['pw', 'pw' + '12345']) {                                     // under 8: not cut, it would cut words too
    const local = await brain(['search', 'reserve', '--local'], { env: { ...env, BRAIN_READER_URL: `postgresql://brain_reader:${short}@host.invalid/neondb` },
      cwd: dirname(s.codeDb), homeDir: work });
    assert.equal(local.status, 0, local.stdout + local.stderr);                       // --local does not use the reader account
    const r = await brain(['get', short], { env: { ...env, BRAIN_READER_URL: `postgresql://brain_reader:${short}@host.invalid/neondb` }, homeDir: work });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout, /\(not-reader\): the password in BRAIN_READER_URL is shorter than 8 characters/);
    assert.doesNotMatch(r.stdout.replace('BRAIN_READER_URL', ''), new RegExp(`\\b${short}\\b`));
  }
});

test('--as-of on a local index is a server read', async () => {
  const s = buildStores();
  const r = await brain(['search', 'credits', '--as-of', 'run:1'], { env: { BRAIN_DB: s.codeDb }, cwd: dirname(s.codeDb), homeDir: work });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /needs-server/);
});

// ---------- Neon ----------

test('search / get / source read the newest server run; the footer and --json name it', { skip }, async () => {
  await ready();
  const s = await brain(['search', 'credits', '--kind', 'doc'], { env: reader() });
  assert.equal(s.status, 0, s.stdout + s.stderr);
  assert.match(s.stdout, new RegExp(`${DOC}@r2`));
  assert.match(s.stdout, /freshness: brain data: run 3 @aaaaaaa2 \(published \d+m ago\)/);
  const j = JSON.parse((await brain(['search', '크레딧 예약', '--kind', 'issue', '--json'], { env: reader() })).stdout);
  assert.deepEqual(j.rows.map((r) => [r.ptr, r.untrusted.title]), [['issue:45', '크레딧 예약 순서 (정리)']]);
  assert.equal(j.freshness.brain.run, 3);
  assert.equal(j.view, undefined);
  const g = await brain(['get', 'issue:45', `${DOC}@r2`], { env: reader() });
  assert.equal(g.status, 0, g.stdout + g.stderr);
  assert.match(g.stdout, /revs {5}r1 \d{4}-\d\d-\d\d run 1 open · r2 \d{4}-\d\d-\d\d run 2 open · r3 \d{4}-\d\d-\d\d run 3 open/);
  assert.match(g.stdout, /an old text: brain source issue:45@r1/);
  const old = await brain(['source', `${DOC}@r1`], { env: reader() });
  assert.equal(old.status, 0, old.stdout + old.stderr);
  assert.match(old.stdout, /Every paid call goes through `reserve`/);
  assert.doesNotMatch(old.stdout, /Reserve first, then charge/);
  assert.match((await brain(['source', `${DOC}@r2`], { env: reader() })).stdout, /Reserve first, then charge/);
  assert.equal(existsSync(join(repo, '.codebase-brain')), false);                    // nothing local was read or written
});

test('--as-of: the run it names; the footer says so and names the newest run', { skip }, async () => {
  await ready();
  const r = await brain(['search', '크레딧 예약', '--kind', 'issue', '--as-of', 'run:2'], { env: reader() });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /크레딧 예약 순서/);
  assert.doesNotMatch(r.stdout, /\(정리\)/);
  assert.match(r.stdout, /freshness: brain data as of run 2 @aaaaaaa1 \(\d{4}-\d\d-\d\d, as-of\) · latest run 3/);
  const g = await brain(['get', 'issue:45', '--as-of', `commit:${SHA(1)}`], { env: reader() });
  assert.match(g.stdout, /revs {5}r1 .* · r2 [^·]*$/m);                              // r3 is not published yet at run 2
  // the guards read the run's own state: run 1's GitHub data was stored before masking v1
  const v0 = await brain(['search', 'credits', '--as-of', 'run:1'], { env: reader() });
  assert.equal(v0.status, 1, v0.stdout + v0.stderr);
  assert.match(v0.stdout, /\(rebuild-needed\).*secret masking v1 \(has v0\)/);
  for (const [spec, code] of [['2026-01-01', 'not-found'], ['run:9', 'not-found'], ['soon', 'usage']]) {
    const x = await brain(['search', 'credits', '--as-of', spec], { env: reader() });
    assert.equal(x.status, 1);
    assert.match(x.stdout, new RegExp(`\\(${code}\\)`), spec);
  }
});

test('map commands read a mirror of the run: latest, one --as-of, pulled only when the run moved', { skip }, async () => {
  await ready();
  const latest = join(mirrorDir('1', false, home), 'brain.db'), asOf = join(mirrorDir('1', true, home), 'brain.db');
  const f = await brain(['find', 'reserve'], { env: reader() });
  assert.equal(f.status, 0, f.stdout + f.stderr);
  assert.match(f.stderr, /mirror run 3 \(full\)/);
  assert.match(f.stdout, /src\/lib\/credits\.ts#reserve/);
  assert.match(f.stdout, /freshness: brain data: run 3 @aaaaaaa2/);
  assert.equal(runOf(latest), 3);
  const again = await brain(['refs', 'src/lib/credits.ts#reserve'], { env: reader() });
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.doesNotMatch(again.stderr, /mirror/);
  const old = await brain(['impact', 'src/lib/credits.ts', '--as-of', 'run:2'], { env: reader() });
  assert.equal(old.status, 0, old.stdout + old.stderr);
  assert.match(old.stderr, /mirror run 2 \(full\)/);
  assert.match(old.stdout, /brain data as of run 2 @aaaaaaa1 .* latest run 3/);
  assert.equal(runOf(asOf), 2);
  const moved = await brain(['find', 'reserve', '--as-of', `commit:${SHA(2)}`], { env: reader() });
  assert.match(moved.stderr, /mirror run 2 -> 3 \(delta\)/);
  assert.equal(runOf(asOf), 3);
  assert.equal(runOf(latest), 3);
  assert.deepEqual(readdirSync(dirname(dirname(latest))).sort(), ['as-of', 'latest']);   // the newest and one as-of
});

test('two sessions on one laptop pull one at a time', { skip }, async () => {
  await ready();
  const h = mkdtempSync(join(work, 'home-'));
  const both = await Promise.all([brain(['find', 'reserve'], { env: reader(), homeDir: h }), brain(['find', 'reserve'], { env: reader(), homeDir: h })]);
  for (const r of both) assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(both.filter((r) => /mirror run 3 \(full\)/.test(r.stderr)).length, 1, both.map((r) => r.stderr).join('\n---\n'));
  // a pull that holds the lock: the next command waits for it, then reads
  const h2 = mkdtempSync(join(work, 'home-'));
  const child = await holdLockInChild(join(mirrorDir('1', false, h2), 'brain.db'));
  let saw = null;
  const blocked = new Promise((r) => { saw = r; });
  const waiting = brain(['find', 'reserve'], { env: reader(), homeDir: h2, onStderr: (e) => /another session is pulling/.test(e) && saw() });
  await Promise.race([blocked, waiting]);
  await killChild(child);
  const w = await waiting;
  assert.equal(w.status, 0, w.stdout + w.stderr);
  assert.match(w.stderr, /another session is pulling the mirror/);
});

test('two sessions reading different --as-of runs through one mirror: each answers from its own run', { skip }, async () => {
  await ready();
  const h = mkdtempSync(join(work, 'home-'));
  for (let round = 0; round < 3; round++) {
    const rs = await Promise.all(['run:2', 'run:3', 'run:2', 'run:3'].map((a) => brain(['find', 'reserve', '--as-of', a], { env: reader(), homeDir: h })));
    rs.forEach((r, i) => {
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, new RegExp(`brain data as of run ${i % 2 ? 3 : 2} @aaaaaaa${i % 2 ? 2 : 1}`), r.stdout);
    });
  }
});

test('V2: only the reader account is used — owner and writer URLs, and an owner URL in .env.local, are refused', { skip }, async () => {
  await ready();
  for (const url of [b.ownerUrl, b.writerUrl]) {
    for (const args of [['search', 'credits'], ['find', 'reserve']]) {
      const r = await brain(args, { env: { BRAIN_READER_URL: url } });
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.match(r.stdout, /\(not-reader\).*not brain_reader/);
    }
  }
  // logged in as the owner, acting as brain_reader (options=-c role=…, once the owner may SET ROLE to it): the login counts
  const acting = new URL(b.ownerUrl);
  acting.searchParams.set('options', '-c role=brain_reader');
  await b.query('owner', 'GRANT brain_reader TO neondb_owner WITH INHERIT FALSE, SET TRUE');
  try {
    const as = await brain(['search', 'credits'], { env: { BRAIN_READER_URL: acting.toString() } });
    assert.equal(as.status, 2, as.stdout + as.stderr);
    assert.match(as.stdout, /\(not-reader\).*"neondb_owner", not brain_reader/);
  } finally { await b.query('owner', 'REVOKE brain_reader FROM neondb_owner'); }
  // brain_reader with a write privilege, or a role it can SET ROLE to
  for (const [grant, revoke, why] of [['GRANT INSERT ON brain.item TO brain_reader', 'REVOKE INSERT ON brain.item FROM brain_reader', /can write brain tables/],
    ['GRANT UPDATE (status) ON brain.attempt TO brain_reader', 'REVOKE UPDATE (status) ON brain.attempt FROM brain_reader', /can write brain tables/],
    ['GRANT brain_writer TO brain_reader WITH INHERIT FALSE', 'REVOKE brain_writer FROM brain_reader', /SET ROLE/]]) {
    await b.query('owner', grant);
    try {
      const r = await brain(['find', 'reserve'], { env: reader() });
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.match(r.stdout, why);
    } finally { await b.query('owner', revoke); }
  }
  // a copy of the kit: its own .env.local, never written into the source tree
  const kit = mkdtempSync(join(work, 'kit-'));
  for (const d of ['bin', 'src']) cpSync(join(KIT, d), join(kit, d), { recursive: true });
  copyFileSync(join(KIT, 'package.json'), join(kit, 'package.json'));
  symlinkSync(join(KIT, 'node_modules'), join(kit, 'node_modules'));
  const bin = join(kit, 'bin', 'brain');
  writeFileSync(join(kit, '.env.local'), `DATABASE_URL=${b.ownerUrl}\nDATABASE_URL_UNPOOLED=${b.ownerUrl}\n`, { mode: 0o600 });
  const local = await brain(['search', 'credits'], { bin });
  assert.equal(local.status, 1);
  assert.match(local.stdout, /no index at/);                                        // local mode: the owner URL was not read
  writeFileSync(join(kit, '.env.local'), `BRAIN_READER_URL=${b.ownerUrl}\n`, { mode: 0o600 });
  const owner = await brain(['search', 'credits'], { bin });
  assert.equal(owner.status, 2, owner.stdout + owner.stderr);
  assert.match(owner.stdout, /\(not-reader\)/);
  writeFileSync(join(kit, '.env.local'), `BRAIN_READER_URL="${b.readerUrl}"\n`, { mode: 0o600 });
  const ok = await brain(['search', 'credits', '--kind', 'doc'], { bin });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /brain data: run 3/);
});

test("the checkout's origin must be the brain's source repo", { skip }, async () => {
  await ready();
  for (const remote of ['https://github.com/o/other.git', null]) {
    const r = await brain(['search', 'credits'], { env: reader(), cwd: checkout(remote) });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout, /\(wrong-repo\).*o\/r/);
  }
});

test('build and sync write only in local mode', { skip }, async () => {
  await ready();
  for (const args of [['build', '.'], ['sync']]) {
    const r = await brain(args, { env: reader() });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /\(server-mode\).*--local/);
  }
  const db = join(work, 'local.db');
  const built = await brain(['build', '.', '--db', db, '--local'], { env: reader() });
  assert.equal(built.status, 0, built.stdout + built.stderr);
  const s = await brain(['search', 'r', '--db', db, '--local'], { env: reader() });
  assert.equal(s.status, 0, s.stdout + s.stderr);
  assert.doesNotMatch(s.stdout, /brain data/);
});

test('criterion 6: a full mirror and one run of delta, in bytes; the CLI pulls the delta', { skip }, async (t) => {
  await ready();
  const dir = mkdtempSync(join(work, 'bytes-'));
  const view = async (run) => { const c = await b.connect('reader'); try { return (await pgStore(c).resolveAsOf(`run:${run}`)).view; } finally { await c.end(); } };
  const full = await ensureMirror({ url: b.readerUrl, dir, view: await view(3), repo: null });
  await publish(R4);
  const delta = await ensureMirror({ url: b.readerUrl, dir, view: await view(4), repo: null });
  assert.ok(full.pulled && delta.pulled);
  assert.ok(delta.bytes < full.bytes, `delta ${delta.bytes} B, full ${full.bytes} B`);
  t.diagnostic(`criterion 6 (golden fixture, code shape): full mirror ${full.bytes} B, delta of one run ${delta.bytes} B`);
  const f = await brain(['find', 'reserve'], { env: reader() });
  assert.equal(f.status, 0, f.stdout + f.stderr);
  assert.match(f.stderr, /mirror run 3 -> 4 \(delta\)/);
  assert.match(f.stdout, /brain data: run 4 @aaaaaaa3/);
});

test('no connection string or password in any output', { skip }, async () => {
  await ready();
  const secrets = [b.ownerUrl, b.writerUrl, b.readerUrl].flatMap((u) => [u, decodeURIComponent(new URL(u).password)]).filter((s) => s.length >= 8);
  assert.ok(outputs.length > 20);
  for (const o of outputs) for (const s of secrets) assert.ok(!o.includes(s), 'a secret reached the output');
});
