// Q3 tests on one throwaway Neon branch (design §7.1: V3, V5–V7, V9–V13, V19–V23; V4 and R13 on the way). The schema is
// rebuilt from sql/ before every test. Skipped unless NEON_PROJECT_ID names the Neon test project (see neon-branch.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import * as C from '../../src/pg/contract.mjs';
import { diff, applyDelta, factKeyOf } from '../../src/pg/snapshot.mjs';
import { beginAttempt, publish, failAttempt, resolveAttempt } from '../../src/pg/publish.mjs';
import pg from 'pg';
import { neonEnv, createBranch } from './neon-branch.mjs';
import { commitProxy } from './commit-proxy.mjs';
import { FULL, INCR, OLD_COMMIT, ROUTES, fixtureBuilds, withoutOldCommit, atVersion0, corpusState } from './fixture-builds.mjs';
import { canaries, identSecret, leaksIn } from '../security/lib.mjs';

const it = neonEnv() ? test : test.skip;
const CHILD = join(dirname(fileURLToPath(import.meta.url)), 'publish-child.mjs');
const BINDING = Object.freeze({ sourceRepoId: 4242, sourceRepo: 'o/r', opsRepo: 'o/brain-ops', workflow: '.github/workflows/brain-publish.yml' });
const DOMAIN = ['run', 'sync_state', 'binding', 'node', 'node_rev', 'edge', 'unresolved', 'item', 'item_rev', 'chunk', 'ref', 'ref_link', 'link'];
const SLOW = { timeout: 240_000 };
let branch, owner, W, fx, gha = 0;

before(async () => {
  if (!neonEnv()) return;
  fx = fixtureBuilds({ more: true });
  branch = await createBranch('p2b-q3');
  W = branch.writerUrl;
  owner = new pg.Client({ connectionString: branch.ownerUrl });       // checks only: reads, and the schema reset
  owner.on('error', () => {});
  await owner.connect();
}, { timeout: 300_000 });
after(async () => { await owner?.end().catch(() => {}); branch?.drop(); });

const rows = async (text, params) => (await owner.query(text, params)).rows;
const value = async (text, params) => Object.values((await rows(text, params))[0] ?? {})[0];
const attempt = async (id) => (await rows('SELECT status, stage, error FROM brain.attempt WHERE attempt_id = $1', [id]))[0];
/** waits until n sessions wait for an advisory lock (the publish lock is the only one); 30 s at most */
async function lockWaiters(n) {
  for (const until = Date.now() + 30_000; Date.now() < until; await sleep(100)) {
    if (await value("SELECT count(*)::int FROM pg_locks WHERE locktype = 'advisory' AND NOT granted") === n) return;
  }
  throw new Error(`${n} sessions never waited for the publish lock`);
}
const dump = async () => { const out = {}; for (const t of DOMAIN) out[t] = await rows(`SELECT * FROM brain.${t} ORDER BY 1, 2`); return JSON.stringify(out); };

function begin(commit, binding = BINDING) {
  gha += 1;
  return beginAttempt({ url: W, gha: { runId: gha, attempt: 1 }, sourceSha: commit, binding });
}
/** server: the state at the server's latest run (null: empty); a: beginAttempt result */
function plan(server, next, a) {
  const base = server && { ...server, run: a.base.run };
  const delta = diff(base, next);
  const after = applyDelta(base, delta);
  return { delta, after, checksum: C.checksum(after) };
}
const args = (a, p, next, over = {}) => ({ url: W, attemptId: a.attemptId, base: a.base?.run ?? null, delta: p.delta, checksum: p.checksum,
  mode: 'normal', commit: next.meta.commit, toolVersion: 'test', repoDir: fx.repo, ...over });
async function pub(server, next, over = {}) {
  const a = await begin(next.meta.commit);
  const p = plan(server, next, a);
  const r = await publish(args(a, p, next, over));
  return { ...r, ...p, attemptId: a.attemptId };
}

