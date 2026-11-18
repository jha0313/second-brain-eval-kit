#!/usr/bin/env node
// Golden fixture (Q0): the public test fixture built into code.db plus a hand-made github.db, and the keys, tuples,
// hashes and checksum that src/pg/contract.mjs gives them. goldenState() is the reference reading of the two SQLite
// files: lane B's snapshot() must reproduce expected.json; lane A's mirror tests start from seed.sql (run 1 = this state).
//   node test/pg/golden/build-golden.mjs           rewrite expected.json and seed.sql
//   node test/pg/golden/build-golden.mjs --check   exit 1 when the committed files differ
// Determinism: fixed git dates and no user git config (stable commit sha); the volatile meta values (build_id,
// built_at, timings) are pinned after the build.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureRepo, makeGithubDb } from '../../phase1/helpers.mjs';
import * as C from '../../../src/pg/contract.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const EXPECTED = join(here, 'expected.json');
export const SEED = join(here, 'seed.sql');
const DATE = '2026-11-01T00:00:00Z';
const BUILD_ID = 'golden00';

// GitHub memory: a PR with a review and a review comment, an issue with a comment, refs in every status
const GH = {
  items: [
    { kind: 'pr', number: 1121, detail_for: '2026-09-12T10:00:00Z', reviews_at: '2026-09-12T11:00:00Z' },
    { kind: 'review', id: 9, number: 1121, state: 'CHANGES_REQUESTED', author: 'dave', author_assoc: 'MEMBER',
      body: 'Reserve before the run starts: charging after lets a failed run go free.', submitted_at: '2026-09-11T09:00:00Z',
      url: 'https://github.com/o/r/pull/1121#pullrequestreview-9' },
    { kind: 'review_comment', id: 7, number: 1121, review_id: 9, author: 'dave', author_assoc: 'MEMBER', path: 'src/lib/credits.ts',
      side: 'RIGHT', line: 4, original_line: 4, commit_id: 'c'.repeat(40), original_commit_id: 'c'.repeat(40),
      body: 'reserve() has to run first', url: 'https://github.com/o/r/pull/1121#discussion_r7' },
    { kind: 'issue', number: 45, title: '크레딧 예약 순서', body: 'Do failed runs still use credits? See src/lib/credits.ts',
      url: 'https://github.com/o/r/issues/45', flags: 'suspicious', redactions: 1 },
    { kind: 'issue_comment', id: 8, number: 45, author: 'erin', body: '실행 전에 크레딧을 예약 (#12)', url: 'https://github.com/o/r/issues/45#issuecomment-8' },
  ],
  refs: [
    { ptr: 'pr:1121', kind: 'file', target: 'src/lib/credits.ts', origin: 'pr-files', status: 'linked', resolved: ['src/lib/credits.ts'], resolved_build: BUILD_ID },
    { ptr: 'pr:1121', kind: 'symbol', target: 'Plan', origin: 'text', status: 'ambiguous', reason: 'too-many',
      resolved: ['src/lib/credits.ts#Plan', 'src/lib/credits.ts#Plan@variable'], resolved_build: BUILD_ID },
    { ptr: 'rc:7', kind: 'file', target: 'src/lib/credits.ts', origin: 'inline', status: 'linked', resolved: ['src/lib/credits.ts:4'], resolved_build: 'oldbuild' },
    { ptr: 'issue:45', kind: 'item', target: 'pr:12', origin: 'text' },                       // pending, never resolved
    { ptr: 'ic:8', kind: 'item', target: 'pr:12', origin: 'text', status: 'unlinked', reason: 'not-synced', resolved_build: BUILD_ID },
  ],
  syncState: { last_full_at: '2026-11-15T09:00:00Z', limits: JSON.stringify({ filesTruncated: 0 }), sanitize_version: 0 },
};

/** Build the fixture and both stores. @returns {{ codeDb: string, ghDb: string }} */
export function buildStores() {
  const env = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_DATE: DATE, GIT_COMMITTER_DATE: DATE };
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  let f;
  try { f = fixtureRepo(); } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  const db = new DatabaseSync(f.codeDb);
  const set = db.prepare('UPDATE meta SET value = ? WHERE key = ?');
  set.run(JSON.stringify(BUILD_ID), 'build_id');
  set.run(JSON.stringify(DATE), 'built_at');
  set.run(JSON.stringify({}), 'timings');
  db.close();
  makeGithubDb(f.codeDb, GH);
  return { codeDb: f.codeDb, ghDb: f.ghDb };
}

