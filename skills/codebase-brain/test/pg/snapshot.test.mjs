// Q2 tests (no network): snapshot reproduces the golden, the two-build delta of the fixture is what the scope rules
// (R7, R8, R15) say, keys survive a declaration swap (V8), and the upload check (R16, V19) refuses secret-shaped values.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as C from '../../src/pg/contract.mjs';
import { snapshot, diff, applyDelta, checkOutbound, factKeyOf } from '../../src/pg/snapshot.mjs';
import { githubDbPath } from '../../src/gh-schema.mjs';
import { runBrain } from '../phase1/helpers.mjs';
import { buildStores, expectedText, EXPECTED } from './golden/build-golden.mjs';
import { canaries, identSecret, zwSplit, githubSecretCorpus, repoSecretCorpus, replayRoutes, writeReplay, setupRepo, sync, leaksIn } from '../security/lib.mjs';

const FULL = { map: 'full', docs: 'full', commits: 'append', github: 'full' };
const INCR = { ...FULL, github: 'incremental' };
const TABLES = ['nodes', 'items', 'edge', 'unresolved', 'link', 'ref_link'];
const ROUTES = ['src/lib/routes.generated.ts', 'src/lib/routes.generated.ts#ROUTES@variable', 'src/lib/routes.generated.ts#displayName@variable'];
const REFUND = ['src/lib/refund.ts', 'src/lib/refund.ts#refund@function'];
const OLD_COMMIT = 'commit:b070cb73666691f1bdd5fb238720ece1301fc069';   // the fixture commit (fixed dates, golden)
// no user or system git config (signing, hooks) in this process or the builds and syncs it spawns
Object.assign(process.env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });

const sorted = (a) => [...a].sort();
const keysOf = (part, keyOf) => sorted(part.put.map(keyOf));
const emptyDelta = (d) => TABLES.every((t) => d[t].put.length === 0 && d[t].close.length === 0);
const json = (v) => JSON.stringify(v, (k, x) => (x instanceof Map ? Object.fromEntries(x) : x?.type === 'Buffer' ? Buffer.from(x.data).toString('hex') : x));
const linkKeys = (state, ptr) => [...state.link].filter(([, l]) => l.ptr === ptr).map(([k]) => k);

function build(repo, db) {
  const r = runBrain(['build', '.', '--db', db], { cwd: repo, env: { BRAIN_DB: db } });
  assert.equal(r.status, 0, r.stderr);
}
const git = (repo, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, encoding: 'utf8' });

let one, s1, s2, s2full, s2v1, newCommit;
before(() => {
  // build 1 = the golden stores; build 2 = the next commit of the same checkout, built into a second code.db
  one = buildStores();
  s1 = snapshot({ codeDb: one.codeDb, githubDb: one.ghDb, manifest: INCR });
  const repo = one.codeDb.replace(/\.db$/, '');                          // fixtureRepo puts <repo>.db next to <repo>
  rmSync(join(repo, 'src/lib/routes.generated.ts'));
  writeFileSync(join(repo, 'src/lib/refund.ts'), 'export function refund(n: number) { return n; }\n');
  writeFileSync(join(repo, 'docs/credits.md'), `${readFileSync(join(repo, 'docs/credits.md'), 'utf8')}\nRefunds go through src/lib/refund.ts.\n`);
  git(repo, 'add', '-A', '-f');
  git(repo, 'commit', '-q', '-m', 'refund: give credits back');
  newCommit = `commit:${git(repo, 'rev-parse', 'HEAD').trim()}`;
  const codeDb2 = `${repo}-two.db`;
  build(repo, codeDb2);
  // GitHub between the builds: issue 45 edited; ic:8 is gone (a full sync drops it, an incremental one cannot know)
  copyFileSync(one.ghDb, githubDbPath(codeDb2));
  const gh = new DatabaseSync(githubDbPath(codeDb2));
  gh.exec("UPDATE items SET body = 'Failed runs keep their credits now. See src/lib/credits.ts', updated_at = '2026-11-14T00:00:00Z' WHERE ptr = 'issue:45'");
  s2 = snapshot({ codeDb: codeDb2, githubDb: githubDbPath(codeDb2), manifest: INCR });
  gh.exec("DELETE FROM items WHERE ptr = 'ic:8'; DELETE FROM refs WHERE ptr = 'ic:8'");
  s2full = snapshot({ codeDb: codeDb2, githubDb: githubDbPath(codeDb2), manifest: FULL });
  gh.exec('UPDATE sync_state SET sanitize_version = 1');                // what `brain sync --full` stamps (R15)
  gh.close();
  s2v1 = snapshot({ codeDb: codeDb2, githubDb: githubDbPath(codeDb2), manifest: FULL });
});

