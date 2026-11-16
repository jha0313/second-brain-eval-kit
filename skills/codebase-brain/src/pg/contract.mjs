// Phase 2 contract (Q0): pure functions, frozen column lists and DTO shapes that every Phase 2 lane builds on.
// No database access in this file. Design: docs/phase2-design.md §5.3, §6.1–§6.8, R5–R7.
//
// Who owns what (design §8.2). A Q0 STUB file throws NotImplementedError until its lane fills it in.
//   lead (Q0)  src/pg/contract.mjs (this file), sql/001_init.sql + sql/002_roles.sql (drafts), test/pg/golden/*
//   lane A     Q11 + Q1 + Q4: test/pg/harness.mjs, test/pg/proxy.mjs, ci/brain-test.yml, sql/* (after Q0),
//              src/pg/migrate.mjs  migrate(ownerUrl, opts)                         Q0 STUB
//              src/pg/mirror.mjs   pullMirror({ url, dir, run, shapes })           Q0 STUB
//   lane B     Q2 + Q3 + Q7: ci/brain-publish.yml, src/index-ts.mjs (BRAIN_TYPESCRIPT only),
//              src/pg/snapshot.mjs snapshot, diff, applyDelta, checkOutbound       Q0 STUB
//              src/pg/publish.mjs  beginAttempt, publish, failAttempt, resolveAttempt   Q0 STUB
//   lane C     Q5 + Q6: src/store/sqlite.mjs + src/store/pg.mjs (the Store typedef below), src/ptr.mjs (`@r<n>` via
//              parseRevPtr / formatRevPtr here), src/read.mjs, src/cli.mjs, src/render.mjs, src/answer.mjs, src/context.mjs
//
// Deliberate readings of the design (each one is listed in the Q0 report):
// - Fact keys of link / ref_link name the chunk's revision by its CONTENT HASH, not rev_no. rev_no is "the next number in
//   the identity's whole history" (§6.1), which only the server knows (a mirror holds visible rows only, so a key that
//   reappears, V7, cannot be numbered offline). With the hash, snapshot() is a pure function of the two SQLite files and
//   SQLite -> snapshot -> server -> mirror -> snapshot is byte-identical (§6.7). Pointers and chunk keys keep rev_no.
// - item_rev.source_updated_at (GitHub updated_at) is in the item hash and stored as text: otherwise the server keeps a
//   stale updated_at and the round trip is not lossless.
// - refs.resolved_build (a relink stamp that changes on every CI build) is ledger, not fact: it lives in
//   sync_state.state.refs, packed against the run's build_id, so relinking does not reopen every ref_link each run.
import { createHash } from 'node:crypto';
import { BrainError } from '../errors.mjs';
import { parsePtr, GH_TYPES, KIND_OF_TYPE } from '../ptr.mjs';

const fail = (msg) => { throw new BrainError('contract', msg); };

// ---------------------------------------------------------------------------------------------------------------------
// Canonical JSON and hashes

/**
 * Canonical JSON: no whitespace; object keys sorted by UTF-16 code units (Array#sort); arrays in order; strings and
 * finite numbers as JSON.stringify writes them. undefined, NaN, Infinity, bigint and binary values throw, so a missing
 * field can never hash like null.
 * @param {unknown} v @returns {string}
 */
export function canonicalJson(v) {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'number') return Number.isFinite(v) ? JSON.stringify(v) : fail(`not a finite number: ${v}`);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object' && !ArrayBuffer.isView(v)) {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  }
  return fail(`not canonical JSON: ${typeof v}`);
}

/** sha256 of canonicalJson(v) as UTF-8. @returns {Buffer} 32 bytes */
export const sha256 = (v) => createHash('sha256').update(canonicalJson(v), 'utf8').digest();
export const hex = (buf) => Buffer.from(buf).toString('hex');

// ---------------------------------------------------------------------------------------------------------------------
// Node identity (§5.3): file `path`, dir `dir:path`, symbol `path#keyName@kind` (kind always)

export const NODE_KINDS = Object.freeze(['file', 'dir', 'symbol']);
/** Phase 0 nodes.kind -> node.node_kind */
export const nodeKindOf = (kind) => (kind === 'file' || kind === 'dir' ? kind : 'symbol');

/**
 * Canonical key of one Phase 0 nodes row. keyName is rebuilt the way src/index-ts.mjs add() builds it: the symbol's
 * name, or `<class name>.<member name>` for a member (parent is a symbol). Phase 0 appends `@kind` only on a name clash
 * and the first declaration keeps the bare key; the canonical key always has it, so `const X` / `type X` keep their keys
 * when the order changes and f#A.run@method stays apart from f#B.run@method. The name may hold any character
 * (`declare module "@scope/pkg"`); the Phase 0 key must be exactly `path#keyName` or `path#keyName@kind`.
 * @param {{ key: string, kind: string, path: string, name: string }} row
 * @param {{ kind: string, name: string } | null} [parent] the parent nodes row (needed for members)
 * @returns {string}
 */
export function canonicalNodeKey({ key, kind, path, name }, parent = null) {
  if (typeof key !== 'string' || typeof kind !== 'string' || typeof path !== 'string' || !path) fail(`node row without key/kind/path: ${key}`);
  if (kind === 'file') return key === path ? path : fail(`file node key ${key} is not its path ${path}`);
  if (kind === 'dir') return key === `dir:${path}` ? key : fail(`dir node key ${key} is not dir:${path}`);
  if (typeof name !== 'string' || !name) fail(`symbol ${key} has no name`);
  const keyName = parent && nodeKindOf(parent.kind) === 'symbol' ? `${parent.name}.${name}` : name;
  const canonical = `${path}#${keyName}@${kind}`;
  return key === `${path}#${keyName}` || key === canonical ? canonical : fail(`symbol key ${key} is not ${path}#${keyName}[@${kind}]`);
}

/**
 * Canonical keys for a whole build. Phase 0 merges (file, keyName, kind) into one node, so keys are unique; a collision
 * means the input is not a Phase 0 build and throws.
 * @param {{ id: number, key: string, kind: string, path: string, name: string, parent: number|null }[]} rows
 * @returns {Map<number, string>} id -> key
 */