const groupBy = (rows, keyOf) => {
  const m = new Map();
  for (const r of rows) { const k = keyOf(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  return m;
};

/** The reference snapshot of two SQLite files (contract.State, manifest: every scope complete). */
export function goldenState(codeDbPath, ghDbPath) {
  const code = new DatabaseSync(codeDbPath, { readOnly: true }), gh = new DatabaseSync(ghDbPath, { readOnly: true });
  const all = (db, sql) => db.prepare(sql).all();
  try {
    const meta = Object.fromEntries(all(code, 'SELECT key, value FROM meta').map((r) => [r.key, JSON.parse(r.value)]));
    const own = Object.keys(meta).filter((k) => !C.MIRROR_META_KEYS.includes(k));
    for (const k of own) if (!C.COLUMN_MAP[`code.meta[${k}]`]) throw new Error(`meta key ${k} is not in COLUMN_MAP`);
    const runMeta = Object.fromEntries(own.filter((k) => !C.COLUMN_MAP[`code.meta[${k}]`].dropped).map((k) => [k, meta[k]]));

    const nodeRows = all(code, 'SELECT * FROM nodes ORDER BY id');
    const keyOf = C.canonicalNodeKeys(nodeRows);
    const fileKey = new Map(nodeRows.filter((n) => n.kind === 'file').map((n) => [n.path, keyOf.get(n.id)]));
    const nodes = new Map();
    for (const r of nodeRows) {
      const key = keyOf.get(r.id), nodeKind = C.nodeKindOf(r.kind);
      const rev = C.nodeRev(r, r.parent === null ? null : keyOf.get(r.parent));
      const file = nodeKind === 'symbol' ? fileKey.get(r.path) : null;
      if (file === undefined) throw new Error(`symbol ${key} has no file node`);
      nodes.set(key, { key, nodeKind, path: r.path, file, rev, hash: C.nodeHash(rev) });
    }

    const items = new Map(), chunkAt = new Map();
    for (const [ptr, rows] of groupBy(all(code, 'SELECT * FROM chunks ORDER BY id'), C.repoItemPtr)) {
      const chunks = C.orderChunks(rows).map((r, ord) => { chunkAt.set(r.id, { ptr, ord }); return C.chunkFields(r, ord); });
      const rev = C.repoItemRev(meta.sanitize_version);
      items.set(ptr, { ptr, kind: rows[0].source, origin: 'repo', rev, chunks, refs: [], hash: C.itemHash(rev, chunks, []) });
    }
    const sync = gh.prepare('SELECT * FROM sync_state WHERE id = 1').get();
    const ghItems = all(gh, 'SELECT * FROM items ORDER BY id'), ghRefs = all(gh, 'SELECT * FROM refs ORDER BY rowid');
    const refsOf = groupBy(ghRefs, (r) => r.ptr);
    for (const it of ghItems) {
      const ptr = C.githubItemPtr(it), rev = C.githubItemRev(it, sync.sanitize_version), chunks = [C.githubSearchChunk(rev)];
      const refs = C.orderRefs(refsOf.get(ptr) ?? []).map((r) => ({ kind: r.kind, target: r.target, origin: r.origin }));
      items.set(ptr, { ptr, kind: it.kind, origin: 'github', rev, chunks, refs, hash: C.itemHash(rev, chunks, refs) });
    }

    const facts = { edge: new Map(), unresolved: new Map(), link: new Map(), ref_link: new Map() };
    const put = (table, tuple, fields) => facts[table].set(C.hex(C.factKey(tuple)), fields);
    for (const e of all(code, 'SELECT * FROM edges')) {
      if (e.path !== null && !fileKey.has(e.path)) throw new Error(`edge site ${e.path} is not a file node`);
      const f = { src: keyOf.get(e.src), dst: keyOf.get(e.dst), kind: e.kind, site: e.path, line: e.line, col: e.col };
      put('edge', C.edgeTuple(f), f);
    }
    for (const u of all(code, 'SELECT * FROM unresolved')) {
      const f = { path: u.path, line: u.line, spec: u.spec, local: u.local };
      put('unresolved', C.unresolvedTuple(f), f);
    }
    for (const l of all(code, 'SELECT * FROM links')) {
      const c = chunkAt.get(l.chunk);
      const f = { ptr: c.ptr, revHash: C.hex(items.get(c.ptr).hash), ord: c.ord, node: keyOf.get(l.node), kind: l.kind, evidence: l.evidence };
      put('link', C.linkTuple(f), f);
    }
    const p0 = new Map(nodeRows.map((r) => [r.key, keyOf.get(r.id)]));
    for (const [ptr, rows] of refsOf) {
      if (!items.has(ptr)) throw new Error(`refs for unknown item ${ptr}`);
      C.orderRefs(rows).forEach((r, ord) => {
        const f = { ptr, revHash: C.hex(items.get(ptr).hash), ord, status: r.status, reason: r.reason, resolvedRaw: r.resolved,
          resolved: C.canonicalResolved(r.resolved, p0) };
        put('ref_link', C.refLinkTuple(f), f);
      });
    }
    return {
      run: meta.brain_run ?? null,
      manifest: C.validateManifest({ map: 'full', docs: 'full', commits: 'append', github: 'full' }),
      meta: runMeta, nodes, items, ...facts,
      sync: { github: C.githubSyncState({ syncRow: sync, items: ghItems, refs: ghRefs, buildId: meta.build_id }) },
    };
  } finally { code.close(); gh.close(); }
}

const byteSort = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** expected.json text: one canonical-JSON entry per line, so a diff shows exactly which key moved. */
export function expectedText(state) {
  const nodes = [...state.nodes.values()].sort((a, b) => byteSort(a.key, b.key))
    .map((n) => ({ key: n.key, p0_key: n.rev.p0_key, node_kind: n.nodeKind, file: n.file, hash: C.hex(n.hash) }));
  const items = [...state.items.values()].sort((a, b) => byteSort(a.ptr, b.ptr));
  const sections = {
    nodes,
    items: items.map((i) => ({ ptr: i.ptr, kind: i.kind, origin: i.origin, hash: C.hex(i.hash), chunks: i.chunks.length, refs: i.refs.length })),
    chunks: items.flatMap((i) => i.chunks.map((c) => C.chunkKey(i.ptr, 1, c.ord))),          // rev_no 1: a first publish
    ...Object.fromEntries(['edge', 'unresolved', 'link', 'ref_link'].map((t) => [t,
      [...state[t].entries()].sort(([a], [b]) => byteSort(a, b)).map(([key, f]) => ({ key, fields: f }))])),
    sync_github: [state.sync.github],
    checksum: [C.checksum(state)],
  };
  const body = Object.entries(sections).map(([k, rows]) => `  ${JSON.stringify(k)}: [\n${rows.map((r) => `    ${C.canonicalJson(r)}`).join(',\n')}\n  ]`);
  return `{\n${body.join(',\n')}\n}\n`;
}

const q = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : typeof v === 'boolean' ? String(v)
  : `'${String(v).replaceAll("'", "''")}'`);
const json = (v) => (v === null ? 'NULL' : `${q(C.canonicalJson(v))}::jsonb`);
const bytes = (buf) => `'\\x${C.hex(buf)}'::bytea`;
const nodeId = (key) => (key === null ? 'NULL' : `(SELECT node_id FROM brain.node WHERE key = ${q(key)})`);
const itemRevId = (ptr) => `(SELECT r.rev_id FROM brain.item_rev r JOIN brain.item i USING (item_id) WHERE i.ptr = ${q(ptr)} AND r.rev_no = 1)`;

/** seed.sql text: the state published as run 1 into an empty schema brain (001_init.sql applied). */
export function seedText(state) {
  const sha = state.meta.commit, out = [];
  const ins = (table, cols, vals) => out.push(`INSERT INTO brain.${table} (${cols.join(', ')}) VALUES (${vals.join(', ')});`);
  out.push('-- generated by test/pg/golden/build-golden.mjs: the golden state published as run 1. Do not edit.',
    'BEGIN;', `SELECT pg_advisory_xact_lock(${C.PUBLISH_LOCK_KEY});`);
  ins('attempt', ['gha_run_id', 'gha_attempt', 'source_sha'], [1, 1, q(sha)]);
  out.push(`INSERT INTO brain.run (attempt_id, commit_sha, mode, tool_version, sanitize_version, meta, checksum) SELECT attempt_id, ${q(sha)}, 'normal', 'golden', ${q(state.meta.sanitize_version)}, ${json(state.meta)}, ${json(C.checksum(state))} FROM brain.attempt WHERE gha_run_id = 1 AND gha_attempt = 1;`);
  ins('binding', ['source_repo_id', 'source_repo', 'ops_repo', 'workflow'], [1, q('o/r'), q('o/brain-ops'), q('.github/workflows/brain-publish.yml')]);
  const nodes = [...state.nodes.values()].sort((a, b) => (a.nodeKind === 'symbol') - (b.nodeKind === 'symbol') || byteSort(a.key, b.key));
  for (const n of nodes) ins('node', ['key', 'node_kind', 'path', 'file_id'], [q(n.key), q(n.nodeKind), q(n.path), nodeId(n.file)]);
  for (const n of nodes) {
    const r = n.rev;
    ins('node_rev', ['node_id', 'rev_no', 'valid_from', 'hash', 'p0_key', 'kind', 'name', 'line', 'end_line', 'parent_id', 'exported', 'lang', 'flags'],
      [nodeId(n.key), 1, 'brain.publishing_run()', bytes(n.hash), q(r.p0_key), q(r.kind), q(r.name), q(r.line), q(r.end_line), nodeId(r.parent),
        q(r.exported === 1), q(r.lang), q(r.flags)]);
  }
  for (const i of [...state.items.values()].sort((a, b) => byteSort(a.ptr, b.ptr))) {
    const r = i.rev;
    ins('item', ['ptr', 'kind', 'origin'], [q(i.ptr), q(i.kind), q(i.origin)]);
    ins('item_rev', ['item_id', 'rev_no', 'valid_from', 'hash', 'title', 'body', 'state', 'author', 'source_updated_at', 'meta', 'sanitize_version'],
      [`(SELECT item_id FROM brain.item WHERE ptr = ${q(i.ptr)})`, 1, 'brain.publishing_run()', bytes(i.hash), q(r.title), q(r.body), q(r.state),
        q(r.author), q(r.source_updated_at), json(r.meta), q(r.sanitize_version)]);
    for (const c of i.chunks) {
      ins('chunk', ['rev_id', ...C.CHUNK_HASH_COLUMNS], [itemRevId(i.ptr), ...C.CHUNK_HASH_COLUMNS.map((k) => q(c[k]))]);
    }
    i.refs.forEach((rf, ord) => ins('ref', ['rev_id', 'ord', 'kind', 'target', 'origin'], [itemRevId(i.ptr), ord, q(rf.kind), q(rf.target), q(rf.origin)]));
  }
  const sorted = (t) => [...state[t].entries()].sort(([a], [b]) => byteSort(a, b));
  for (const [k, e] of sorted('edge')) {
    ins('edge', ['fact_key', 'src_id', 'dst_id', 'kind', 'site_file_id', 'line', 'col', 'valid_from'],
      [`'\\x${k}'::bytea`, nodeId(e.src), nodeId(e.dst), q(e.kind), nodeId(e.site), q(e.line), q(e.col), 'brain.publishing_run()']);
  }
  for (const [k, u] of sorted('unresolved')) {
    ins('unresolved', ['fact_key', 'path', 'line', 'spec', 'local', 'valid_from'], [`'\\x${k}'::bytea`, q(u.path), q(u.line), q(u.spec), q(u.local), 'brain.publishing_run()']);
  }
  for (const [k, l] of sorted('link')) {
    ins('link', ['fact_key', 'chunk_id', 'node_id', 'kind', 'evidence', 'valid_from'],
      [`'\\x${k}'::bytea`, `(SELECT chunk_id FROM brain.chunk WHERE rev_id = ${itemRevId(l.ptr)} AND ord = ${l.ord})`, nodeId(l.node), q(l.kind), q(l.evidence), 'brain.publishing_run()']);
  }
  for (const [k, r] of sorted('ref_link')) {
    ins('ref_link', ['fact_key', 'ref_id', 'status', 'reason', 'resolved', 'resolved_raw', 'valid_from'],
      [`'\\x${k}'::bytea`, `(SELECT ref_id FROM brain.ref WHERE rev_id = ${itemRevId(r.ptr)} AND ord = ${r.ord})`, q(r.status), q(r.reason), json(r.resolved), q(r.resolvedRaw), 'brain.publishing_run()']);
  }
  ins('sync_state', ['run_id', 'source', 'state'], ['brain.publishing_run()', q('github'), json(state.sync.github)]);
  out.push("UPDATE brain.attempt SET status = 'ok', finished_at = now() WHERE gha_run_id = 1 AND gha_attempt = 1;", 'COMMIT;', '');
  return out.join('\n');
}

/** @returns {{ expected: string, seed: string, codeDb: string, ghDb: string, state: object }} */
export function buildGolden() {
  const { codeDb, ghDb } = buildStores();
  const state = goldenState(codeDb, ghDb);
  return { expected: expectedText(state), seed: seedText(state), codeDb, ghDb, state };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const g = buildGolden();
  if (process.argv.includes('--check')) {
    const bad = [[EXPECTED, g.expected], [SEED, g.seed]].filter(([p, text]) => readFileSync(p, 'utf8') !== text).map(([p]) => p);
    if (bad.length) { console.error(`golden differs: ${bad.join(', ')} (rerun without --check and review the diff)`); process.exit(1); }
    console.log('golden ok');
  } else {
    writeFileSync(EXPECTED, g.expected);
    writeFileSync(SEED, g.seed);
    console.log(`wrote ${EXPECTED} and ${SEED}`);
  }
}