test('snapshot: the golden fixture reproduces expected.json; a mirror snapshots to the same state', () => {
  const s = snapshot({ codeDb: one.codeDb, githubDb: one.ghDb, manifest: FULL });
  assert.equal(expectedText(s), readFileSync(EXPECTED, 'utf8'));
  assert.equal(s.run, null);
  const mirror = join(mkdtempSync(join(tmpdir(), 'brain-q2-')), 'code.db');
  copyFileSync(one.codeDb, mirror);
  const db = new DatabaseSync(mirror);
  const set = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
  for (const [k, v] of [['brain_run', 7], ['brain_run_commit', 'c'.repeat(40)], ['brain_published_at', '2026-11-16T00:00:00Z'], ['brain_checksum', { x: 1 }]]) set.run(k, JSON.stringify(v));
  db.close();
  const m = snapshot({ codeDb: mirror, githubDb: one.ghDb, manifest: FULL });
  assert.equal(m.run, 7);
  assert.deepEqual(C.checksum(m), C.checksum(s));
  const bad = new DatabaseSync(mirror);
  bad.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('unmapped', '1');
  bad.close();
  assert.throws(() => snapshot({ codeDb: mirror, githubDb: one.ghDb, manifest: FULL }), /unmapped is not in COLUMN_MAP/);
  assert.throws(() => snapshot({ codeDb: one.codeDb, githubDb: one.ghDb, manifest: { ...FULL, commits: 'full' } }), { code: 'contract' });
});

test('first publish and V3 offline: diff(null, s) puts everything, applies to s; diff(s, s) is empty', () => {
  const d = diff(null, s1);
  assert.equal(d.base, null);
  assert.equal(d.nodes.put.length, s1.nodes.size);
  assert.equal(d.link.put.length, s1.link.size);
  assert.deepEqual(C.checksum(applyDelta(null, d)), C.checksum(s1));
  checkOutbound(d);
  assert.ok(emptyDelta(diff(s1, s1)) && emptyDelta(diff(s1full(), s1full())));
  assert.throws(() => applyDelta(s1, d), /delta puts .* unchanged/);
});
const s1full = () => ({ ...s1, manifest: C.validateManifest(FULL) });