export function canonicalNodeKeys(rows) {
  const byId = new Map(), owner = new Map(), row = new Map(rows.map((r) => [r.id, r]));
  for (const r of rows) {
    const k = canonicalNodeKey(r, r.parent === null ? null : row.get(r.parent) ?? fail(`node ${r.key} has a missing parent`));
    if (owner.has(k)) fail(`canonical key collision ${k}: ${owner.get(k)} and ${r.key}`);
    owner.set(k, r.key);
    byId.set(r.id, k);
  }
  return byId;
}

// ---------------------------------------------------------------------------------------------------------------------
// Items, chunks, revision pointers

export const GITHUB_ITEM_KINDS = Object.freeze(['pr', 'issue', 'review', 'review_comment', 'issue_comment']);
export const REPO_ITEM_KINDS = Object.freeze(['doc', 'change', 'changelog', 'commit']);
/** item kind -> manifest scope (R7) */
export const scopeOfItem = (kind) => (GITHUB_ITEM_KINDS.includes(kind) ? 'github' : kind === 'commit' ? 'commits'
  : REPO_ITEM_KINDS.includes(kind) ? 'docs' : fail(`unknown item kind ${kind}`));

/**
 * Item pointer of a code.db chunks row: doc|change|changelog -> `<source>:<path>`, commit -> `commit:<sha40>`.
 * One item per file; its chunks are the file's sections. Vault notes are local-only (design §3) and throw.
 * @param {{ source: string, path: string|null, sha: string|null }} chunk @returns {string}
 */
export function repoItemPtr({ source, path, sha }) {
  if (source === 'commit') return /^[0-9a-f]{40}$/.test(sha ?? '') ? `commit:${sha}` : fail(`commit chunk without a 40-hex sha: ${sha}`);
  if (source === 'vault') fail('vault notes are local-only and are never published (design §3)');
  if (!['doc', 'change', 'changelog'].includes(source)) fail(`unknown chunk source ${source}`);
  if (!path || /[\n\r\0]/.test(path)) fail(`${source} chunk without a usable path`);
  return `${source}:${path}`;
}

/** github.db items.ptr, checked against the Phase 1 grammar and items.kind. @returns {string} */
export function githubItemPtr({ ptr, kind }) {
  const p = parsePtr(ptr);
  if (!GH_TYPES.includes(p.type) || KIND_OF_TYPE[p.type] !== kind) fail(`items.ptr ${ptr} does not match kind ${kind}`);
  return ptr;
}

/**
 * Chunks of one repo item in ord order (ord = index): by start_line, then Phase 0 id (insertion = document order).
 * @template {{ id: number, start_line: number|null }} T @param {T[]} rows @returns {T[]}
 */
export const orderChunks = (rows) => [...rows].sort((a, b) => (a.start_line ?? 0) - (b.start_line ?? 0) || a.id - b.id);

/**
 * Refs of one item in ref order (ord = index): by the UTF-8 bytes of canonicalJson([kind, target, origin]).
 * github.db refs are unique per (ptr, kind, target, origin), so the order is total.
 * @template {{ kind: string, target: string, origin: string }} T @param {T[]} rows @returns {T[]}
 */
export const orderRefs = (rows) => [...rows].sort((a, b) => byteCompare(canonicalJson(refTriple(a)), canonicalJson(refTriple(b))));
const refTriple = (r) => [r.kind, r.target, r.origin];
const byteCompare = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/** Server identity of a chunk (§6.1 R5): [item ptr, rev_no, ord]. Pointers name it `<ptr>:<a>-<b>@r<rev_no>`. */
export const chunkKey = (ptr, revNo, ord) => [ptr, revNo, ord];

// `<ptr>@r<n>` (§6.1). n has at most 6 digits, so `@r<n>` is never 8 characters long and cannot be read as a Phase 1
// build suffix (`@<build_id>`, exactly 8 chars of [0-9a-z]). The suffix is read from the right, so a path may hold '@'.
const REV_RE = /^(.+)@r([1-9]\d{0,5})$/;
export const MAX_REV = 999999;

/**
 * Split a trailing revision suffix. The base is not validated here (src/ptr.mjs parses it).
 * @param {string} s @returns {{ base: string, rev: number|null }}
 */
export function parseRevPtr(s) {
  const str = String(s ?? '');
  const m = REV_RE.exec(str);
  return m ? { base: m[1], rev: Number(m[2]) } : { base: str, rev: null };
}

