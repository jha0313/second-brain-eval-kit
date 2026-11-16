// snapshot · delta · upload check (Q2). Lane B owns this file.
// No network, no server access: everything here is a pure function of SQLite files and in-memory states.
//
// snapshot rules (keys, tuples and hashes come from contract.mjs; test/pg/golden/expected.json is the reference):
// 1. nodes: every code.db nodes row -> canonicalNodeKeys (keyName from name + parent row; throws on a collision),
//    nodeRev(row, parent key), nodeHash.
// 2. repo items: code.db chunks grouped by repoItemPtr (vault throws); orderChunks -> ord; chunkFields;
//    repoItemRev(meta.sanitize_version); itemHash(rev, chunks, []).
// 3. GitHub items: github.db items rows; githubItemRev(row, sync_state.sanitize_version); chunks = [githubSearchChunk];
//    refs of the ptr in orderRefs order; itemHash.
// 4. facts, merged by fact key (Phase 0 edges have no unique constraint): edgeTuple (canonical src/dst, site = edges.path),
//    unresolvedTuple, linkTuple (chunk = its item ptr + hex item hash + ord), refLinkTuple (ord = orderRefs index,
//    resolved = canonicalResolved(refs.resolved, p0 key -> canonical key)).
// 5. meta: code.db meta values parsed, without the COLUMN_MAP dropped keys and MIRROR_META_KEYS; State.run = meta
//    brain_run (a mirror) or null (a fresh build). sync.github: githubSyncState; null without a github.db.
//
// diff rules (R7, R8, R15). The map (nodes, edge, unresolved) and docs are `full`: what next lacks closes. A link or
// ref_link belongs to its item:
// - commit link (`append`, R8): closes only when its target node closes or its commit gets a new revision. A commit
//   that the build still sees keeps a link the build no longer makes (a mention that became ambiguous).
// - ref_link (`github`): `full` closes what next lacks; `incremental` closes it when next has the item (the sync saw
//   it, so its refs are the new ones) and keeps it otherwise, resolved again against next's nodes (a Phase 0 key can
//   name another node after a rebuild), so a mirror of the new run snapshots to the same facts.
// R15: a sanitize_version bump (code or GitHub) needs manifest.github = 'full' and a GitHub state at the new version;
// commit items that the build did not recreate (outside the build window) are sanitized again from the base and get a
// new revision, and their links move to it.
import { DatabaseSync } from 'node:sqlite';
import * as C from './contract.mjs';
import { BrainError } from '../errors.mjs';
import { SANITIZE_VERSION, mask, normalize, sanitize } from '../sanitize.mjs';

const fail = (msg) => { throw new BrainError('contract', msg); };
const FACTS = Object.freeze(['edge', 'unresolved', 'link', 'ref_link']);
const TUPLE = Object.freeze({ edge: C.edgeTuple, unresolved: C.unresolvedTuple, link: C.linkTuple, ref_link: C.refLinkTuple });

/** hex fact key of a fact's named fields (State map values and Delta put entries). @param {'edge'|'unresolved'|'link'|'ref_link'} table */
export const factKeyOf = (table, fields) => C.hex(C.factKey(TUPLE[table](fields)));

const emptyState = () => ({ run: null, manifest: null, meta: {}, nodes: new Map(), items: new Map(),
  ...Object.fromEntries(FACTS.map((t) => [t, new Map()])), sync: { github: null } });