test('two builds: the delta is exactly the changed files, doc, commit, issue and their facts', () => {
  const d = diff(s1, s2);
  const newKeys = d.nodes.put.filter((n) => !s1.nodes.has(n.key)).map((n) => n.key);
  assert.deepEqual(sorted(newKeys), REFUND);
  assert.deepEqual(sorted(d.nodes.close), ROUTES);
  for (const n of d.nodes.put.filter((x) => s1.nodes.has(x.key))) assert.notDeepEqual(n.rev, s1.nodes.get(n.key).rev, `${n.key} put unchanged`);
  assert.deepEqual(keysOf(d.items, (i) => i.ptr), sorted(['doc:docs/credits.md', 'issue:45', newCommit]));
  assert.deepEqual(d.items.close, [], 'incremental GitHub and append commits close nothing');
  // map facts: every edge of a closed node closes; nothing else does
  const touchesClosed = (e) => [e.src, e.dst, e.site].some((k) => ROUTES.includes(k));
  assert.deepEqual(sorted(d.edge.close), sorted([...s1.edge].filter(([, e]) => touchesClosed(e)).map(([k]) => k)));
  assert.ok(d.edge.close.length > 0);
  // links: the edited doc's links move to its new revision, the old commit loses its link to the deleted file
  const closed = d.link.close.map((k) => s1.link.get(k));
  assert.deepEqual(sorted(closed.map((l) => `${l.ptr} ${l.node}`)),
    sorted([...linkKeys(s1, 'doc:docs/credits.md').map((k) => `doc:docs/credits.md ${s1.link.get(k).node}`), `${OLD_COMMIT} src/lib/routes.generated.ts`]));
  const newDoc = d.items.put.find((i) => i.ptr === 'doc:docs/credits.md');
  for (const l of d.link.put.filter((x) => x.ptr === 'doc:docs/credits.md')) assert.equal(l.revHash, C.hex(newDoc.hash));
  assert.deepEqual(sorted(d.link.put.filter((l) => l.ptr === newCommit).map((l) => l.node)), sorted(['docs/credits.md', 'src/lib/refund.ts']));
  // ref_link: issue 45 moved to its new revision; ic:8 untouched
  assert.deepEqual(d.ref_link.close.map((k) => s1.ref_link.get(k).ptr), ['issue:45']);
  assert.deepEqual(d.ref_link.put.map((r) => r.ptr), ['issue:45']);
  assert.deepEqual(d.meta, s2.meta);
  assert.deepEqual(d.sync, s2.sync);
  checkOutbound(d);
  // applying the delta gives the next build exactly (nothing is outside the build window here)
  assert.deepEqual(C.checksum(applyDelta(s1, d)), C.checksum(s2));
  assert.ok(emptyDelta(diff(applyDelta(s1, d), s2)));
});

test('V21 offline: an item gone from a full GitHub sync closes with its ref_link; incremental keeps it', () => {
  const inc = diff(s1, { ...s2full, manifest: C.validateManifest(INCR) });
  assert.deepEqual(inc.items.close, []);
  assert.ok(applyDelta(s1, inc).items.has('ic:8'));
  const full = diff(s1, s2full);
  assert.deepEqual(full.items.close, ['ic:8']);
  assert.deepEqual(sorted(full.ref_link.close.map((k) => s1.ref_link.get(k).ptr)), ['ic:8', 'issue:45']);
  assert.deepEqual(C.checksum(applyDelta(s1, full)), C.checksum(s2full));
  const noGithub = { ...s2, sync: { github: null }, items: new Map([...s2.items].filter(([, i]) => i.origin === 'repo')),
    ref_link: new Map() };
  assert.throws(() => diff(s1, noGithub), /no GitHub state/);
});

/** s2 as a build whose commit window no longer holds the fixture commit (Phase 0 keeps the newest 5,000 only) */
const withoutOldCommit = (s) => ({ ...s, items: new Map([...s.items].filter(([p]) => p !== OLD_COMMIT)),
  link: new Map([...s.link].filter(([, l]) => l.ptr !== OLD_COMMIT)) });

test('R8: a commit outside the build window stays, and so do its links, except the one to a closed node', () => {
  const d = diff(s1, withoutOldCommit(s2));
  assert.ok(!d.items.close.includes(OLD_COMMIT) && !d.items.put.some((i) => i.ptr === OLD_COMMIT));
  assert.deepEqual(d.link.close.map((k) => s1.link.get(k)).filter((l) => l.ptr === OLD_COMMIT).map((l) => l.node), ['src/lib/routes.generated.ts']);
  const after = applyDelta(s1, d);
  assert.ok(after.items.has(OLD_COMMIT));
  assert.equal(linkKeys(after, OLD_COMMIT).length, linkKeys(s1, OLD_COMMIT).length - 1);
  assert.ok(emptyDelta(diff(after, withoutOldCommit(s2))), 'the next run writes nothing again');
});