/** @param {string} base @param {number|null} rev @returns {string} */
export function formatRevPtr(base, rev) {
  if (!base || /[\n\r\0]/.test(base)) fail('bad pointer base');
  if (rev === null || rev === undefined) return base;
  if (!Number.isInteger(rev) || rev < 1 || rev > MAX_REV) fail(`bad revision ${rev}`);
  return `${base}@r${rev}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Fact tuples (R5). factKey = sha256(canonicalJson(tuple)). The first element names the table. Every value is a string,
// an integer or null; a field the caller forgot is undefined and throws.

/** @param {{ src: string, dst: string, kind: string, site: string|null, line: number|null, col: number|null }} e src/dst: canonical node keys, site: the site file's path */
export const edgeTuple = (e) => ['edge', e.src, e.dst, e.kind, e.site, e.line, e.col];
/** @param {{ path: string|null, line: number|null, spec: string|null, local: number|null }} u */
export const unresolvedTuple = (u) => ['unresolved', u.path, u.line, u.spec, u.local];
/**
 * @param {{ ptr: string, revHash: string, ord: number, node: string, kind: string, evidence: string|null }} l
 *   ptr + revHash (hex of the item's content hash) + ord name the chunk; node: canonical node key
 */
export const linkTuple = (l) => ['link', l.ptr, l.revHash, l.ord, l.node, l.kind, l.evidence];
/**
 * @param {{ ptr: string, revHash: string, ord: number, status: string, reason: string|null, resolvedRaw: string|null, resolved: string[]|null }} r
 *   ord: the ref's index in orderRefs; resolvedRaw: Phase 1 refs.resolved as stored; resolved: canonicalResolved(resolvedRaw)
 */
export const refLinkTuple = (r) => ['ref_link', r.ptr, r.revHash, r.ord, r.status, r.reason, r.resolvedRaw, r.resolved];
/** @param {unknown[]} tuple @returns {Buffer} 32 bytes */
export const factKey = (tuple) => sha256(tuple);

// ---------------------------------------------------------------------------------------------------------------------
// Content hashes (R6). The column lists are FIXED here; changing one changes every hash (= a new revision for everything).
// Observation and bookkeeping fields (fetched_at, detail_for, reviews_at, resolved_build) are never hashed.

export const NODE_HASH_COLUMNS = Object.freeze(['p0_key', 'kind', 'name', 'line', 'end_line', 'parent', 'exported', 'lang', 'flags']);
export const ITEM_HASH_COLUMNS = Object.freeze(['title', 'body', 'state', 'author', 'source_updated_at', 'meta', 'sanitize_version', 'chunks', 'refs']);
export const CHUNK_HASH_COLUMNS = Object.freeze(['ord', 'start_line', 'end_line', 'title', 'body', 'sha', 'date', 'prs', 'body_line']);
export const REF_HASH_COLUMNS = Object.freeze(['kind', 'target', 'origin']);
// github.db items columns kept in item_rev.meta (every items column except identity, the item_rev columns and the ledger)
export const ITEM_META_COLUMNS = Object.freeze(['number', 'parent_number', 'review_id', 'in_reply_to', 'draft', 'author_assoc', 'url',
  'created_at', 'submitted_at', 'closed_at', 'merged_at', 'merge_sha', 'base', 'head', 'path', 'side', 'start_side', 'start_line',
  'line', 'original_start_line', 'original_line', 'commit_id', 'original_commit_id', 'redactions', 'flags']);
// github.db items columns that are collection bookkeeping: sync_state.state.items[ptr]
export const LEDGER_COLUMNS = Object.freeze(['detail_for', 'reviews_at']);

/**
 * node_rev content of a Phase 0 nodes row. parent: the parent's canonical key (null for files and dirs).
 * @returns {{ p0_key: string, kind: string, name: string, line: number|null, end_line: number|null, parent: string|null, exported: 0|1, lang: string|null, flags: string|null }}
 */
export function nodeRev(row, parent) {
  if (row.exported !== 0 && row.exported !== 1) fail(`nodes.exported must be 0 or 1 (${row.key})`);
  return { p0_key: row.key, kind: row.kind, name: row.name, line: row.line, end_line: row.end_line, parent, exported: row.exported, lang: row.lang, flags: row.flags };
}
/** @returns {Buffer} */
export const nodeHash = (rev) => sha256(['node_rev', ...NODE_HASH_COLUMNS.map((c) => rev[c])]);

/** chunk content in CHUNK_HASH_COLUMNS shape from a code.db chunks row at index ord */
export const chunkFields = (row, ord) => ({ ord, start_line: row.start_line, end_line: row.end_line, title: row.title, body: row.body,
  sha: row.sha, date: row.date, prs: row.prs, body_line: row.body_line });

/** item_rev content of a repo item (doc, change, changelog, commit): the text lives in its chunks. */
export const repoItemRev = (sanitizeVersion) => ({ title: null, body: null, state: null, author: null, source_updated_at: null,
  meta: null, sanitize_version: sanitizeVersion });

/** item_rev content of a github.db items row. sanitizeVersion: github.db sync_state.sanitize_version. */
export const githubItemRev = (item, sanitizeVersion) => ({ title: item.title, body: item.body, state: item.state, author: item.author,
  source_updated_at: item.updated_at, meta: Object.fromEntries(ITEM_META_COLUMNS.map((c) => [c, item[c]])), sanitize_version: sanitizeVersion });

/** The one search chunk (ord 0) of a GitHub item revision: a copy of its title and body, so chunk.tsv / trigram cover GitHub text too. */
export const githubSearchChunk = (rev) => ({ ord: 0, start_line: null, end_line: null, title: rev.title, body: rev.body,
  sha: null, date: null, prs: null, body_line: null });

/**
 * Item content hash. chunks in ord order (chunk.ord === index), refs in orderRefs order.
 * @param {object} rev repoItemRev / githubItemRev @param {object[]} chunks chunkFields / githubSearchChunk
 * @param {{ kind: string, target: string, origin: string }[]} refs @returns {Buffer}
 */
export function itemHash(rev, chunks, refs) {
  chunks.forEach((c, i) => { if (c.ord !== i) fail(`chunk ord ${c.ord} at index ${i}`); });
  const part = (c) => (c === 'chunks' ? chunks.map((ch) => CHUNK_HASH_COLUMNS.map((k) => ch[k]))
    : c === 'refs' ? refs.map((r) => REF_HASH_COLUMNS.map((k) => r[k])) : rev[c]);
  return sha256(['item_rev', ...ITEM_HASH_COLUMNS.map(part)]);
}

/**
 * ref_link.resolved: Phase 1 refs.resolved (JSON text: "path", "path:line", a Phase 0 node key or a pointer) with every
 * Phase 0 key replaced by its canonical key; other entries unchanged.
 * @param {string|null} raw @param {Map<string, string>} p0ToCanonical @returns {string[]|null}
 */
export function canonicalResolved(raw, p0ToCanonical) {
  if (raw === null || raw === undefined) return null;
  const list = JSON.parse(raw);
  if (!Array.isArray(list) || list.some((s) => typeof s !== 'string')) fail('refs.resolved is not a JSON array of strings');
  return list.map((s) => p0ToCanonical.get(s) ?? s);
}

/**
 * sync_state.state for source 'github' (§6.1, §6.7): the github.db sync_state row as stored (limits stays text) plus the
 * collection ledger. refs.other lists only refs whose resolved_build differs from buildId (code.db meta.build_id), keyed
 * by canonicalJson([ptr, kind, target, origin]); refs.build is buildId.
 * @param {{ syncRow: object, items: object[], refs: object[], buildId: string|null }} a
 * @returns {{ row: object, items: Record<string, { detail_for: string|null, reviews_at: string|null }>, refs: { build: string|null, other: Record<string, string|null> } }}
 */
export function githubSyncState({ syncRow, items, refs, buildId }) {
  const led = {}, other = {};
  for (const it of items) if (LEDGER_COLUMNS.some((c) => it[c] !== null)) led[it.ptr] = { detail_for: it.detail_for, reviews_at: it.reviews_at };
  for (const r of refs) if (r.resolved_build !== buildId) other[canonicalJson([r.ptr, r.kind, r.target, r.origin])] = r.resolved_build;
  return { row: { ...syncRow }, items: led, refs: { build: buildId, other } };
}

// ---------------------------------------------------------------------------------------------------------------------
// Manifest (R7): which part of the state is complete. `full`: a key missing from the snapshot closes its current rows.
// `append` / `incremental`: a missing key stays open. A key that reappears gets a new revision on the same identity.
//   map     nodes, node_rev, edge, unresolved
//   docs    items doc | change | changelog, their chunks, and links whose chunk belongs to one of them
//   commits items commit and their chunks (never closed for being outside the build window, R8). Their links stay open
//           while the commit is missing from the build; they close when the target node closes or when the commit item
//           gets a new revision (R15 re-sanitize: the new revision's chunks get new links)
//   github  GitHub items, their chunks and refs, ref_link

export const MANIFEST_SCOPES = Object.freeze({ map: ['full'], docs: ['full'], commits: ['append'], github: ['incremental', 'full'] });

/** @typedef {{ map: 'full', docs: 'full', commits: 'append', github: 'incremental'|'full' }} Manifest */

/** @param {unknown} m @returns {Readonly<Manifest>} @throws {BrainError} code 'contract' */
export function validateManifest(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) fail('manifest is not an object');
  const keys = Object.keys(m).sort(), want = Object.keys(MANIFEST_SCOPES).sort();
  if (keys.join() !== want.join()) fail(`manifest keys must be ${want.join(', ')}`);
  for (const k of want) if (!MANIFEST_SCOPES[k].includes(m[k])) fail(`manifest ${k} must be ${MANIFEST_SCOPES[k].join(' or ')}`);
  return Object.freeze({ ...m });
}

// ---------------------------------------------------------------------------------------------------------------------
// Checksum (run.checksum, mirror check R3, row-count check R9)
//
// checksum(state) = { <table>: { rows, sha256 } } over the rows VISIBLE in the state:
//   node         line = canonicalJson([canonical key, hex(node content hash)])
//   item.repo    line = canonicalJson([ptr, hex(item content hash)])  for origin 'repo' items
//   item.github  same, origin 'github'
//   edge, unresolved, link, ref_link   line = hex(fact key)
//   meta         one line = canonicalJson(state.meta)          (run.meta: what the mirror writes back into code.db meta)
//   sync.github  one line = canonicalJson(state.sync.github)   (cursor, ledger, sanitize version); no line when null
// Lines are sorted by their UTF-8 bytes; sha256 is taken over the UTF-8 bytes of the lines, each followed by '\n'
// (an empty table hashes the empty string); rows = number of lines. chunk and ref rows are covered by the item hash.
// A code-shaped mirror (laptops) checks CHECKSUM_SHAPES.code, CI checks both shapes. The R9 row-count check compares
// the table entries only (meta and sync.github are not server rows).

export const CHECKSUM_SHAPES = Object.freeze({ code: Object.freeze(['node', 'edge', 'unresolved', 'link', 'item.repo', 'meta']),
  github: Object.freeze(['item.github', 'ref_link', 'sync.github']) });

/**
 * @param {State} state @param {('code'|'github')[]} [shapes]
 * @returns {Record<string, { rows: number, sha256: string }>}
 */
export function checksum(state, shapes = ['code', 'github']) {
  const out = {};
  for (const table of shapes.flatMap((s) => CHECKSUM_SHAPES[s] ?? fail(`unknown shape ${s}`))) {
    const lines = table === 'node' ? [...state.nodes.values()].map((n) => canonicalJson([n.key, hex(n.hash)]))
      : table.startsWith('item.') ? [...state.items.values()].filter((i) => i.origin === table.slice(5)).map((i) => canonicalJson([i.ptr, hex(i.hash)]))
        : table === 'meta' ? [canonicalJson(state.meta)]
          : table === 'sync.github' ? (state.sync.github ? [canonicalJson(state.sync.github)] : [])
            : [...state[table].keys()];
    lines.sort(byteCompare);
    out[table] = { rows: lines.length, sha256: createHash('sha256').update(lines.map((l) => `${l}\n`).join(''), 'utf8').digest('hex') };
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Snapshot state, delta and read-side DTOs (implemented by lanes B and C)

/**
 * @typedef {{ key: string, nodeKind: 'file'|'dir'|'symbol', path: string, file: string|null,
 *   rev: ReturnType<typeof nodeRev>, hash: Buffer }} NodeEntry
 *   file: the canonical key of the symbol's file node (node.file_id), null for files and dirs
 * @typedef {{ ptr: string, kind: string, origin: 'repo'|'github', rev: object, chunks: object[], refs: object[], hash: Buffer }} ItemEntry
 *   refs: { kind, target, origin } in orderRefs order (GitHub items only)
 * @typedef {{
 *   run: number|null,                       // the run a mirror holds (code.db meta brain_run), null for a fresh build
 *   manifest: Readonly<Manifest>,
 *   meta: Record<string, unknown>,          // run.meta: code.db meta (values parsed) without the dropped keys and
 *                                           // without MIRROR_META_KEYS
 *   nodes: Map<string, NodeEntry>,          // canonical key ->
 *   items: Map<string, ItemEntry>,          // ptr ->
 *   edge: Map<string, object>, unresolved: Map<string, object>, link: Map<string, object>, ref_link: Map<string, object>,
 *                                           // hex(fact key) -> the tuple's named fields (edgeTuple ... refLinkTuple input)
 *   sync: { github: ReturnType<typeof githubSyncState> | null }
 * }} State
 *
 * @typedef {{
 *   base: number|null,                      // base.run: the run the delta applies to (null: empty server)
 *   manifest: Readonly<Manifest>,
 *   nodes: { put: NodeEntry[], close: string[] },   // put: new identity or new revision (publish numbers rev_no from
 *                                                   // the server history); close: canonical keys
 *   items: { put: ItemEntry[], close: string[] },   // close: ptrs (never commits, R8)
 *   edge: { put: object[], close: string[] }, unresolved: { put: object[], close: string[] },
 *   link: { put: object[], close: string[] }, ref_link: { put: object[], close: string[] },   // close: hex fact keys
 *   meta: Record<string, unknown>, sync: State['sync']
 * }} Delta
 *
 * @typedef {{ run: number|null, runCommit: string|null, publishedAt: string|null, sync: Record<string, any>|null,
 *   codeSanitizeVersion: number|null, githubSanitizeVersion: number|null }} View
 *   §6.4: what one command looked at. The Postgres store reads it in the SAME SQL statement as the rows (CTE); the
 *   SQLite store fills it from ctx.meta / ctx.sync with run = null. footer (answer.freshness) and guard use only this.
 *
 * @typedef {{ asOf?: number|null }} AtRun   run id from resolveAsOf; null / missing = latest run
 *
 * Store (lane C, src/store/sqlite.mjs and src/store/pg.mjs). Every method is async, is ONE SQL statement in the
 * Postgres store, and returns `view` from that statement. A command that calls several methods passes the first
 * result's view.run as `asOf` to the others, so the whole command reads one run (§6.4, V16). Rows are hydrated: they
 * keep the Phase 1 SQLite shapes (github.db items / refs rows, code.db chunks rows) plus `ptr`, `rev` and the fields
 * below, so read.mjs keeps its ranking (RRF), grouping and rendering without another query.
 * @typedef {Record<string, any> & { ptr: string, rev: number, origin: 'github'|'repo', parentPtr: string|null }} StoreRow
 *   GitHub: the items row columns (+ meta columns); repo: the chunks row columns; parentPtr: the PR / issue a
 *   review or comment rolls up to
 * @typedef {{
 *   candidates(q: string, opts: import('../read.mjs').SearchOpts & AtRun): Promise<{
 *     lists: { name: string, rows: (StoreRow & { rank: number })[], truncated: boolean }[],   // max 2,000 per list
 *     facts: { pathRefsPending: number, filesTruncated: number, githubPresent: boolean }, view: View }>,
 *   get(ptrs: string[], opts?: AtRun): Promise<{ items: (StoreRow & { revs: { rev: number, run: number, publishedAt: string, state: string|null }[],
 *     thread: StoreRow[], refs: Record<string, any>[] })[], view: View }>,
 *   thread(ptr: string, opts?: AtRun): Promise<{ rows: StoreRow[], view: View }>,
 *   refs(ptr: string, opts?: AtRun): Promise<{ rows: Record<string, any>[], view: View }>,   // github.db refs row shape
 *   source(ptr: string, opts?: AtRun): Promise<{ row: StoreRow, view: View }>,
 *   resolveAsOf(spec: string|null): Promise<{ run: number, view: View }>,
 *   close(): Promise<void>
 * }} Store
 *   source / get accept `<ptr>@r<n>` (parseRevPtr). resolveAsOf: 'run:42' | 'commit:<sha>' | 'YYYY-MM-DD' with optional
 *   '+09:00' offset (end of that day); null = latest. Not found -> NotFoundError.
 */
export const STORE_METHODS = Object.freeze(['candidates', 'get', 'thread', 'refs', 'source', 'resolveAsOf', 'close']);

/** pg_advisory_xact_lock key of the publish lock (R9, R11, R12). sql/001_init.sql takes the same lock for a run row. */
export const PUBLISH_LOCK_KEY = 2026111601;

/**
 * code.db meta keys a mirror adds (§6.7: run id, run commit, checksum). They come from the run row, not from run.meta:
 * snapshot() reads brain_run into State.run and skips all of them, so a mirror snapshots to the same state as the
 * build it came from.
 */
export const MIRROR_META_KEYS = Object.freeze(['brain_run', 'brain_run_commit', 'brain_published_at', 'brain_checksum']);

// ---------------------------------------------------------------------------------------------------------------------
// Column map (§6.7, lossless rule). Every column of every Phase 0 code.db table and Phase 1 github.db table, plus the
// rowid pseudo-columns the mirror uses as ids and the code.db meta keys, -> where it lives on the server.
//   { to: 'table.column' | 'table.column.json.path' | [...] }   stored there (a json path names a key inside jsonb)
//   { derived: reason }                                          rebuilt from other columns, nothing is lost
//   { dropped: reason }                                          only local path meta (R16)
// Ids: the mirror writes server ids into the id / rowid columns; snapshot never reads them (keys only).

const to = (...t) => Object.freeze({ to: t.length === 1 ? t[0] : t });
const FTS = Object.freeze({ derived: 'FTS5 index, rebuilt locally from its content table after a pull (§6.7)' });
const SYNC_ROW = ['id', 'repo_id', 'repo', 'cursor', 'last_ok_at', 'last_full_at', 'run_status', 'run_pid', 'run_started_at',
  'last_error', 'limits', 'schema_version'];
const META_KEYS = ['commit_date', 'built_at', 'tracked_files', 'vault', 'options', 'stats', 'build_id', 'coverage', 'timings'];

export const COLUMN_MAP = Object.freeze({
  'code.meta.key': to('run.meta'),
  'code.meta.value': to('run.meta'),
  'code.meta[repo]': Object.freeze({ dropped: 'local checkout path (R16); the mirror writes its own checkout' }),
  'code.meta[worktree]': Object.freeze({ dropped: 'dirty-file hashes of the local build checkout (R16); CI builds a clean checkout' }),
  'code.meta[commit]': to('run.commit_sha', 'run.meta.commit'),
  'code.meta[sanitize_version]': to('run.sanitize_version', 'run.meta.sanitize_version', 'item_rev.sanitize_version'),
  ...Object.fromEntries(META_KEYS.map((k) => [`code.meta[${k}]`, to(`run.meta.${k}`)])),

  'code.nodes.id': to('node.node_id'),
  'code.nodes.key': to('node_rev.p0_key', 'node.key'),           // node.key = canonicalNodeKey(row)
  'code.nodes.kind': to('node_rev.kind', 'node.node_kind'),      // node_kind = nodeKindOf(kind)
  'code.nodes.name': to('node_rev.name'),
  'code.nodes.path': to('node.path', 'node.file_id'),            // file_id: the file node at that path (symbols)
  'code.nodes.line': to('node_rev.line'),
  'code.nodes.end_line': to('node_rev.end_line'),
  'code.nodes.parent': to('node_rev.parent_id'),
  'code.nodes.exported': to('node_rev.exported'),
  'code.nodes.lang': to('node_rev.lang'),
  'code.nodes.flags': to('node_rev.flags'),

  'code.edges.rowid': to('edge.edge_id'),
  'code.edges.src': to('edge.src_id'),
  'code.edges.dst': to('edge.dst_id'),
  'code.edges.kind': to('edge.kind'),
  'code.edges.path': to('edge.site_file_id'),                    // the site file's node; its path is node.path
  'code.edges.line': to('edge.line'),
  'code.edges.col': to('edge.col'),

  'code.unresolved.rowid': to('unresolved.unresolved_id'),
  'code.unresolved.path': to('unresolved.path'),
  'code.unresolved.line': to('unresolved.line'),
  'code.unresolved.spec': to('unresolved.spec'),
  'code.unresolved.local': to('unresolved.local'),

  'code.chunks.id': to('chunk.chunk_id'),
  'code.chunks.source': to('item.kind', 'item.ptr'),             // ptr = repoItemPtr(row); item.origin = 'repo'
  'code.chunks.path': to('item.ptr'),
  'code.chunks.start_line': to('chunk.start_line'),
  'code.chunks.end_line': to('chunk.end_line'),
  'code.chunks.title': to('chunk.title'),
  'code.chunks.body': to('chunk.body'),
  'code.chunks.sha': to('chunk.sha', 'item.ptr'),                // commit:<sha>
  'code.chunks.date': to('chunk.date'),
  'code.chunks.prs': to('chunk.prs'),
  'code.chunks.body_line': to('chunk.body_line'),
  'code.chunks_fts.title': FTS, 'code.chunks_fts.body': FTS,
  'code.chunks_tri.title': FTS, 'code.chunks_tri.body': FTS,

  'code.links.rowid': to('link.link_id'),
  'code.links.chunk': to('link.chunk_id'),
  'code.links.node': to('link.node_id'),
  'code.links.kind': to('link.kind'),
  'code.links.evidence': to('link.evidence'),

  ...Object.fromEntries(SYNC_ROW.map((c) => [`github.sync_state.${c}`, to(`sync_state.state.row.${c}`)])),
  'github.sync_state.sanitize_version': to('sync_state.state.row.sanitize_version', 'item_rev.sanitize_version'),

  'github.items.id': to('item.item_id'),
  'github.items.ptr': to('item.ptr'),
  'github.items.kind': to('item.kind'),                          // item.origin = 'github'
  'github.items.state': to('item_rev.state'),
  'github.items.author': to('item_rev.author'),
  'github.items.title': to('item_rev.title', 'chunk.title'),     // chunk: githubSearchChunk copy
  'github.items.body': to('item_rev.body', 'chunk.body'),
  'github.items.updated_at': to('item_rev.source_updated_at'),
  ...Object.fromEntries(ITEM_META_COLUMNS.map((c) => [`github.items.${c}`, to(`item_rev.meta.${c}`)])),
  ...Object.fromEntries(LEDGER_COLUMNS.map((c) => [`github.items.${c}`, to(`sync_state.state.items.${c}`)])),
  'github.items_fts.title': FTS, 'github.items_fts.body': FTS,
  'github.items_tri.title': FTS, 'github.items_tri.body': FTS,

  'github.refs.rowid': to('ref.ref_id'),
  'github.refs.ptr': to('ref.rev_id'),                           // the item's revision that carries the ref
  'github.refs.kind': to('ref.kind'),
  'github.refs.target': to('ref.target'),
  'github.refs.origin': to('ref.origin'),
  'github.refs.status': to('ref_link.status'),
  'github.refs.reason': to('ref_link.reason'),
  'github.refs.resolved': to('ref_link.resolved_raw', 'ref_link.resolved'),
  'github.refs.resolved_build': to('sync_state.state.refs'),     // githubSyncState refs.build / refs.other
});

// =====================================================================================================================
// Phase 3 contract (S0). docs/phase3-design.md §6.2 (stages), §6.4 A5–A6, §6.5 (attempt display, staleness), §6.6
// (refresh), §7 (normalized dump). Pure: no network, no DB, no clock (callers pass `now`).
//   lane A  S6 + S2 + S1: test/pg/faults.mjs, test/pg/slo.mjs, scripts/sandbox-setup.mjs, src/pg/ci-publish.mjs,
//           ci/brain-publish.yml, ci/brain-bootstrap.yml
//   lane B  S3 + S4 + S5: src/pg/status.mjs (staleness, footerLine), src/refresh.mjs, src/gh-actions.mjs, src/cli.mjs,
//           SKILL.md, README.md

// ---- staleness: four cells (§6.5) ----------------------------------------------------------------------------------
export const CODE_STATES = Object.freeze(['same', 'behind', 'differs', 'unknown']);
export const MEMORY_STATES = Object.freeze(['fresh', 'old', 'never', 'unknown']);
export const ACTIVITY_STATES = Object.freeze(['idle', 'queued', 'running']);
/** `last` values; 'failed' carries the stage: { state: 'failed', stage: 'sync' }. */
export const LAST_STATES = Object.freeze(['ok', 'skipped', 'failed', 'failed before start', 'abandoned', 'outcome unknown']);
/** memory is fresh when DB now() - GitHub T < this. Server clock only (P14). */
export const MEMORY_FRESH_MS = 24 * 3600 * 1000;

/**
 * @typedef {{
 *   code: { state: 'same'|'behind'|'differs'|'unknown', behind?: number, runCommit?: string|null, mainHead?: string|null },
 *   memory: { state: 'fresh'|'old'|'never'|'unknown', ageMs?: number|null },
 *   activity: { state: 'idle'|'queued'|'running', runId?: number|null, stage?: string|null, sinceMs?: number|null },
 *   last: { state: string, stage?: string|null, agoMs?: number|null } | null,
 *   run: number|null
 * }} Staleness
 */

/** Refresh is needed when code is behind / differs or memory is old / never. `unknown` alone never dispatches (§6.5). */
export const needsRefresh = (s) => ['behind', 'differs'].includes(s.code.state) || ['old', 'never'].includes(s.memory.state);

/**
 * Footer phrases (§6.5). The four trigger phrases are what SKILL.md tells the agent to look for; keep them verbatim.
 * Example: `brain data: run 42 @9f3c2e1a · 3 commits behind main · github as of 27h ago (stale) · last attempt FAILED 40m ago (sync)`
 */
export const REFRESH_TRIGGERS = Object.freeze(['behind main', 'differs from main', '(stale)', 'never synced']);
export const FRESHNESS_UNKNOWN = '(freshness unknown)';
export const FOOTER_PHRASES = Object.freeze({
  prefix: 'brain data:',
  noRun: 'no published run',
  code: Object.freeze({ same: '= main', behind: (n) => `${n} commit${n === 1 ? '' : 's'} behind main`, differs: 'differs from main', unknown: FRESHNESS_UNKNOWN }),
  memory: Object.freeze({ fresh: (age) => `github as of ${age} ago`, old: (age) => `github as of ${age} ago (stale)`, never: 'github never synced', unknown: FRESHNESS_UNKNOWN }),
  activity: Object.freeze({ idle: null, queued: 'refresh queued', running: (stage) => `refresh running${stage ? ` (${stage})` : ''}` }),
  last: Object.freeze({ failed: (ago, stage) => `last attempt FAILED ${ago} ago${stage ? ` (${stage})` : ''}`,
    'failed before start': (ago) => `last attempt FAILED before start ${ago} ago`, abandoned: (ago) => `last attempt abandoned ${ago} ago`,
    'outcome unknown': (ago) => `last attempt outcome unknown (${ago} ago)` }),
});
/** Age text used in footers: 59s -> '59s', 12m, 27h, 3d. */
export function ageText(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 72 * 3600) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// ---- attempt display (§6.5 table) ----------------------------------------------------------------------------------
export const ABANDON_UNKNOWN_MS = 30 * 60 * 1000;
/**
 * Shown state of one Actions attempt, matched to the DB attempt by (run id, run attempt).
 * @param {{ db: null|'running'|'ok'|'failed'|'skipped'|'abandoned', actions: null|'queued'|'in_progress'|'completed_failure'|'cancelled'|'completed_success'|'unknown',
 *   startedAtMs?: number|null, nowMs?: number, commitUnconfirmed?: boolean }} a
 * @returns {'queued'|'failed before start'|'running'|'abandoned'|'abandoned?'|'running?'|'ok'|'failed'|'skipped'|'outcome unknown'}
 */
export function attemptDisplay({ db, actions, startedAtMs = null, nowMs = 0, commitUnconfirmed = false }) {
  if (commitUnconfirmed) return 'outcome unknown';
  if (db === null) {
    if (actions === 'queued' || actions === 'in_progress') return 'queued';
    if (actions === 'completed_failure' || actions === 'cancelled') return 'failed before start';
    return 'queued';
  }
  if (db !== 'running') return db;
  if (actions === 'in_progress' || actions === 'queued') return 'running';
  if (actions === 'completed_failure' || actions === 'cancelled' || actions === 'completed_success') return 'abandoned';
  return startedAtMs !== null && nowMs - startedAtMs > ABANDON_UNKNOWN_MS ? 'abandoned?' : 'running?';
}

// ---- brain refresh (§6.6) ------------------------------------------------------------------------------------------
export const REFRESH_EXIT = Object.freeze({ fresh: 0, failed: 1, unavailable: 2, running: 75 });
export const REFRESH_LIMITS = Object.freeze({
  callMs: 80_000,            // F8: one call
  deadlineMs: 15 * 60_000,   // F8: from the first call; never extended
  cooldownMs: 15 * 60_000,   // F3
  httpMaxMs: 20_000,         // F8: AbortSignal.timeout(min(left, 20s))
  extraDispatchMax: 1,       // F7
});
/** Output lines (stdout, one line). runId may be null before the run id is known. */
export const REFRESH_MESSAGES = Object.freeze({
  fresh: 'fresh',
  refreshed: (runId) => `refreshed (run ${runId})`,
  // running shows the ACTIONS run id (no brain run exists yet); refreshed shows the BRAIN run id, as in the footer
  running: (actionsRunId, elapsed, stage) => `still running (actions run ${actionsRunId ?? '?'}, ${elapsed}${stage ? `, stage: ${stage}` : ''})`,
  cooldown: (ago, stage) => `refresh FAILED (cooldown: last attempt failed ${ago} ago${stage ? ` in ${stage}` : ''}; data is stale)`,
  failed: (reason) => `refresh FAILED (${reason})`,
  mainMoved: 'refresh FAILED (main moved)',
  deadline: 'refresh FAILED (deadline: 15m since the first call)',
  noPermission: 'refresh unavailable: no dispatch permission',
  noGithub: 'refresh unavailable: GitHub not reachable',
  noServer: 'refresh unavailable: brain server not reachable',   // a NEW refresh cannot reach the reader DB (P25)
});
/**
 * State file ~/.cache/brain/refresh/<binding id>.json (F11), mode 0600, locked with withWriteLock(<file>).
 * @typedef {{ v: 1, startedAt: string, deadline: string, baseT: string|null, baseHead: string, runId: number|null,
 *   dispatchedAt: string|null, extraDispatches: number }} RefreshState
 */
export const REFRESH_STATE_VERSION = 1;
export const refreshStatePath = (home, bindingId) => `${home}/.cache/brain/refresh/${bindingId}.json`;

// ---- ci-publish stages, limits, signals (§6.2, A2, A5) -------------------------------------------------------------
export const CI_STAGES = Object.freeze(['prepare', 'record', 'mirror', 'build', 'sync', 'outbound', 'publish', 'verify']);
/** Per-stage limits in ms (null = none). Child stages get SIGTERM at the limit and SIGKILL 10 s later. */
export const CI_LIMITS = Object.freeze({
  normal: Object.freeze({ record: 60_000, mirror: 60_000, build: 180_000, sync: 120_000, publish: 60_000, verify: 30_000,
    requestMs: 30_000, rateWaitMs: 60_000, txTimeout: '60s', statementTimeout: '30s', lockTimeout: '15s' }),
  bootstrap: Object.freeze({ record: 60_000, mirror: 60_000, build: 180_000, sync: null, publish: 600_000, verify: 30_000,
    requestMs: 30_000, rateWaitMs: null, txTimeout: '10min', statementTimeout: '5min', lockTimeout: '15s' }),
});
export const CI_KILL_GRACE_MS = 10_000;
export const CI_CONNECT_BACKOFF_MS = Object.freeze([1000, 2000, 4000, 8000]);   // a sleeping compute (S2, S5)
export const CI_SIGNAL_CLEANUP_MS = 5000;   // SIGINT/SIGTERM: kill children, close DB, try failAttempt within 5 s
/** ci-publish exit codes. verify-failed: data committed, attempt ok, job marked failed (§6.2 S6). */
export const CI_EXIT = Object.freeze({ ok: 0, failed: 1, usage: 2, verifyFailed: 3, outcomeUnknown: 4 });
/** attempt.error is `<stage>:<kind>`, never free text (R16 / §6.7). */
export const CI_ERROR_KINDS = Object.freeze(['timeout', 'exit', 'signal', 'connect', 'checksum', 'http', 'rate-limit',
  'outbound', 'stale-base', 'not-descendant', 'binding', 'sql', 'fault', 'internal']);
export const ciError = (stage, kind) => {
  if (!CI_STAGES.includes(stage) || !CI_ERROR_KINDS.includes(kind)) fail(`bad ci error ${stage}:${kind}`);
  return `${stage}:${kind}`;
};
/** A5 skip: all four must hold. Times are ISO strings from GitHub's clock. */
export const shouldSkip = ({ firstAttempt, mode, full, latestCommit, sourceCommit, latestT, runCreatedAt, latestTool, tool,
  latestSanitize, sanitize }) =>
  firstAttempt === true && mode === 'normal' && !full && latestCommit === sourceCommit && latestT !== null &&
  Date.parse(latestT) >= Date.parse(runCreatedAt) && latestTool === tool && latestSanitize === sanitize;

// ---- fault injection (A6, §7.2) ------------------------------------------------------------------------------------
/** BRAIN_FAULT=<stage>:<point>; ignored unless BRAIN_FAULT_ALLOW=1. */
export const FAULT_POINTS = Object.freeze({
  'mirror:connect': 'F2 connection refused while pulling the mirror',
  'mirror:checksum': 'F2 mirror checksum mismatch (pull again in full and continue)',
  'build:fail': 'F3 build child exits non-zero',
  'build:sleep': 'F3/T3 build child sleeps past the 3 min limit',
  'sync:http500': 'F4 GitHub 500 after retries',
  'sync:rate-limit': 'F5 rate limit with reset 5 min ahead',
  'outbound:secret': 'F6 outbound check finds a secret',
  'publish:after-nodes': 'F7 throw after node rows',
  'publish:after-items': 'F7 throw after item rows',
  'publish:after-sync-state': 'F7 throw after sync_state',
  'publish:after-attempt-ok': 'F7 throw after attempt ok, before COMMIT',
  'publish:kill': 'F8 SIGKILL self inside the transaction',
  'publish:drop-before-commit': 'F9 destroy the socket right before COMMIT',
  'publish:sleep': 'F12 pg_sleep past transaction_timeout',
  'verify:kill': 'F14 SIGKILL self after COMMIT, before verify',
});
/** @returns {null | { stage: string, point: string }} */
export function parseFault(env = process.env) {
  if (env.BRAIN_FAULT_ALLOW !== '1' || !env.BRAIN_FAULT) return null;
  if (!Object.hasOwn(FAULT_POINTS, env.BRAIN_FAULT)) fail(`unknown BRAIN_FAULT ${env.BRAIN_FAULT}`);
  const [stage, point] = env.BRAIN_FAULT.split(':');
  return { stage, point };
}

// ---- normalized domain dump (§7) -----------------------------------------------------------------------------------
/**
 * "Same as without the failure": dump every domain table, then normalize: surrogate ids -> natural keys, run ids -> run
 * ordinal (1-based by run_id; rolled-back transactions burn identity values), drop the listed volatile columns, sort rows
 * by canonicalJson. attempt is excluded. The harness (Phase 2 Q11 dump, Phase 3 S6 normalize) implements this.
 */
export const DUMP_EXCLUDE_TABLES = Object.freeze(['attempt']);
export const DUMP_NATURAL_KEYS = Object.freeze({
  node: ['key'], item: ['ptr'],
  node_rev: ['node_id->node.key', 'rev_no'], item_rev: ['item_id->item.ptr', 'rev_no'],
  chunk: ['rev_id->item_rev', 'ord'], ref: ['rev_id->item_rev', 'ord'],
  edge: ['fact_key', 'valid_from'], unresolved: ['fact_key', 'valid_from'], link: ['fact_key', 'valid_from'],
  ref_link: ['fact_key', 'valid_from'], run: ['run_id->ordinal'], sync_state: ['run_id->ordinal', 'source'], binding: ['id'],
});
export const DUMP_VOLATILE_COLUMNS = Object.freeze({ run: ['attempt_id', 'published_at'], binding: ['created_at'] });