/** contract.checksum of what the server shows at run R, read from its rows (what a mirror of R would hold) */
async function serverChecksum(run) {
  const vis = (a = '') => `${a}valid_from <= ${Number(run)} AND (${a}valid_to IS NULL OR ${a}valid_to > ${Number(run)})`;
  const items = (origin) => rows(`SELECT i.ptr, encode(r.hash, 'hex') AS h FROM brain.item_rev r JOIN brain.item i USING (item_id)
    WHERE i.origin = $1 AND ${vis('r.')}`, [origin]).then((rs) => rs.map((x) => C.canonicalJson([x.ptr, x.h])));
  const facts = (t) => rows(`SELECT encode(fact_key, 'hex') AS k FROM brain.${t} WHERE ${vis()}`).then((rs) => rs.map((x) => x.k));
  const lines = {
    node: (await rows(`SELECT n.key, encode(r.hash, 'hex') AS h FROM brain.node_rev r JOIN brain.node n USING (node_id) WHERE ${vis('r.')}`))
      .map((x) => C.canonicalJson([x.key, x.h])),
    'item.repo': await items('repo'), 'item.github': await items('github'),
    edge: await facts('edge'), unresolved: await facts('unresolved'), link: await facts('link'), ref_link: await facts('ref_link'),
    meta: [C.canonicalJson(await value('SELECT meta FROM brain.run WHERE run_id = $1', [run]))],
    'sync.github': (await rows("SELECT state FROM brain.sync_state WHERE run_id = $1 AND source = 'github'", [run])).map((x) => C.canonicalJson(x.state)),
  };
  return Object.fromEntries(Object.entries(lines).map(([t, l]) => {
    l.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    return [t, { rows: l.length, sha256: createHash('sha256').update(l.map((x) => `${x}\n`).join('')).digest('hex') }];
  }));
}
async function assertRun(r) {
  assert.deepEqual(await serverChecksum(r.run), r.checksum, `run ${r.run}: server rows`);
  assert.deepEqual(await value('SELECT checksum FROM brain.run WHERE run_id = $1', [r.run]), r.checksum, `run ${r.run}: run.checksum`);
  assert.equal((await attempt(r.attemptId)).status, 'ok');
}

it('V3 + R13: a first publish in 10k batches; the same snapshot again adds no revision or fact; one Actions attempt starts once', SLOW, async () => {
  await branch.reset();
  const big = { ...fx.s1, unresolved: new Map(fx.s1.unresolved) };
  for (let i = 0; i < 12_001; i++) {
    const f = { path: `gen/f${i}.ts`, line: 1, spec: `./missing-${i}`, local: 1 };
    big.unresolved.set(factKeyOf('unresolved', f), f);
  }
  const r1 = await pub(null, big);
  await assertRun(r1);
  const r2 = await pub(r1.after, big);
  await assertRun(r2);
  assert.ok(r2.run > r1.run);
  for (const t of ['node_rev', 'item_rev', 'edge', 'unresolved', 'link', 'ref_link']) {
    assert.equal(await value(`SELECT count(*)::int FROM brain.${t} WHERE valid_from = $1 OR valid_to = $1`, [r2.run]), 0, t);
  }
  assert.equal(await value('SELECT count(*)::int FROM brain.unresolved'), big.unresolved.size);
  await assert.rejects(beginAttempt({ url: W, gha: { runId: gha, attempt: 1 }, sourceSha: big.meta.commit, binding: BINDING }), { code: '23505' });
});

it('V4–V7: delete, edit, rename, re-add: every run reads back exactly, history keeps the old rows', SLOW, async () => {
  await branch.reset();
  const r1 = await pub(null, fx.s1);
  const r2 = await pub(r1.after, fx.s2);
  const r3 = await pub(r2.after, fx.s3);
  const r4 = await pub(r3.after, fx.s4);
  for (const r of [r1, r2, r3, r4]) await assertRun(r);
  const revs = await rows(`SELECT n.node_id::int AS id, r.rev_no, r.valid_from::int AS f, r.valid_to::int AS t FROM brain.node_rev r
    JOIN brain.node n USING (node_id) WHERE n.key = $1 ORDER BY r.rev_no`, [ROUTES[0]]);
  assert.deepEqual(revs.map((x) => [x.rev_no, x.f, x.t]), [[1, r1.run, r2.run], [2, r4.run, null]], 'V5 + V7: gone at run 2, back at run 4');
  assert.equal(new Set(revs.map((x) => x.id)).size, 1, 'V7: the same node_id');
  const life = async (key) => rows(`SELECT r.rev_no, r.valid_from::int AS f, r.valid_to::int AS t FROM brain.node_rev r JOIN brain.node n USING (node_id)
    WHERE n.key = $1 ORDER BY r.rev_no`, [key]);
  assert.deepEqual((await life('packages/worker/main.ts')).at(-1).t, r3.run, 'V6: the old path closes');
  assert.deepEqual((await life('packages/worker/start.ts')).map((x) => [x.rev_no, x.f]), [[1, r3.run]], 'V6: a new identity');
  const doc = await rows(`SELECT r.rev_no, string_agg(c.body, '') AS body FROM brain.item_rev r JOIN brain.item i USING (item_id)
    JOIN brain.chunk c ON c.rev_id = r.rev_id WHERE i.ptr = 'doc:docs/credits.md' GROUP BY r.rev_no ORDER BY r.rev_no`);
  assert.deepEqual(doc.map((d) => [d.rev_no, d.body.includes('Refunds go through')]), [[1, false], [2, true]], 'V4: @r1 keeps the old text');
});