test('R15: a sanitize_version bump needs a full publish and sanitizes the commits the build did not recreate', () => {
  // the server's run was made by an older sanitizer that missed a secret in the fixture commit
  const reg = canaries(), leaked = identSecret(reg, 'old-commit', 'github-token');
  const old = structuredClone(s1);
  old.meta.sanitize_version = 0;
  for (const i of old.items.values()) if (i.origin === 'repo') {
    if (i.ptr === OLD_COMMIT) i.chunks[0].body += `\ndeploy token ${leaked}`;
    i.rev = C.repoItemRev(0);
    const was = C.hex(i.hash);
    i.hash = C.itemHash(i.rev, i.chunks, []);
    old.link = new Map([...old.link].map(([k, l]) => (l.ptr === i.ptr && l.revHash === was ? [factKeyOf('link', { ...l, revHash: C.hex(i.hash) }), { ...l, revHash: C.hex(i.hash) }] : [k, l])));
  }
  applyDelta(null, diff(null, old));                                     // the doctored base is a consistent state
  const next = withoutOldCommit(s2v1);
  assert.throws(() => diff(old, { ...next, manifest: C.validateManifest(INCR) }), /needs a full publish/);
  assert.throws(() => diff(old, withoutOldCommit(s2full)), /GitHub state still has sanitize_version 0/, 'GitHub not synced again');
  assert.throws(() => diff(s1, { ...s2v1, manifest: C.validateManifest(INCR) }), /GitHub sanitize_version 0 -> 1 needs a full/);
  const d = diff(old, next);
  const again = d.items.put.find((i) => i.ptr === OLD_COMMIT);
  assert.equal(again.rev.sanitize_version, 1);
  assert.ok(!again.chunks[0].body.includes(leaked) && again.chunks[0].body.includes('[REDACTED:github-token]'));
  const after = applyDelta(old, d);
  for (const i of after.items.values()) assert.equal(i.rev.sanitize_version, 1, i.ptr);
  assert.equal(linkKeys(after, OLD_COMMIT).length, linkKeys(old, OLD_COMMIT).length - 1, 'links moved to the new revision');
  assert.deepEqual(leaksIn(reg, json(d)), []);
  checkOutbound(d);
  assert.throws(() => diff(s1, { ...s2full, meta: { ...s2full.meta, sanitize_version: 0 } }), /older version than the server/);
});

test('R8: a commit the build still sees keeps a link the build no longer makes while its node is open', () => {
  // a mention resolved by a unique basename stops resolving once another file has that basename
  const lost = [...s2.link].find(([, l]) => l.ptr === OLD_COMMIT && l.node === 'src/lib/credits.ts');
  const next = { ...s2, link: new Map([...s2.link].filter(([k]) => k !== lost[0])) };
  const d = diff(s1, next);
  assert.ok(!d.link.close.includes(lost[0]));
  assert.ok(applyDelta(s1, d).link.has(lost[0]));
});

