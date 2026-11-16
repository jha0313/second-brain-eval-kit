// SQLite store (local mode): code.db + github.db through a read context (context.mjs). The SQL is Phase 1 read.mjs's,
// moved here unchanged; read.mjs shapes what it returns. `core` is the same functions without the Promise, for
// read.mjs's synchronous Phase 1 API (search / get / source on a ctx). Lane C owns this file.
// This store holds one state, the build's: no revisions and no runs. A revision pointer (`@r<n>`) or an as-of run is a
// usage error here (code 'needs-server'). view.run is the mirror's run when code.db is one (meta brain_run), else null.
import { BrainError, NotFoundError, StalePtrError } from '../errors.mjs';
import { parseRevPtr, formatPtr, GH_TYPES, MEMORY_TYPES } from '../ptr.mjs';
import { resolveTarget } from '../query.mjs';
import { MAX_NAME_OWNERS } from '../index-knowledge.mjs';
import { CAP, LINK_STATUS, filterOf, termsOf, listOf } from './common.mjs';

const marks = (a) => a.map(() => '?').join(', ');
const quote = (s) => `"${s.replace(/"/g, '""')}"`;
// path filter: the path itself or anything under it (substr, not LIKE: paths contain _ and %)
const UNDER = (col) => `(${col} = ? OR substr(${col}, 1, ?) = ?)`;
const underArgs = (p) => [p, [...p].length + 1, `${p}/`];
const needsServer = (what) => new BrainError('needs-server', `${what} reads server revisions; this is a local index (one state, no history)`);

export const chunkPtr = (c, build) => (c.source === 'commit' ? `commit:${c.sha.slice(0, 8)}`
  : formatPtr({ type: c.source, path: c.source === 'vault' ? c.path.replace(/^vault:/, '') : c.path, a: c.start_line, b: c.end_line, build }));

/** @param {import('../context.mjs').Ctx} ctx @returns {import('../pg/contract.mjs').View} */
function view(ctx) {
  const m = ctx.meta;
  return { run: m.brain_run ?? null, runCommit: m.brain_run_commit ?? null, publishedAt: m.brain_published_at ?? null, sync: ctx.sync,
    codeSanitizeVersion: m.sanitize_version ?? null, githubSanitizeVersion: ctx.sync?.sanitize_version ?? null };
}

function checkPtr(ctx, p) {
  if (p.rev !== null) throw needsServer('a revision pointer (@r<n>)');
  if (MEMORY_TYPES.includes(p.type) && p.build !== ctx.meta.build_id) throw new StalePtrError(formatPtr(p), p.build, ctx.meta.build_id ?? null);
}

