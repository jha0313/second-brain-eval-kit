// Q0 contract tests (no network): canonical keys (V8), fact keys and content hashes, COLUMN_MAP coverage against the
// live SQLite schemas and the DDL, revision pointers, manifest, checksum, golden fixture.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from '../../src/pg/contract.mjs';
import { openGithubDb } from '../../src/gh-schema.mjs';
import { runBrain } from '../phase1/helpers.mjs';
import { buildGolden, EXPECTED, SEED } from './golden/build-golden.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const DDL = readFileSync(join(here, '..', '..', 'sql', '001_init.sql'), 'utf8');
let golden;
before(() => { golden = buildGolden(); });

/** a one-file TypeScript repo, built; returns its nodes rows */
function buildTiny(source) {
  const repo = mkdtempSync(join(tmpdir(), 'brain-q0-'));
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true }, include: ['src'] }));
  writeFileSync(join(repo, 'src', 'v8.ts'), source);
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo });
  git('init', '-q'); git('add', '-A'); git('commit', '-q', '-m', 'v8');
  const db = join(repo, '..', `${repo.split('/').pop()}.db`);
  const r = runBrain(['build', '.', '--db', db], { cwd: repo, env: { BRAIN_DB: db } });
  assert.equal(r.status, 0, r.stderr);
  const code = new DatabaseSync(db, { readOnly: true });
  try { return code.prepare('SELECT * FROM nodes ORDER BY id').all(); } finally { code.close(); }
}

test('V8: canonical keys survive a const/type order swap and keep A.run apart from B.run', () => {
  const classes = 'export class A { run() {} }\nexport class B { run() {} }\ndeclare module "@scope/pkg" {}\n';
  const one = buildTiny(`export const X = 1;\nexport type X = number;\n${classes}`);
  const two = buildTiny(`export type X = number;\nexport const X = 1;\n${classes}`);
  const p0 = (rows, kind) => rows.find((r) => r.name === 'X' && r.kind === kind).key;
  assert.equal(p0(one, 'variable'), 'src/v8.ts#X');                      // Phase 0: the first declaration owns the bare key
  assert.equal(p0(two, 'type'), 'src/v8.ts#X');
  const keys = (rows) => [...C.canonicalNodeKeys(rows).values()].sort();
  assert.deepEqual(keys(one), keys(two));                                // no new identity
  for (const k of ['src/v8.ts#X@variable', 'src/v8.ts#X@type', 'src/v8.ts#A.run@method', 'src/v8.ts#B.run@method', 'src/v8.ts#@scope/pkg@namespace']) {
    assert.ok(keys(one).includes(k), k);
  }
});