it('V9: an error after the node writes rolls the whole publish back; the attempt ends failed', SLOW, async () => {
  await branch.reset();
  const r1 = await pub(null, fx.s1);
  const before = await dump();
  const a = await begin(fx.s2.meta.commit);
  const p = plan(r1.after, fx.s2, a);
  await assert.rejects(publish(args(a, p, fx.s2, { onStage: (s) => { if (s === 'nodes') throw new Error('injected'); } })),
    (e) => e.code === 'publish-failed' && e.recorded === true);
  assert.equal(await dump(), before);
  assert.deepEqual(await attempt(a.attemptId), { status: 'failed', stage: 'publish', error: 'error' });
});

it('V10: a publisher killed inside its transaction leaves the server as it was; the next publish goes through', SLOW, async () => {
  await branch.reset();
  const r1 = await pub(null, fx.s1);
  const before = await dump();
  const a = await begin(fx.s2.meta.commit);
  const p = plan(r1.after, fx.s2, a);
  const input = join(mkdtempSync(join(tmpdir(), 'brain-q3-')), 'input.json');
  const { url, ...rest } = args(a, p, fx.s2);
  writeFileSync(input, JSON.stringify(rest));
  const child = spawn(process.execPath, [CHILD], { env: { ...process.env, BRAIN_TEST_WRITER_URL: url, BRAIN_TEST_PUBLISH_INPUT: input }, stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = new Promise((r) => child.once('exit', r));
  await Promise.race([new Promise((r) => child.stdout.on('data', (d) => String(d).includes('ready') && r())),
    exited.then(() => { throw new Error('the child ended before its node writes'); })]);
  child.kill('SIGKILL');
  await exited;
  assert.equal(await dump(), before);
  const r2 = await pub(r1.after, fx.s2);                                // the lock is free again; same base
  await assertRun(r2);
  assert.equal((await attempt(a.attemptId)).status, 'running', 'a killed attempt stays running (shown as abandoned)');
  assert.equal(await value('SELECT count(*)::int FROM brain.run WHERE attempt_id = $1', [a.attemptId]), 0);
});

it('V11: the COMMIT reply is lost: publish resolves it under the lock as ok and does not write again', SLOW, async () => {
  await branch.reset();
  const r1 = await pub(null, fx.s1);
  const proxy = await commitProxy(W);
  try {
    proxy.arm('drop-reply');
    const r2 = await pub(r1.after, fx.s2, { url: proxy.url });
    assert.equal(proxy.commits, 1);
    await assertRun(r2);
    assert.deepEqual((await rows('SELECT run_id::int AS r FROM brain.run ORDER BY run_id')).map((x) => x.r), [r1.run, r2.run]);
  } finally { await proxy.close(); }
});

it('V12: a COMMIT held in flight while a recovery starts: it waits for the lock, sees ok, and ok is never overwritten', SLOW, async () => {
  await branch.reset();
  const r1 = await pub(null, fx.s1);
  const proxy = await commitProxy(W);
  try {
    const a = await begin(fx.s2.meta.commit);
    const p = plan(r1.after, fx.s2, a);
    const hold = proxy.arm('hold');
    const running = publish(args(a, p, fx.s2, { url: proxy.url }));
    await Promise.race([hold.seen, running.then(() => { throw new Error('published without the held COMMIT'); })]);
    // the COMMIT is held in the proxy, so the publish lock is still taken: both recoveries must wait for it
    const recovering = Promise.all([resolveAttempt({ url: W, attemptId: a.attemptId }),
      failAttempt({ url: W, attemptId: a.attemptId, stage: 'commit', error: 'rolled-back' })]);
    recovering.catch(() => {});
    await lockWaiters(2);
    hold.release();
    const [resolved, failed] = await recovering;
    assert.equal(resolved.outcome, 'ok');
    assert.equal(failed.updated, false);
    assert.equal((await running).run, resolved.run);
    await assertRun({ run: resolved.run, attemptId: a.attemptId, checksum: p.checksum });
  } finally { await proxy.close(); }
});

it('V13: two publishes on the same base: the one holding the lock commits, the other waits, then ends stale-base', SLOW, async () => {
  await branch.reset();
  const r1 = await pub(null, fx.s1);
  const a = await begin(fx.s2.meta.commit), b = await begin(fx.s3.meta.commit);
  const pa = plan(r1.after, fx.s2, a), pb = plan(r1.after, fx.s3, b);
  let locked, release;
  const aLocked = new Promise((r) => (locked = r)), gate = new Promise((r) => (release = r));
  const first = publish(args(a, pa, fx.s2, { onStage: async (s) => { if (s === 'locked') { locked(); await gate; } } }));
  first.catch(() => {});
  await Promise.race([aLocked, first]);
  const second = publish(args(b, pb, fx.s3));
  second.catch(() => {});
  await lockWaiters(1);                                               // b waits for a's lock: a real race
  release();
  const [won, lost] = await Promise.allSettled([first, second]);
  assert.equal(won.status, 'fulfilled');
  assert.equal(lost.status, 'rejected');
  assert.deepEqual([lost.reason.code, lost.reason.kind, lost.reason.recorded], ['stale-base', 'base-moved', true]);
  assert.deepEqual(await attempt(b.attemptId), { status: 'failed', stage: 'stale-base', error: 'base-moved' });
  assert.deepEqual((await rows('SELECT run_id::int AS r, attempt_id::int AS a FROM brain.run ORDER BY run_id')).map((x) => [x.r, x.a]),
    [[r1.run, r1.attemptId], [won.value.run, a.attemptId]]);
  await assertRun({ run: won.value.run, attemptId: a.attemptId, checksum: pa.checksum });
});

it('R10: an attempt cannot move to a newer base than the one it began on', SLOW, async () => {
  await branch.reset();
  const r1 = await pub(null, fx.s1);
  const old = await begin(fx.s3.meta.commit);                           // begins on run 1 ...
  const r2 = await pub(r1.after, fx.s2);                                // ... run 2 commits
  const moved = { ...old, base: { run: r2.run } };                      // the caller remakes its delta on run 2
  await assert.rejects(publish(args(moved, plan(r2.after, fx.s3, moved), fx.s3)),
    (e) => e.code === 'stale-base' && e.kind === 'base-moved' && e.recorded === true);
  assert.deepEqual(await attempt(old.attemptId), { status: 'failed', stage: 'stale-base', error: 'base-moved' });
});

it('V19: the T7 corpus publishes with no canary in any server row; an injected secret is refused before any connection', SLOW, async () => {
  await branch.reset();
  const corpus = corpusState();
  const r = await pub(null, corpus.state, { repoDir: corpus.repo });
  await assertRun(r);
  const text = await dump();
  assert.deepEqual(leaksIn(corpus.reg, text, { folded: true }), []);
  assert.match(text, /\[REDACTED:/);
  const reg = canaries(), tok = identSecret(reg, 'v19', 'github-token');
  const next = { ...corpus.state, unresolved: new Map(corpus.state.unresolved) };
  const f = { path: 'src/x.ts', line: 1, spec: `@scope/${tok}`, local: 0 };
  next.unresolved.set(factKeyOf('unresolved', f), f);
  const a = await begin(next.meta.commit);
  const p = plan(r.after, next, a);
  const before = await dump();
  await assert.rejects(publish(args(a, p, next, { url: 'postgres://nobody:none@127.0.0.1:9/none', repoDir: corpus.repo })), (e) => {
    assert.equal(e.code, 'outbound-secret');                            // not a connection error: nothing was opened
    assert.deepEqual([e.stage, e.recorded, `${e.table}.${e.column}`], ['outbound', false, 'unresolved.spec']);
    assert.deepEqual(leaksIn(reg, `${e.message} ${JSON.stringify(e)}`), []);
    return true;
  });
  assert.equal(await dump(), before);
  assert.equal((await failAttempt({ url: W, attemptId: a.attemptId, stage: 'outbound', error: 'outbound-secret' })).updated, true);
  assert.deepEqual(await attempt(a.attemptId), { status: 'failed', stage: 'outbound', error: 'outbound-secret' });
  const b = await begin(next.meta.commit);                               // free text in a failure record: stored as 'other'
  const hex = randomBytes(24).toString('hex');
  assert.equal((await failAttempt({ url: W, attemptId: b.attemptId, stage: hex, error: hex })).updated, true);
  assert.deepEqual(await attempt(b.attemptId), { status: 'failed', stage: 'other', error: 'other' });
});

it('V20: a sanitize_version bump is refused without --full; with it every current revision is new and the old ones stay', SLOW, async () => {
  await branch.reset();
  const r1 = await pub(null, atVersion0(fx.s1));
  const next = withoutOldCommit(fx.s2v1);                              // GitHub synced --full at 1; the old commit outside the window
  const a = await begin(next.meta.commit);
  const p = plan(r1.after, next, a);
  await assert.rejects(publish(args(a, { ...p, delta: { ...p.delta, manifest: C.validateManifest(INCR) } }, next)),
    (e) => e.code === 'sanitize-version' && e.kind === 'needs-full' && e.recorded === true, 'the server refuses it even past diff');
  const v0 = atVersion0(fx.s2), b = await begin(v0.meta.commit);       // a delta that says 1 but keeps version-0 revisions
  const q = plan(r1.after, v0, b);
  const lie = { ...q.delta, manifest: C.validateManifest(FULL), meta: { ...q.delta.meta, sanitize_version: 1 } };
  await assert.rejects(publish({ ...args(b, q, v0), delta: lie, checksum: C.checksum(applyDelta({ ...r1.after, run: b.base.run }, lie)) }),
    (e) => e.code === 'sanitize-version' && e.kind === 'not-resanitized' && e.recorded === true);
  const r2 = await pub(r1.after, next);
  await assertRun(r2);
  assert.equal(await value('SELECT count(*)::int FROM brain.item_rev WHERE valid_to IS NULL AND sanitize_version <> 1'), 0);
  assert.equal(await value('SELECT count(*)::int FROM brain.item_rev WHERE sanitize_version = 0 AND valid_to = $1', [r2.run]), r1.after.items.size,
    'every old revision stays, closed at the bump');
  assert.deepEqual(await rows(`SELECT r.rev_no, r.sanitize_version FROM brain.item_rev r JOIN brain.item i USING (item_id)
    WHERE i.ptr = $1 AND r.valid_to IS NULL`, [OLD_COMMIT]), [{ rev_no: 2, sanitize_version: 1 }], 'the commit outside the window too');
});

it('V21: an item gone from a full GitHub sync closes with its ref_link; an incremental sync keeps it', SLOW, async () => {
  await branch.reset();
  const r1 = await pub(null, fx.s1);
  const r2 = await pub(r1.after, { ...fx.s2full, manifest: C.validateManifest(INCR) });
  const r3 = await pub(r2.after, fx.s2full);
  for (const r of [r1, r2, r3]) await assertRun(r);
  const ic8 = await rows(`SELECT r.valid_to::int AS t FROM brain.item_rev r JOIN brain.item i USING (item_id) WHERE i.ptr = 'ic:8'`);
  assert.deepEqual(ic8, [{ t: r3.run }]);
  assert.deepEqual(await rows(`SELECT l.valid_to::int AS t FROM brain.ref_link l JOIN brain.ref f USING (ref_id) JOIN brain.item_rev r ON r.rev_id = f.rev_id
    JOIN brain.item i USING (item_id) WHERE i.ptr = 'ic:8'`), [{ t: r3.run }]);
});

it('V22: a source repo id other than the binding is refused and writes nothing', SLOW, async () => {
  await branch.reset();
  await begin(fx.sha1);
  const before = await dump(), attempts = await value('SELECT count(*)::int FROM brain.attempt');
  await assert.rejects(begin(fx.sha1, { ...BINDING, sourceRepoId: 999 }), { code: 'binding-mismatch' });
  assert.equal(await dump(), before);
  assert.equal(await value('SELECT count(*)::int FROM brain.attempt'), attempts);
  assert.equal(Number(await value('SELECT source_repo_id FROM brain.binding')), BINDING.sourceRepoId);
});

it('V23: after a force-push a normal publish is refused; bootstrap goes through and is marked; a stale base still loses', SLOW, async () => {
  await branch.reset();
  const r1 = await pub(null, fx.s1);
  const r2 = await pub(r1.after, fx.s2);
  await assert.rejects(pub(r2.after, fx.s5), (e) => e.code === 'stale-base' && e.kind === 'not-descendant' && e.recorded === true);
  const r3 = await pub(r2.after, fx.s5, { mode: 'bootstrap' });
  await assertRun(r3);
  assert.equal(await value('SELECT mode FROM brain.run WHERE run_id = $1', [r3.run]), 'bootstrap');
  const late = await begin(fx.s4.meta.commit);                          // starts on run 3 ...
  const p = plan(r3.after, fx.s4, late);
  await pub(r3.after, fx.s2, { mode: 'bootstrap' });                     // ... another run commits first
  await assert.rejects(publish(args(late, p, fx.s4, { mode: 'bootstrap' })), (e) => e.code === 'stale-base' && e.kind === 'base-moved');
});

it('S2: an abort while the publish connection opens writes nothing and records nothing (code aborted)', SLOW, async () => {
  await branch.reset();
  const r1 = await pub(null, fx.s1);
  const before = await dump();
  const a = await begin(fx.s2.meta.commit);
  const p = plan(r1.after, fx.s2, a);
  const ac = new AbortController();
  const done = publish(args(a, p, fx.s2, { signal: ac.signal, recordFailure: false }));
  ac.abort();                                                         // publish is waiting for its connection now
  await assert.rejects(done, (e) => e.code === 'aborted' && e.recorded === false);
  assert.equal(await dump(), before);
  assert.deepEqual(await attempt(a.attemptId), { status: 'running', stage: null, error: null });
});

it('S2: the client deadline follows statement_timeout: a 46 s statement under the bootstrap limits commits', { timeout: 300_000 }, async () => {
  await branch.reset();
  const r1 = await pub(null, fx.s1);
  const a = await begin(fx.s2.meta.commit);
  const p = plan(r1.after, fx.s2, a);
  const seen = [];
  const slow = async (s, { client }) => { seen.push(s); if (s === 'locked') await client.query('SELECT pg_sleep(46)'); };   // over the old 45 s
  const r = await publish(args(a, p, fx.s2, { mode: 'bootstrap', limits: C.CI_LIMITS.bootstrap, onStage: slow }));
  assert.ok(r.run > r1.run);
  assert.deepEqual(seen, ['locked', 'run', 'nodes', 'items', 'facts', 'counts', 'ok', 'committed']);
  assert.deepEqual(await attempt(a.attemptId), { status: 'ok', stage: null, error: null });
});

test('input and connection failures are BrainErrors that echo no value (no server needed)', { timeout: 120_000 }, async () => {
  const fx0 = fixtureBuilds(), pw = ['pw', 'xyzzy', '0451'].join('-');
  const delta = diff(null, fx0.s1), checksum = C.checksum(applyDelta(null, delta));
  const base = { url: `postgres://u:${pw}@127.0.0.1:9/none`, attemptId: 1, delta, checksum, mode: 'normal',
    commit: fx0.s1.meta.commit, toolVersion: 'test', repoDir: fx0.repo };
  for (const bad of [{ base: 'x' }, { base: null, delta: { ...delta, base: base.url } }]) {
    await assert.rejects(publish({ ...base, ...bad }), (e) => {
      assert.deepEqual([e.code, e.stage, e.recorded], ['contract', 'input', false]);
      assert.ok(!`${e.message} ${JSON.stringify(e)}`.includes(pw));
      return true;
    });
  }
  await assert.rejects(publish({ ...base, base: null }), (e) => {      // nothing listens on port 9: retried, then refused
    assert.deepEqual([e.code, e.stage, e.kind, e.recorded], ['publish-failed', 'connect', 'econnrefused', false]);
    assert.ok(!`${e.message} ${JSON.stringify(e)}`.includes(pw));
    return true;
  });
});