// refs that put an item on the path: a file / dir target under it, or a current resolution under it.
// pending = refs that could still land on the path once linked (pending, budget, or resolved against another build)
function pathRefs(gh, p, build) {
  const under = (s) => s === p || s.startsWith(`${p}/`);
  const ptrs = new Set();
  let pending = 0;
  for (const r of gh.prepare(`SELECT ptr, kind, target, status, reason, resolved, resolved_build FROM refs WHERE kind IN ('file', 'dir', 'symbol', 'route', 'name')`).iterate()) {
    if ((r.kind === 'file' || r.kind === 'dir') && under(String(r.target).replace(/^\.\//, '').replace(/\/+$/, ''))) { ptrs.add(r.ptr); continue; }
    const status = LINK_STATUS.includes(r.status) ? r.status : 'pending';
    if (status === 'pending' || r.resolved_build !== build || (status === 'ambiguous' && r.reason === 'budget')) { pending++; continue; }
    if (listOf(r.resolved).some((v) => under(v.replace(/#.*$/, '').replace(/:\d+$/, '')))) ptrs.add(r.ptr);
  }
  return { ptrs, pending };
}

// a review / comment matches as itself but ranks as its parent PR or issue (r); ptr is unique, so this join is indexed
const ROW = `JOIN items r ON r.ptr IN (i.ptr, 'pr:' || i.parent_number, 'issue:' || i.parent_number) AND r.kind IN ('pr', 'issue')`;
const ROW_DATE = 'coalesce(r.merged_at, r.closed_at, r.updated_at, r.created_at)';

function itemLists(gh, t, f, build, add, seeds = []) {
  const w = [`i.kind IN (${marks(f.ghKinds)})`], p = [...f.ghKinds];
  if (f.states) { w.push(`r.state IN (${marks(f.states)})`); p.push(...f.states); }
  if (f.author) { w.push('lower(i.author) = ?'); p.push(f.author); }
  if (f.since) { w.push('coalesce(i.updated_at, i.submitted_at, i.created_at) >= ?'); p.push(f.since); }
  let pending = 0;
  if (f.path) {
    const refs = pathRefs(gh, f.path, build);
    const json = JSON.stringify([...refs.ptrs]);
    pending = refs.pending;
    w.push(`(i.ptr IN (SELECT value FROM json_each(?)) OR r.ptr IN (SELECT value FROM json_each(?)) OR ${UNDER('i.path')})`);
    p.push(json, json, ...underArgs(f.path));
  }
  const run = (name, from, match, args, order = '') => add(name, gh.prepare(
    `SELECT 'g' || i.id AS key, 'g' || r.id AS grp, ${ROW_DATE} AS d, i.ptr AS ptr, i.flags AS flags FROM ${from} ${ROW}
     WHERE ${match} AND ${w.join(' AND ')} ${order} LIMIT ${CAP + 1}`).all(...args, ...p));
  if (t.ascii.length) run('items_fts', 'items_fts JOIN items i ON i.id = items_fts.rowid', 'items_fts MATCH ?', [t.ascii.map(quote).join(' OR ')], 'ORDER BY bm25(items_fts, 3.0, 1.0)');
  for (const s of t.tri) {
    if ([...s].length >= 3) run('items_tri', 'items_tri JOIN items i ON i.id = items_tri.rowid', 'items_tri MATCH ?', [quote(s)], 'ORDER BY bm25(items_tri, 3.0, 1.0)');
    else run('items_tri', 'items i', '(i.title LIKE ? OR i.body LIKE ?)', [`%${s}%`, `%${s}%`]);
  }
  const nums = t.prs.flatMap((n) => [`pr:${n.slice(1)}`, `issue:${n.slice(1)}`]);
  if (nums.length) run('items_keys', 'items i', `i.ptr IN (${marks(nums)})`, nums);
  for (const sha of t.shas) run('items_keys', 'items i', 'i.merge_sha LIKE ?', [`${sha}%`]);
  if (seeds.length) {   // refs resolved in this build to a seed: a symbol key, a file path, or path:line inside a seed file
    const keys = seeds.map((n) => n.key), files = seeds.filter((n) => n.kind === 'file').map((n) => n.key);
    const ptrs = gh.prepare(`SELECT DISTINCT r.ptr FROM refs r, json_each(CASE WHEN json_valid(r.resolved) THEN r.resolved ELSE '[]' END) j
      WHERE r.resolved_build = ? AND r.status IN ('linked', 'ambiguous') AND (j.value IN (${marks(keys)})
      ${files.length ? `OR substr(j.value, 1, instr(j.value || ':', ':') - 1) IN (${marks(files)})` : ''})`).all(build, ...keys, ...files).map((x) => x.ptr);
    if (ptrs.length) run('items_links', 'items i', 'i.ptr IN (SELECT value FROM json_each(?))', [JSON.stringify(ptrs)], `ORDER BY ${ROW_DATE} DESC, i.id`);
  }
  return pending;
}

function chunkLists(code, t, f, add, seeds = []) {
  const w = [`c.source IN (${marks(f.sources)})`], p = [...f.sources];
  if (f.since) { w.push('c.date >= ?'); p.push(f.since); }
  if (f.path) {   // the chunk's own file, or code it links to (mentions, touches, area doc)
    w.push(`(${UNDER('c.path')} OR EXISTS (SELECT 1 FROM links l JOIN nodes n ON n.id = l.node WHERE l.chunk = c.id AND ${UNDER('n.path')}))`);
    p.push(...underArgs(f.path), ...underArgs(f.path));
  }
  const run = (name, from, match, args, order = '') => add(name, code.prepare(
    `SELECT 'c' || c.id AS key, 'c' || c.id AS grp, c.date AS d FROM ${from} WHERE ${match} AND ${w.join(' AND ')} ${order} LIMIT ${CAP + 1}`)
    .all(...args, ...p));
  if (t.ascii.length) run('chunks_fts', 'chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid', 'chunks_fts MATCH ?', [t.ascii.map(quote).join(' OR ')], 'ORDER BY bm25(chunks_fts, 3.0, 1.0)');
  for (const s of t.tri) {
    if ([...s].length >= 3) run('chunks_tri', 'chunks_tri JOIN chunks c ON c.id = chunks_tri.rowid', 'chunks_tri MATCH ?', [quote(s)], 'ORDER BY bm25(chunks_tri, 3.0, 1.0)');
    else run('chunks_tri', 'chunks c', '(c.title LIKE ? OR c.body LIKE ?)', [`%${s}%`, `%${s}%`]);
  }
  for (const n of t.prs) run('chunks_keys', 'chunks c', `(' ' || c.prs || ' ') LIKE ?`, [`% ${n} %`]);
  for (const sha of t.shas) run('chunks_keys', 'chunks c', 'c.sha LIKE ?', [`${sha}%`]);
  if (seeds.length) run('chunks_links', 'chunks c', `c.id IN (SELECT chunk FROM links WHERE node IN (${marks(seeds)}))`, seeds.map((n) => n.id), 'ORDER BY c.date DESC, c.id');
}

// name -> code link signal (design §6.7, as in why): identifiers and paths in the query that name code nodes (one node,
// or a name with at most MAX_NAME_OWNERS exported owners), plus the file of each symbol. A doc linked to that code, or a
// PR whose refs resolve to it in this build, is a candidate even when its text never spells the name.
function seedNodes(code, names) {
  const seeds = new Map();
  for (const n of names) {
    const r = resolveTarget(code, n);
    const hit = r.node ? [r.node] : r.candidates?.length && r.candidates.length <= MAX_NAME_OWNERS ? r.candidates : [];
    for (const node of hit) {
      seeds.set(node.id, node);
      if (node.kind !== 'file' && node.path) { const f = code.prepare('SELECT * FROM nodes WHERE key = ?').get(node.path); if (f) seeds.set(f.id, f); }
    }
  }
  return [...seeds.values()];
}

function candidates(ctx, q, opts = {}) {
  const t = termsOf(q), f = filterOf(opts);
  const lists = [];
  const add = (name, rows) => lists.push({ name, rows: rows.slice(0, CAP), truncated: rows.length > CAP });
  const seeds = t.names.length ? seedNodes(ctx.code, t.names) : [];
  let filesTruncated = 0, pathRefsPending = 0;
  if (ctx.gh) {
    filesTruncated = ctx.gh.prepare(`SELECT count(*) AS n FROM items WHERE kind = 'pr' AND (' ' || flags || ' ') LIKE '% files-truncated %'`).get().n;
    if (f.ghKinds.length) pathRefsPending = itemLists(ctx.gh, t, f, ctx.meta.build_id, add, seeds);
  }
  if (f.sources.length) chunkLists(ctx.code, t, f, add, seeds);
  return { lists, facts: { pathRefsPending, filesTruncated, githubPresent: !!ctx.gh }, view: view(ctx) };
}

const chunkRow = (ctx, c) => ({ ...c, key: `c${c.id}`, ptr: chunkPtr(c, ctx.meta.build_id), rev: null, origin: c.source === 'vault' ? 'vault' : 'repo', parentPtr: null });
// a child's parent: the PR with that number if github.db has it, else the issue (a comment on an issue)
const parentOf = (ctx, r) => (r.kind === 'pr' || r.kind === 'issue' || r.parent_number == null ? null
  : ctx.gh.prepare("SELECT ptr FROM items WHERE ptr IN (?, ?) ORDER BY kind = 'pr' DESC LIMIT 1").get(`pr:${r.parent_number}`, `issue:${r.parent_number}`)?.ptr ?? null);
const itemRow = (ctx, r) => ({ ...r, key: `g${r.id}`, rev: null, origin: 'github', parentPtr: parentOf(ctx, r) });

/** hydrate candidate keys (Candidate.key / grp); unknown keys are left out */
function rows(ctx, keys) {
  const chunk = ctx.code.prepare('SELECT * FROM chunks WHERE id = ?'), item = ctx.gh?.prepare('SELECT * FROM items WHERE id = ?');
  const out = [];
  for (const k of keys) {
    const id = Number(String(k).slice(1));
    const r = k[0] === 'c' ? chunk.get(id) : k[0] === 'g' ? item?.get(id) : null;
    if (r) out.push(k[0] === 'c' ? chunkRow(ctx, r) : itemRow(ctx, r));
  }
  return { rows: out, view: view(ctx) };
}

function findChunk(ctx, p) {
  const ptr = formatPtr(p);
  if (p.type === 'commit') {
    const rows = ctx.code.prepare(`SELECT * FROM chunks WHERE source = 'commit' AND sha LIKE ? LIMIT 2`).all(`${p.sha}%`);
    if (rows.length !== 1) throw new NotFoundError(ptr);   // none, or a prefix two commits share
    return rows[0];
  }
  const c = ctx.code.prepare('SELECT * FROM chunks WHERE source = ? AND path = ? AND start_line = ? AND end_line = ?')
    .get(p.type, p.type === 'vault' ? `vault:${p.path}` : p.path, p.a, p.b);
  if (!c) throw new NotFoundError(ptr);
  return c;
}

function findItem(ctx, p) {
  const r = ctx.gh?.prepare('SELECT * FROM items WHERE ptr = ?').get(formatPtr(p));
  if (!r) throw new NotFoundError(formatPtr(p));
  return r;
}

// reviews, inline comments and conversation comments of a PR / issue, by time
const threadRows = (gh, number) => gh.prepare(`SELECT * FROM items WHERE parent_number = ? AND kind IN ('review', 'review_comment', 'issue_comment')
  ORDER BY coalesce(submitted_at, created_at), id`).all(number);
// refs rows of one item; stale: resolved against another build than this code.db (pending until the next relink)
const refRows = (ctx, ptr) => ctx.gh.prepare('SELECT * FROM refs WHERE ptr = ?').all(ptr).map((r) => ({ ...r, stale: r.resolved_build !== ctx.meta.build_id }));

function get(ctx, ptrs) {
  const parsed = ptrs.map(parseRevPtr);
  for (const p of parsed) checkPtr(ctx, p);
  const items = parsed.map((p) => {
    if (GH_TYPES.includes(p.type)) {
      const r = findItem(ctx, p);
      return { ...itemRow(ctx, r), revs: null, thread: r.kind === 'pr' || r.kind === 'issue' ? threadRows(ctx.gh, r.number) : [], refs: refRows(ctx, r.ptr) };
    }
    const c = findChunk(ctx, p);
    // the merged PR whose merge commit this is
    const pr = c.source === 'commit' && /^[0-9a-f]{7,40}$/.test(c.sha ?? '') && ctx.gh
      ? ctx.gh.prepare(`SELECT ptr FROM items WHERE kind = 'pr' AND state = 'merged' AND merge_sha = ? LIMIT 1`).get(c.sha) : null;
    return { ...chunkRow(ctx, c), revs: null, thread: [], refs: [], prPtr: pr?.ptr ?? null };
  });
  return { items, view: view(ctx) };
}

function source(ctx, ptr) {
  const p = parseRevPtr(ptr);
  checkPtr(ctx, p);
  return { row: GH_TYPES.includes(p.type) ? itemRow(ctx, findItem(ctx, p)) : chunkRow(ctx, findChunk(ctx, p)), view: view(ctx) };
}

function resolveAsOf(ctx, spec) {
  if (spec != null) throw needsServer('--as-of');
  return { run: view(ctx).run, view: view(ctx) };
}

/** the same functions, synchronous (read.mjs Phase 1 API) */
export const core = { candidates, rows, get, source, resolveAsOf };

/** @param {import('../context.mjs').Ctx} ctx @returns {import('../pg/contract.mjs').Store} */
export function sqliteStore(ctx) {
  // asOf = this store's own run (a mirror's brain_run, which view.run reports) is the state it holds; any other is not here
  const latest = (o) => { if (o?.asOf != null && o.asOf !== view(ctx).run) throw needsServer('--as-of'); };
  return {
    async candidates(q, o = {}) { latest(o); return candidates(ctx, q, o); },
    async rows(keys, o) { latest(o); return rows(ctx, keys); },
    async get(ptrs, o) { latest(o); return get(ctx, ptrs); },
    async source(ptr, o) { latest(o); return source(ctx, ptr); },
    async resolveAsOf(spec) { return resolveAsOf(ctx, spec); },
    async close() { ctx.close(); },
  };
}