test('canonicalNodeKey: files, dirs, symbols with and without the clash suffix, members, any module name; bad rows throw', () => {
  const file = { kind: 'file', name: 'b.ts' }, cls = { kind: 'class', name: 'A' };
  const sym = (key, kind, name, parent = file, path = 'a/b.ts') => C.canonicalNodeKey({ key, kind, path, name }, parent);
  assert.equal(C.canonicalNodeKey({ key: 'a/b.ts', kind: 'file', path: 'a/b.ts', name: 'b.ts' }), 'a/b.ts');
  assert.equal(C.canonicalNodeKey({ key: 'dir:a', kind: 'dir', path: 'a', name: 'a' }), 'dir:a');
  assert.equal(sym('a/b.ts#Plan', 'type', 'Plan'), 'a/b.ts#Plan@type');
  assert.equal(sym('a/b.ts#Plan@variable', 'variable', 'Plan'), 'a/b.ts#Plan@variable');
  assert.equal(sym('a/b.ts#A.run', 'method', 'run', cls), 'a/b.ts#A.run@method');
  assert.equal(sym('a#b.ts#A.#x', 'property', '#x', cls, 'a#b.ts'), 'a#b.ts#A.#x@property');
  assert.equal(sym('a/b.ts#@scope/pkg', 'namespace', '@scope/pkg'), 'a/b.ts#@scope/pkg@namespace');     // declare module "@scope/pkg"
  assert.equal(sym('a/b.ts#X@namespace', 'namespace', 'X@namespace'), 'a/b.ts#X@namespace@namespace');   // declare module "X@namespace"
  assert.equal(sym('a/b.ts#X@namespace', 'namespace', 'X'), 'a/b.ts#X@namespace');                     // namespace X after const X
  assert.equal(sym('a/b.ts#variable@variable', 'variable', 'variable'), 'a/b.ts#variable@variable');
  assert.throws(() => C.canonicalNodeKey({ key: 'x.ts#Y', kind: 'function', path: 'other.ts', name: 'Y' }, file), { code: 'contract' });
  assert.throws(() => sym('a/b.ts#run', 'method', 'run', cls), { code: 'contract' });                  // a member keeps its class
  assert.throws(() => C.canonicalNodeKey({ key: 'dir:a', kind: 'file', path: 'a', name: 'a' }), { code: 'contract' });
  const f = { id: 1, key: 'f', kind: 'file', path: 'f', name: 'f', parent: null };
  assert.throws(() => C.canonicalNodeKeys([f, { id: 2, key: 'f#X', kind: 'variable', path: 'f', name: 'X', parent: 1 },
    { id: 3, key: 'f#X@variable', kind: 'variable', path: 'f', name: 'X', parent: 1 }]), /collision f#X@variable/);
  assert.throws(() => C.canonicalNodeKeys([{ id: 2, key: 'f#X', kind: 'variable', path: 'f', name: 'X', parent: 9 }]), /missing parent/);
});

test('item pointers: repo chunks, commits, GitHub items; vault never leaves the laptop', () => {
  assert.equal(C.repoItemPtr({ source: 'doc', path: 'docs/a.md', sha: null }), 'doc:docs/a.md');
  assert.equal(C.repoItemPtr({ source: 'commit', path: null, sha: 'a'.repeat(40) }), `commit:${'a'.repeat(40)}`);
  assert.throws(() => C.repoItemPtr({ source: 'commit', path: null, sha: 'abc1234' }), { code: 'contract' });
  assert.throws(() => C.repoItemPtr({ source: 'vault', path: 'vault:n.md', sha: null }), /local-only/);
  assert.equal(C.githubItemPtr({ ptr: 'rc:7', kind: 'review_comment' }), 'rc:7');
  assert.throws(() => C.githubItemPtr({ ptr: 'rc:7', kind: 'issue_comment' }), { code: 'contract' });
  assert.equal(C.scopeOfItem('commit'), 'commits');
  assert.equal(C.scopeOfItem('changelog'), 'docs');
  assert.equal(C.scopeOfItem('review'), 'github');
});

test('factKey and content hashes are deterministic, see every listed column and skip the ledger', () => {
  const e = { src: 'a.ts', dst: 'b.ts', kind: 'imports', site: 'a.ts', line: 1, col: 0 };
  assert.deepEqual(C.factKey(C.edgeTuple(e)), C.factKey(C.edgeTuple({ ...e })));
  assert.notDeepEqual(C.factKey(C.edgeTuple(e)), C.factKey(C.edgeTuple({ ...e, col: 1 })));
  assert.throws(() => C.factKey(C.edgeTuple({ ...e, col: undefined })), { code: 'contract' });   // a missing field never hashes like null
  assert.equal(C.canonicalJson({ b: 1, a: [null, 'x'] }), '{"a":[null,"x"],"b":1}');

  const row = { key: 'a.ts#f', kind: 'function', name: 'f', line: 1, end_line: 2, exported: 1, lang: 'ts', flags: '' };
  const h = C.nodeHash(C.nodeRev(row, 'a.ts'));
  assert.deepEqual(h, C.nodeHash(C.nodeRev({ ...row }, 'a.ts')));
  for (const [k, v] of [['line', 3], ['exported', 0], ['flags', 'test'], ['key', 'a.ts#f@function']]) {
    assert.notDeepEqual(C.nodeHash(C.nodeRev({ ...row, [k]: v }, 'a.ts')), h, k);
  }
  assert.notDeepEqual(C.nodeHash(C.nodeRev(row, 'b.ts')), h, 'parent');

  const item = { title: 't', body: 'b', state: 'open', author: 'x', updated_at: '2026-01-01T00:00:00Z', detail_for: null, reviews_at: null,
    ...Object.fromEntries(C.ITEM_META_COLUMNS.map((c) => [c, null])) };
  const hashOf = (it, sv = 1, refs = []) => { const rev = C.githubItemRev(it, sv); return C.itemHash(rev, [C.githubSearchChunk(rev)], refs); };
  const ih = hashOf(item);
  assert.deepEqual(hashOf({ ...item, detail_for: '2026-02-01T00:00:00Z', reviews_at: '2026-02-01T00:00:00Z' }), ih);   // ledger
  for (const [k, v] of [['body', 'c'], ['updated_at', '2026-01-02T00:00:00Z'], ['flags', 'suspicious'], ['redactions', 1]]) {
    assert.notDeepEqual(hashOf({ ...item, [k]: v }), ih, k);
  }
  assert.notDeepEqual(hashOf(item, 2), ih, 'sanitize_version');
  assert.notDeepEqual(hashOf(item, 1, [{ kind: 'file', target: 'a.ts', origin: 'text' }]), ih, 'refs');
  assert.throws(() => C.itemHash(C.repoItemRev(1), [{ ...C.githubSearchChunk({ title: null, body: null }), ord: 1 }], []), /ord 1 at index 0/);
  assert.deepEqual(Object.isFrozen(C.NODE_HASH_COLUMNS) && Object.isFrozen(C.ITEM_HASH_COLUMNS), true);
});

test('refs order and resolved canonicalization', () => {
  const refs = [{ kind: 'symbol', target: 'Plan', origin: 'text' }, { kind: 'file', target: 'b.ts', origin: 'text' }, { kind: 'file', target: 'a.ts', origin: 'text' }];
  assert.deepEqual(C.orderRefs(refs).map((r) => r.target), ['a.ts', 'b.ts', 'Plan']);
  const p0 = new Map([['f.ts#Plan', 'f.ts#Plan@type'], ['f.ts', 'f.ts']]);
  assert.deepEqual(C.canonicalResolved('["f.ts#Plan","f.ts:4","pr:12"]', p0), ['f.ts#Plan@type', 'f.ts:4', 'pr:12']);
  assert.equal(C.canonicalResolved(null, p0), null);
});

test('COLUMN_MAP covers every live code.db and github.db column, drops only local path meta, names real DDL columns', () => {
  const ghPath = join(mkdtempSync(join(tmpdir(), 'brain-q0-gh-')), 'fresh.github.db');
  openGithubDb(ghPath, { create: true }).close();
  const live = [];
  for (const [db, path] of [['code', golden.codeDb], ['github', ghPath]]) {
    const d = new DatabaseSync(path, { readOnly: true });
    const tables = d.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
    const virtual = tables.filter((t) => /^CREATE VIRTUAL TABLE/i.test(t.sql)).map((t) => t.name);
    for (const { name } of tables) {
      if (virtual.some((v) => name.startsWith(`${v}_`))) continue;          // FTS5 shadow tables
      for (const c of d.prepare(`PRAGMA table_info(${JSON.stringify(name)})`).all()) live.push(`${db}.${name}.${c.name}`);
    }
    if (db === 'code') for (const { key } of d.prepare('SELECT key FROM meta').all()) live.push(`code.meta[${key}]`);
    d.close();
  }
  const missing = live.filter((c) => !C.COLUMN_MAP[c]);
  assert.deepEqual(missing, [], `columns without a mapping: ${missing.join(', ')}`);
  const extra = Object.keys(C.COLUMN_MAP).filter((c) => !live.includes(c) && !c.endsWith('.rowid'));
  assert.deepEqual(extra, [], `mapping entries for columns that do not exist: ${extra.join(', ')}`);
  const dropped = Object.entries(C.COLUMN_MAP).filter(([, v]) => v.dropped).map(([k]) => k).sort();
  assert.deepEqual(dropped, ['code.meta[repo]', 'code.meta[worktree]']);

  const ddl = new Map();
  for (const [, table, body] of DDL.matchAll(/CREATE TABLE brain\.(\w+) \(\n([\s\S]*?)\n\);/g)) {
    ddl.set(table, body.split('\n').map((l) => /^\s+([a-z_][a-z0-9_]*)\s/.exec(l)?.[1]).filter(Boolean));
  }
  assert.ok(ddl.size >= 14, 'all 14 tables parsed');
  const targets = Object.values(C.COLUMN_MAP).flatMap((v) => (v.to ? [].concat(v.to) : []));
  const unknown = targets.filter((t) => { const [table, col] = t.split('.'); return !ddl.get(table)?.includes(col); });
  assert.deepEqual(unknown, [], `COLUMN_MAP targets missing from 001_init.sql: ${unknown.join(', ')}`);
});

test('revision pointers round-trip and never collide with a Phase 1 build suffix', () => {
  for (const [s, base, rev] of [['pr:1121@r2', 'pr:1121', 2], ['doc:docs/billing.md:12-31@r3', 'doc:docs/billing.md:12-31', 3],
    ['doc:a@r1.md:1-2@r10', 'doc:a@r1.md:1-2', 10], ['commit:6b820f87', 'commit:6b820f87', null], ['pr:1@r999999', 'pr:1', 999999]]) {
    assert.deepEqual(C.parseRevPtr(s), { base, rev }, s);
    assert.equal(C.formatRevPtr(base, rev), s);
  }
  assert.deepEqual(C.parseRevPtr('doc:x.md:1-5@r1234567'), { base: 'doc:x.md:1-5@r1234567', rev: null });   // 8-char build id
  assert.deepEqual(C.parseRevPtr('pr:1@r0'), { base: 'pr:1@r0', rev: null });
  for (const bad of [0, 1000000, 1.5]) assert.throws(() => C.formatRevPtr('pr:1', bad), { code: 'contract' });
  assert.deepEqual(C.chunkKey('doc:docs/a.md', 3, 0), ['doc:docs/a.md', 3, 0]);
});

test('manifest validator', () => {
  const ok = { map: 'full', docs: 'full', commits: 'append', github: 'incremental' };
  assert.deepEqual(C.validateManifest(ok), ok);
  assert.ok(Object.isFrozen(C.validateManifest({ ...ok, github: 'full' })));
  for (const bad of [null, [], { ...ok, map: 'append' }, { ...ok, commits: 'full' }, { ...ok, extra: 'full' }, { map: 'full' }]) {
    assert.throws(() => C.validateManifest(bad), { code: 'contract' }, JSON.stringify(bad));
  }
});

test('checksum: per-table rows and sha256, independent of insertion order, split by mirror shape', () => {
  const s = golden.state;
  const shuffled = { ...s, nodes: new Map([...s.nodes].reverse()), items: new Map([...s.items].reverse()), edge: new Map([...s.edge].reverse()) };
  assert.deepEqual(C.checksum(shuffled), C.checksum(s));
  const sum = C.checksum(s);
  assert.deepEqual(Object.keys(sum).sort(), [...C.CHECKSUM_SHAPES.code, ...C.CHECKSUM_SHAPES.github].sort());
  assert.equal(sum.node.rows, s.nodes.size);
  assert.deepEqual(Object.keys(C.checksum(s, ['code'])).sort(), [...C.CHECKSUM_SHAPES.code].sort());
  const empty = C.checksum({ nodes: new Map(), items: new Map(), edge: new Map(), unresolved: new Map(), link: new Map(), ref_link: new Map(),
    meta: {}, sync: { github: null } });
  assert.deepEqual(empty.edge, { rows: 0, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' });
  assert.deepEqual(empty['sync.github'], empty.edge);
  assert.equal(empty.meta.rows, 1);
  const cursorMoved = { ...s, sync: { github: { ...s.sync.github, row: { ...s.sync.github.row, cursor: '2000-01-01T00:00:00Z' } } } };
  assert.notEqual(C.checksum(cursorMoved)['sync.github'].sha256, sum['sync.github'].sha256);   // a corrupted cursor fails the mirror check
  assert.notEqual(C.checksum({ ...s, meta: { ...s.meta, build_id: 'x' } }).meta.sha256, sum.meta.sha256);
});

test('golden: the fixture snapshots to the committed expected.json and seed.sql', () => {
  assert.equal(golden.expected, readFileSync(EXPECTED, 'utf8'), 'expected.json is stale: node test/pg/golden/build-golden.mjs');
  assert.equal(golden.seed, readFileSync(SEED, 'utf8'), 'seed.sql is stale: node test/pg/golden/build-golden.mjs');
  const keys = [...golden.state.nodes.keys()];
  assert.ok(keys.includes('src/lib/credits.ts#Plan@type') && keys.includes('src/lib/credits.ts#Plan@variable'));
  const plan = [...golden.state.ref_link.values()].find((r) => r.ptr === 'pr:1121' && r.status === 'ambiguous');
  assert.deepEqual(plan.resolved, ['src/lib/credits.ts#Plan@type', 'src/lib/credits.ts#Plan@variable']);
  assert.deepEqual(golden.state.sync.github.refs.other, { '["issue:45","item","pr:12","text"]': null, '["rc:7","file","src/lib/credits.ts","inline"]': 'oldbuild' });
  assert.ok(!('repo' in golden.state.meta) && !('worktree' in golden.state.meta));
  assert.equal(golden.state.run, null);
});

test('the DDL checks the same publish lock key; no password in 002; store methods', () => {
  assert.ok(DDL.includes(`pg_advisory_xact_lock(${C.PUBLISH_LOCK_KEY})`), 'guard_run takes PUBLISH_LOCK_KEY');
  assert.ok(!/PASSWORD/i.test(readFileSync(join(here, '..', '..', 'sql', '002_roles.sql'), 'utf8').replace(/^--.*$/gm, '')), 'no password in 002');
  assert.deepEqual([...C.STORE_METHODS], ['candidates', 'rows', 'get', 'source', 'resolveAsOf', 'close']);
});

test('Phase 3 S0: staleness, footer phrases, attempt display, refresh and ci-publish constants, faults', async () => {
  const c = await import('../../src/pg/contract.mjs');
  const s = (code, memory) => ({ code: { state: code }, memory: { state: memory } });
  for (const code of c.CODE_STATES) for (const memory of c.MEMORY_STATES)
    assert.equal(c.needsRefresh(s(code, memory)), ['behind', 'differs'].includes(code) || ['old', 'never'].includes(memory), `${code}/${memory}`);
  assert.equal(c.FOOTER_PHRASES.code.behind(3), '3 commits behind main');
  assert.equal(c.FOOTER_PHRASES.memory.old('27h'), 'github as of 27h ago (stale)');
  for (const t of c.REFRESH_TRIGGERS) assert.ok([c.FOOTER_PHRASES.code.behind(2), c.FOOTER_PHRASES.code.differs,
    c.FOOTER_PHRASES.memory.old('1h'), c.FOOTER_PHRASES.memory.never].some((p) => p.includes(t)), t);
  assert.equal(c.attemptDisplay({ db: null, actions: 'queued' }), 'queued');
  assert.equal(c.attemptDisplay({ db: null, actions: 'cancelled' }), 'failed before start');
  assert.equal(c.attemptDisplay({ db: 'running', actions: 'in_progress' }), 'running');
  assert.equal(c.attemptDisplay({ db: 'running', actions: 'completed_failure' }), 'abandoned');
  assert.equal(c.attemptDisplay({ db: 'running', actions: 'unknown', startedAtMs: 0, nowMs: 31 * 60_000 }), 'abandoned?');
  assert.equal(c.attemptDisplay({ db: 'running', actions: 'unknown', startedAtMs: 0, nowMs: 29 * 60_000 }), 'running?');
  assert.equal(c.attemptDisplay({ db: 'ok', actions: 'completed_failure' }), 'ok');
  assert.equal(c.attemptDisplay({ db: 'running', actions: 'in_progress', commitUnconfirmed: true }), 'outcome unknown');
  assert.deepEqual([c.ageText(59_000), c.ageText(12 * 60_000), c.ageText(27 * 3600_000), c.ageText(80 * 3600_000)], ['59s', '12m', '27h', '3d']);
  assert.deepEqual(c.REFRESH_EXIT, { fresh: 0, failed: 1, unavailable: 2, running: 75 });
  assert.equal(c.ciError('publish', 'timeout'), 'publish:timeout');
  assert.throws(() => c.ciError('publish', 'free text with a secret'));
  const base = { firstAttempt: true, mode: 'normal', full: false, latestCommit: 'a', sourceCommit: 'a', latestT: '2026-11-16T10:00:00Z',
    runCreatedAt: '2026-11-16T09:59:00Z', latestTool: 't', tool: 't', latestSanitize: 1, sanitize: 1 };
  assert.equal(c.shouldSkip(base), true);
  for (const over of [{ firstAttempt: false }, { mode: 'bootstrap' }, { full: true }, { sourceCommit: 'b' }, { latestT: '2026-11-16T09:58:00Z' },
    { latestT: null }, { tool: 'u' }, { sanitize: 2 }]) assert.equal(c.shouldSkip({ ...base, ...over }), false, JSON.stringify(over));
  assert.equal(c.parseFault({ BRAIN_FAULT: 'build:fail' }), null);
  assert.deepEqual(c.parseFault({ BRAIN_FAULT: 'build:fail', BRAIN_FAULT_ALLOW: '1' }), { stage: 'build', point: 'fail' });
  assert.throws(() => c.parseFault({ BRAIN_FAULT: 'nope:x', BRAIN_FAULT_ALLOW: '1' }));
  for (const k of Object.keys(c.FAULT_POINTS)) assert.ok(c.CI_STAGES.includes(k.split(':')[0]), k);
});