test('incremental GitHub: a kept ref_link is resolved again against the new nodes (a Phase 0 key that moved)', () => {
  // const/type swap: the bare Phase 0 key `#Plan` now names the variable; pr:1121 is not in this (incremental) state
  const nodes = new Map(s2.nodes);
  for (const [key, p0] of [['src/lib/credits.ts#Plan@type', 'src/lib/credits.ts#Plan@type'], ['src/lib/credits.ts#Plan@variable', 'src/lib/credits.ts#Plan']]) {
    const n = nodes.get(key), rev = { ...n.rev, p0_key: p0 };
    nodes.set(key, { ...n, rev, hash: C.nodeHash(rev) });
  }
  const next = { ...s2, nodes, items: new Map([...s2.items].filter(([p]) => p !== 'pr:1121')),
    ref_link: new Map([...s2.ref_link].filter(([, r]) => r.ptr !== 'pr:1121')) };
  const d = diff(s1, next);
  const moved = d.ref_link.put.filter((r) => r.ptr === 'pr:1121');
  assert.deepEqual(moved.find((r) => r.status === 'ambiguous').resolved, ['src/lib/credits.ts#Plan@variable', 'src/lib/credits.ts#Plan@variable']);
  const after = applyDelta(s1, d);                                       // checkClosed re-resolves every ref_link
  assert.ok(after.items.has('pr:1121'));
  assert.throws(() => applyDelta(s1, { ...d, ref_link: { put: d.ref_link.put.filter((r) => r.ptr !== 'pr:1121'),
    close: d.ref_link.close.filter((k) => s1.ref_link.get(k).ptr !== 'pr:1121') } }), /resolves to other nodes/);
});

test('V8: a const/type declaration swap and same-name methods keep every identity', () => {
  const repo = mkdtempSync(join(tmpdir(), 'brain-q2-v8-'));
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true }, include: ['src'] }));
  const classes = 'export class A { run() {} }\nexport class B { run() {} }\n';
  git(repo, 'init', '-q');
  const at = (n, source) => {
    writeFileSync(join(repo, 'src', 'v8.ts'), source);
    git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', `v8 ${n}`);
    const db = `${repo}-${n}.db`;
    build(repo, db);
    return snapshot({ codeDb: db, githubDb: null, manifest: INCR });
  };
  const a = at(1, `export const X = 1;\nexport type X = number;\n${classes}`);
  const b = at(2, `export type X = number;\nexport const X = 1;\n${classes}`);
  const d = diff(a, b);
  assert.deepEqual(d.nodes.close, []);
  assert.deepEqual(d.nodes.put.filter((n) => !a.nodes.has(n.key)).map((n) => n.key), []);
  for (const k of ['src/v8.ts#X@variable', 'src/v8.ts#X@type', 'src/v8.ts#A.run@method', 'src/v8.ts#B.run@method']) assert.ok(b.nodes.has(k), k);
  assert.equal(b.sync.github, null);
  assert.ok(d.nodes.put.some((n) => n.key === 'src/v8.ts#X@variable'), 'X@variable moved a line: a new revision of the same identity');
});

test('applyDelta refuses a delta that does not fit its base', () => {
  const d = diff(s1, s2);
  assert.throws(() => applyDelta(null, d), /applied to run null|closes/);
  assert.throws(() => applyDelta(s1, { ...d, base: 3 }), /delta for run 3/);
  assert.throws(() => applyDelta(s1, { ...d, nodes: { ...d.nodes, close: [...d.nodes.close, 'nope.ts'] } }), /closes nope.ts/);
  const lost = d.nodes.close.filter((k) => k !== ROUTES[1]);           // keep ROUTES open: its file closed under it
  assert.throws(() => applyDelta(s1, { ...d, nodes: { ...d.nodes, close: lost } }), /names a closed node src\/lib\/routes.generated.ts/);
  assert.throws(() => applyDelta(s1, { ...d, link: { put: d.link.put, close: [] } }), /not current/);
});

// ---------------------------------------------------------------------------------------------- R16 / V19 offline

let corpus;
before(() => {
  const reg = canaries();
  const gh = githubSecretCorpus(reg);
  const fx = setupRepo(repoSecretCorpus(reg));
  assert.equal(fx.build.status, 0, 'corpus build');
  const r = sync(fx, writeReplay(replayRoutes(gh)));
  assert.equal(r.status, 0, 'corpus sync');
  corpus = { reg, state: snapshot({ codeDb: fx.codeDb, githubDb: fx.ghDb, manifest: FULL }) };
});