const groupBy = (rows, keyOf) => {
  const m = new Map();
  for (const r of rows) { const k = keyOf(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  return m;
};

/**
 * @param {{ codeDb: string, githubDb: string|null, manifest: import('./contract.mjs').Manifest }} opts SQLite paths
 * @returns {import('./contract.mjs').State}
 */
export function snapshot({ codeDb, githubDb, manifest }) {
  const valid = C.validateManifest(manifest);
  const code = new DatabaseSync(codeDb, { readOnly: true });
  const gh = githubDb ? new DatabaseSync(githubDb, { readOnly: true }) : null;
  const all = (db, sql) => db.prepare(sql).all();
  try {
    const meta = Object.fromEntries(all(code, 'SELECT key, value FROM meta').map((r) => [r.key, JSON.parse(r.value)]));
    if (!Number.isInteger(meta.sanitize_version)) fail('code.db has no sanitize_version: rebuild it with this kit');
    const own = Object.keys(meta).filter((k) => !C.MIRROR_META_KEYS.includes(k));
    for (const k of own) if (!C.COLUMN_MAP[`code.meta[${k}]`]) fail(`code.db meta key ${k} is not in COLUMN_MAP`);
    const runMeta = Object.fromEntries(own.filter((k) => !C.COLUMN_MAP[`code.meta[${k}]`].dropped).map((k) => [k, meta[k]]));

    const nodeRows = all(code, 'SELECT * FROM nodes ORDER BY id');
    const keyOf = C.canonicalNodeKeys(nodeRows);
    const fileKey = new Map(nodeRows.filter((n) => n.kind === 'file').map((n) => [n.path, keyOf.get(n.id)]));
    const nodes = new Map();
    for (const r of nodeRows) {
      const key = keyOf.get(r.id), nodeKind = C.nodeKindOf(r.kind);
      const rev = C.nodeRev(r, r.parent === null ? null : keyOf.get(r.parent));
      const file = nodeKind === 'symbol' ? fileKey.get(r.path) : null;
      if (file === undefined) fail(`symbol ${key} has no file node`);
      nodes.set(key, { key, nodeKind, path: r.path, file, rev, hash: C.nodeHash(rev) });
    }

    const items = new Map(), chunkAt = new Map();
    for (const [ptr, rows] of groupBy(all(code, 'SELECT * FROM chunks ORDER BY id'), C.repoItemPtr)) {
      const chunks = C.orderChunks(rows).map((r, ord) => { chunkAt.set(r.id, { ptr, ord }); return C.chunkFields(r, ord); });
      const rev = C.repoItemRev(meta.sanitize_version);
      items.set(ptr, { ptr, kind: rows[0].source, origin: 'repo', rev, chunks, refs: [], hash: C.itemHash(rev, chunks, []) });
    }

    let sync = null, ghItems = [], ghRefs = [];
    if (gh) {
      sync = gh.prepare('SELECT * FROM sync_state WHERE id = 1').get();
      if (!sync) fail('github.db has no sync_state row');
      ghItems = all(gh, 'SELECT * FROM items ORDER BY id');
      ghRefs = all(gh, 'SELECT * FROM refs ORDER BY rowid');
      if (ghItems.length && !Number.isInteger(sync.sanitize_version)) fail('github.db has items but no sanitize_version: run brain sync --full');
    }
    const refsOf = groupBy(ghRefs, (r) => r.ptr);
    for (const it of ghItems) {
      const ptr = C.githubItemPtr(it), rev = C.githubItemRev(it, sync.sanitize_version), chunks = [C.githubSearchChunk(rev)];
      const refs = C.orderRefs(refsOf.get(ptr) ?? []).map((r) => ({ kind: r.kind, target: r.target, origin: r.origin }));
      items.set(ptr, { ptr, kind: it.kind, origin: 'github', rev, chunks, refs, hash: C.itemHash(rev, chunks, refs) });
    }

    const facts = Object.fromEntries(FACTS.map((t) => [t, new Map()]));
    const put = (table, fields) => facts[table].set(factKeyOf(table, fields), fields);
    for (const e of all(code, 'SELECT * FROM edges')) {
      if (e.path !== null && !fileKey.has(e.path)) fail(`edge site ${e.path} is not a file node`);
      put('edge', { src: keyOf.get(e.src), dst: keyOf.get(e.dst), kind: e.kind, site: e.path, line: e.line, col: e.col });
    }
    for (const u of all(code, 'SELECT * FROM unresolved')) put('unresolved', { path: u.path, line: u.line, spec: u.spec, local: u.local });
    for (const l of all(code, 'SELECT * FROM links')) {
      const c = chunkAt.get(l.chunk) ?? fail(`link to a missing chunk ${l.chunk}`);
      put('link', { ptr: c.ptr, revHash: C.hex(items.get(c.ptr).hash), ord: c.ord, node: keyOf.get(l.node) ?? fail(`link to a missing node ${l.node}`),
        kind: l.kind, evidence: l.evidence });
    }
    const p0 = new Map(nodeRows.map((r) => [r.key, keyOf.get(r.id)]));
    for (const [ptr, rows] of refsOf) {
      if (!items.has(ptr)) fail(`refs for unknown item ${ptr}`);
      C.orderRefs(rows).forEach((r, ord) => put('ref_link', { ptr, revHash: C.hex(items.get(ptr).hash), ord, status: r.status,
        reason: r.reason, resolvedRaw: r.resolved, resolved: C.canonicalResolved(r.resolved, p0) }));
    }
    return {
      run: meta.brain_run ?? null, manifest: valid, meta: runMeta, nodes, items, ...facts,
      sync: { github: sync ? C.githubSyncState({ syncRow: sync, items: ghItems, refs: ghRefs, buildId: meta.build_id }) : null },
    };
  } finally { code.close(); gh?.close(); }
}

/** R15: base commit items the build did not recreate, sanitized again with this kit's rules; their links move along. */
function resanitized(base, next, version) {
  const items = new Map(), links = new Map();
  for (const i of base.items.values()) {
    if (i.kind !== 'commit' || next.items.has(i.ptr) || i.rev.sanitize_version >= version) continue;
    const clean = (s) => (s === null ? null : sanitize(s).text);
    const chunks = i.chunks.map((c) => ({ ...c, title: clean(c.title), body: clean(c.body) }));
    const rev = C.repoItemRev(version);
    items.set(i.ptr, { ...i, rev, chunks, hash: C.itemHash(rev, chunks, []) });
  }
  for (const l of base.link.values()) {
    const moved = items.get(l.ptr);
    if (moved && next.nodes.has(l.node)) { const f = { ...l, revHash: C.hex(moved.hash) }; links.set(factKeyOf('link', f), f); }
  }
  return { items, links };
}

/**
 * What to write so that the server goes from base to next (R7, R8, R15). base is the snapshot of the run-B mirror
 * (null for an empty server); delta.base = base.run. See the diff rules at the top of this file.
 * @param {import('./contract.mjs').State|null} base @param {import('./contract.mjs').State} next
 * @returns {import('./contract.mjs').Delta}
 */
export function diff(base, next) {
  const manifest = C.validateManifest(next.manifest);
  const b = base ?? emptyState();
  if (next.sync.github === null && (manifest.github === 'full' || b.sync.github !== null)) {
    fail('next has no GitHub state (github.db) but the scope is full or the server has one');
  }
  const was = base ? b.meta.sanitize_version : null, now = next.meta.sanitize_version;
  const gWas = b.sync.github?.row?.sanitize_version ?? null, gNow = next.sync.github?.row?.sanitize_version ?? null;
  let items = next.items, link = next.link;
  if (base && (now < was || (gWas !== null && gNow !== null && gNow < gWas))) fail('next was sanitized by an older version than the server: update the kit');
  if (base && gWas !== null && gNow > gWas && manifest.github !== 'full') fail(`GitHub sanitize_version ${gWas} -> ${gNow} needs a full publish (--full, R15)`);
  if (base && now > was) {
    if (manifest.github !== 'full') fail(`sanitize_version ${was} -> ${now} needs a full publish (--full, R15)`);
    if (next.sync.github && gNow !== now) fail(`the GitHub state still has sanitize_version ${gNow}: run brain sync --full (R15)`);
    if (now !== SANITIZE_VERSION) fail(`next was built with sanitize_version ${now}, this kit sanitizes with ${SANITIZE_VERSION}`);
    const r = resanitized(b, next, now);
    items = new Map([...next.items, ...r.items]);
    link = new Map([...next.link, ...r.links]);
  }
  const full = (scope) => manifest[scope] === 'full';
  const changed = (prev, entry) => !prev || Buffer.compare(prev.hash, entry.hash) !== 0;
  for (const n of next.nodes.values()) {                          // identity columns never change (a file named `a#b@kind`)
    const p = b.nodes.get(n.key);
    if (p && (p.nodeKind !== n.nodeKind || p.path !== n.path || p.file !== n.file)) fail(`node ${n.key} changes identity (kind, path or file)`);
  }
  const stays = (table, f) => {                                   // a base fact that next does not have
    if (table === 'edge' || table === 'unresolved') return false;
    const owner = b.items.get(f.ptr) ?? fail(`base ${table} of a missing item ${f.ptr}`);
    if (full(C.scopeOfItem(owner.kind))) return false;
    const cur = items.get(f.ptr);
    if (table === 'ref_link') return !cur;
    return !(cur && Buffer.compare(cur.hash, owner.hash) !== 0) && next.nodes.has(f.node);
  };
  const p0 = new Map([...next.nodes.values()].map((n) => [n.rev.p0_key, n.key]));
  const facts = {};
  for (const t of FACTS) {
    const nx = new Map(t === 'link' ? link : next[t]), close = [];
    for (const [k, f] of b[t]) {
      if (nx.has(k)) continue;
      if (!stays(t, f)) { close.push(k); continue; }
      if (t !== 'ref_link') continue;
      const again = { ...f, resolved: C.canonicalResolved(f.resolvedRaw, p0) }, key = factKeyOf(t, again);
      if (key !== k) { close.push(k); nx.set(key, again); }
    }
    facts[t] = { put: [...nx].filter(([k]) => !b[t].has(k)).map(([, f]) => f), close };
  }
  return {
    base: b.run, manifest,
    nodes: { put: [...next.nodes.values()].filter((n) => changed(b.nodes.get(n.key), n)), close: [...b.nodes.keys()].filter((k) => !next.nodes.has(k)) },
    items: { put: [...items.values()].filter((i) => changed(b.items.get(i.ptr), i)),
      close: [...b.items.values()].filter((i) => !items.has(i.ptr) && full(C.scopeOfItem(i.kind))).map((i) => i.ptr) },
    ...facts, meta: next.meta, sync: next.sync,
  };
}

/** Every reference of a state resolves inside it: what the server's open rows must satisfy after a publish. */
function checkClosed(s) {
  const node = (k, what) => { if (k !== null && !s.nodes.has(k)) fail(`${what} names a closed node ${k}`); };
  const chunkOf = (f, what) => {
    const it = s.items.get(f.ptr);
    if (!it || C.hex(it.hash) !== f.revHash) fail(`${what} names a revision of ${f.ptr} that is not current`);
    return it;
  };
  for (const n of s.nodes.values()) { node(n.file, `node ${n.key} file`); node(n.rev.parent, `node ${n.key} parent`); }
  for (const e of s.edge.values()) { node(e.src, 'edge src'); node(e.dst, 'edge dst'); node(e.site, 'edge site'); }
  for (const l of s.link.values()) { node(l.node, 'link'); if (!chunkOf(l, 'link').chunks[l.ord]) fail(`link to a missing chunk of ${l.ptr}`); }
  const p0 = new Map([...s.nodes.values()].map((n) => [n.rev.p0_key, n.key]));
  for (const r of s.ref_link.values()) {
    if (!chunkOf(r, 'ref_link').refs[r.ord]) fail(`ref_link to a missing ref of ${r.ptr}`);
    if (C.canonicalJson(C.canonicalResolved(r.resolvedRaw, p0)) !== C.canonicalJson(r.resolved)) fail(`a ref_link of ${r.ptr} resolves to other nodes now`);
  }
}

/**
 * The state the server shows after the delta: publish stores checksum(applyDelta(base, delta)) as run.checksum, and a
 * mirror of the new run must snapshot to the same checksum. run is null (the server numbers the new run). Throws on a
 * delta that does not fit base (a close of a missing key, a put of an unchanged one, a reference to a closed row).
 * @param {import('./contract.mjs').State|null} base @param {import('./contract.mjs').Delta} delta
 * @returns {import('./contract.mjs').State}
 */
export function applyDelta(base, delta) {
  const b = base ?? emptyState();
  if (delta.base !== b.run) fail(`a delta for run ${delta.base} applied to run ${b.run}`);
  const apply = (from, part, keyOf, same) => {
    const m = new Map(from);
    for (const k of part.close) if (!m.delete(k)) fail(`delta closes ${k}, which is not open`);
    for (const e of part.put) {
      const k = keyOf(e);
      if (m.has(k) && same(m.get(k), e)) fail(`delta puts ${k} unchanged`);
      m.set(k, e);
    }
    return m;
  };
  const sameHash = (a, e) => Buffer.compare(a.hash, e.hash) === 0;
  const out = {
    run: null, manifest: delta.manifest, meta: delta.meta,
    nodes: apply(b.nodes, delta.nodes, (n) => n.key, sameHash),
    items: apply(b.items, delta.items, (i) => i.ptr, sameHash),
    ...Object.fromEntries(FACTS.map((t) => [t, apply(b[t], delta[t], (f) => factKeyOf(t, f), () => true)])),
    sync: delta.sync,
  };
  checkClosed(out);
  return out;
}

/**
 * R16 upload check: the Phase 1 secret detector (mask after normalize: what the build and sync would still mask) over
 * every string in the delta, object keys included. Keys are never masked: a hit refuses the whole delta.
 * @param {import('./contract.mjs').Delta} delta
 * @throws {BrainError} code 'outbound-secret' naming the server table and column only (never the value)
 */
export function checkOutbound(delta) {
  const check = (table, column, v) => {
    if (typeof v === 'string') {
      if (mask(normalize(v)).redactions > 0) {
        throw new BrainError('outbound-secret', `a secret-shaped value in ${table}.${column}: nothing was written`, { table, column });
      }
    } else if (Array.isArray(v)) v.forEach((x) => check(table, column, x));
    else if (v && typeof v === 'object' && !ArrayBuffer.isView(v)) for (const [k, x] of Object.entries(v)) { check(table, column, k); check(table, column, x); }
  };
  const fields = (table, obj) => { for (const [k, v] of Object.entries(obj)) check(table, k, v); };
  // JSON text (refs.resolved, ledger keys): its strings one by one, so a masked value is not read as running into the
  // next element (`"src/token=[REDACTED:assignment]","pr-files"`)
  const jsonText = (table, column, s) => { let v; try { v = JSON.parse(s); } catch { v = s; } check(table, column, v); };
  for (const n of delta.nodes.put) { fields('node', { key: n.key, node_kind: n.nodeKind, path: n.path, file: n.file }); fields('node_rev', n.rev); }
  for (const k of delta.nodes.close) check('node', 'key', k);
  for (const i of delta.items.put) {
    fields('item', { ptr: i.ptr, kind: i.kind, origin: i.origin });
    fields('item_rev', i.rev);
    for (const c of i.chunks) fields('chunk', c);
    for (const r of i.refs) fields('ref', r);
  }
  for (const p of delta.items.close) check('item', 'ptr', p);
  for (const t of FACTS) {
    for (const f of delta[t].put) {
      if (t !== 'ref_link') { fields(t, f); continue; }
      const { resolvedRaw, ...rest } = f;
      fields(t, rest);
      if (resolvedRaw !== null) jsonText(t, 'resolved_raw', resolvedRaw);
    }
    for (const k of delta[t].close) check(t, 'fact_key', k);
  }
  check('run', 'meta', delta.meta);
  if (delta.sync.github) {
    const { refs, ...rest } = delta.sync.github;
    check('sync_state', 'state', rest);
    check('sync_state', 'state', refs.build);
    for (const [k, v] of Object.entries(refs.other)) { jsonText('sync_state', 'state', k); check('sync_state', 'state', v); }
  }
}