test('V19 offline: the Phase 1 T7 corpus publishes clean (masked by build and sync, nothing for R16 to refuse)', () => {
  const d = diff(null, corpus.state);
  checkOutbound(d);
  assert.deepEqual(leaksIn(corpus.reg, json(d)), []);
  assert.match(json(d), /\[REDACTED:[a-z-]+:[0-9a-f]{4}\]/, 'masked identifiers are uploaded as markers');
  assert.ok(d.items.put.some((i) => i.origin === 'github') && d.nodes.put.length > 30);
});

test('R16: a secret-shaped value anywhere in the delta refuses it, naming the table and column only', () => {
  const reg = canaries();
  const tok = identSecret(reg, 'inject', 'github-token'), aws = identSecret(reg, 'inject', 'aws-key'), split = zwSplit(reg, 'inject-zw', 'slack');
  const base = diff(null, s1);
  const inject = [
    ['node.key', (d) => { d.nodes.put[0].key = `src/${tok}.ts`; }],
    ['node.path', (d) => { d.nodes.put[0].path = `src/${aws}/x.ts`; }],
    ['node_rev.name', (d) => { d.nodes.put.find((n) => n.nodeKind === 'symbol').rev.name = split; }],
    ['node.key', (d) => { d.nodes.close.push(`src/${tok}.ts`); }],
    ['edge.site', (d) => { d.edge.put[0].site = `lib/${tok}.ts`; }],
    ['unresolved.spec', (d) => { d.unresolved.put[0].spec = `@scope/${tok}`; }],
    ['chunk.body', (d) => { d.items.put.find((i) => i.origin === 'repo').chunks[0].body += ` ${aws}`; }],
    ['ref.target', (d) => { d.items.put.find((i) => i.refs.length).refs[0].target = tok; }],
    ['item_rev.meta', (d) => { d.items.put.find((i) => i.origin === 'github').rev.meta.head = `fix/${tok}`; }],
    ['item.ptr', (d) => { d.items.close.push(`doc:${tok}.md`); }],
    ['link.evidence', (d) => { d.link.put[0].evidence = tok; }],
    ['run.meta', (d) => { d.meta = { ...d.meta, options: { [`/${tok}`]: 1 } }; }],
    ['sync_state.state', (d) => { d.sync = { github: { ...d.sync.github, row: { ...d.sync.github.row, last_error: `bad ${tok}` } } }; }],
  ];
  for (const [where, mutate] of inject) {
    const d = structuredClone(base);
    mutate(d);
    assert.throws(() => checkOutbound(d), (e) => {
      assert.equal(e.code, 'outbound-secret');
      assert.equal(`${e.table}.${e.column}`, where);
      assert.deepEqual(leaksIn(reg, `${e.message} ${json(e)}`), [], 'the error never holds the value');
      return true;
    }, where);
  }
  const marked = structuredClone(base);
  marked.nodes.put[0].key = 'src/[REDACTED:github-token:1a2b].ts';                  // what sanitizeIdent leaves: passes
  // a masked assignment-shaped path inside JSON text (refs.resolved, a ledger key) is not read as running on
  const masked = 'src/tok' + 'en=[REDACTED:assignment:a05a]';
  const rl = marked.ref_link.put.find((r) => r.resolvedRaw);
  rl.resolvedRaw = JSON.stringify([masked, 'src/lib/credits.ts']);
  marked.sync.github.refs.other[JSON.stringify(['pr:1', 'file', masked, 'pr-files'])] = 'oldbuild';
  checkOutbound(marked);
  rl.resolvedRaw = JSON.stringify([`src/${tok}.ts`, 'src/lib/credits.ts']);
  assert.throws(() => checkOutbound(marked), (e) => e.code === 'outbound-secret' && e.column === 'resolved_raw');
  rl.resolvedRaw = null;
  marked.sync.github.refs.other[JSON.stringify(['pr:1', 'file', `src/${tok}.ts`, 'pr-files'])] = null;
  assert.throws(() => checkOutbound(marked), (e) => e.code === 'outbound-secret' && e.table === 'sync_state');
});
