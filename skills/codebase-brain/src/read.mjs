// Read path, three steps: search (pointers) -> get (meta, thread, links) -> source (stored text).
// Lane E2 owns this file. Rendering to text is lane E1 (cli.mjs) and uses
// these objects only; E2 never prints and never computes coverage / freshness (it returns `facts` for that).
//
// Rules for every DTO:
// - strings written by people or taken from external text live under `untrusted` (titles, bodies, snippets,
//   logins, branch names, URLs, GitHub file paths, extracted ref targets). Enums, pointers, numbers, dates and
//   repo paths from code.db live outside it.
// - all strings come from the stores as stored (already sanitized). Nothing reads git or the working tree.
import { BrainError, NotFoundError, StalePtrError } from './errors.mjs';
import { parsePtr, formatPtr, GH_TYPES, MEMORY_TYPES, TYPE_OF_KIND } from './ptr.mjs';
import { terms } from './why.mjs';
import { safe, plural } from './fmt.mjs';
import { flagSuspicious } from './sanitize.mjs';

/**
 * @typedef {import('./context.mjs').Ctx} Ctx
 *
 * @typedef {{ kind?: string[], state?: string[], path?: string, author?: string, since?: string, limit?: number, cursor?: number }} SearchOpts
 *   kind values: pr, issue, review, comment, doc, change, changelog, commit, vault (review/comment narrow which children
 *   may match; rows still roll up to the parent pr/issue). review = reviews + inline review comments; comment = inline
 *   review comments + conversation (issue) comments. state values: open, merged, closed-unmerged, closed; closed means
 *   what GitHub means, not open (an issue closed, a PR merged or closed unmerged).
 *
 * @typedef {{
 *   ptr: string, type: 'pr'|'issue'|'doc'|'change'|'changelog'|'vault'|'commit',
 *   origin: 'github'|'repo'|'vault', state: string|null, date: string|null, assoc: string|null,
 *   matched: string[],                                   // child pointers that matched (max 3): review:…, rc:…, ic:…
 *   flags: string[],                                     // 'suspicious' (the row or a matched child), 'files-truncated'
 *   untrusted: { title: string, snippet: string, author: string|null }
 * }} SearchRow
 *
 * @typedef {{
 *   truncatedLists: string[],     // candidate lists that hit the 2,000 cap (e.g. 'items_fts')
 *   pathQuery: boolean,           // --path was given
 *   pathRefsPending: number,      // refs that could match --path but are pending / ambiguous: budget / stale build
 *   filesTruncated: number,       // PRs with >3,000 files (their file list is incomplete)
 *                                 // these two count toward coverage only when pathQuery is true (answer.coverage)
 *   githubPresent: boolean        // github.db exists
 * }} ReadFacts
 *
 * @typedef {{ query: string, rows: SearchRow[], total: number, next: number|null, facts: ReadFacts }} SearchResult
 *   total = candidates before grouping; next = value for --cursor, null at the end
 *
 * @typedef {{ status: 'pending'|'linked'|'ambiguous'|'unlinked', reason: string|null, resolved: string[], untrusted: { target: string } }} LinkDTO
 *
 * @typedef {{
 *   ptr: string, type: 'review'|'rc'|'ic', depth: 0|1, state: string|null, date: string|null, assoc: string|null,
 *   position: null | { side: string|null, startSide: string|null, start: number|null, end: number|null, commit: string|null,
 *                      outdated: boolean, originalStart: number|null, originalEnd: number|null, originalCommit: string|null },
 *   flags: string[],
 *   untrusted: { author: string|null, firstLine: string, path: string|null }
 * }} ThreadEntry
 *
 * @typedef {{
 *   ptr: string, type: string, origin: 'github'|'repo'|'vault', state: string|null, assoc: string|null, draft: boolean,
 *   dates: { created: string|null, updated: string|null, closed: string|null, merged: string|null, submitted: string|null },
 *   merge: { sha: string|null, commitPtr: string|null, prPtr: string|null },   // commitPtr for a PR, prPtr for a commit
 *   reviewsAt: string|null,
 *   parent: string|null,                                                      // review / rc / ic: the pr:N or issue:N it belongs to
 *   position: ThreadEntry['position'],                                        // rc: where the inline comment sits; else null
 *   path: string|null, lines: { a: number, b: number }|null,                  // repo memory only
 *   thread: ThreadEntry[],                                                    // PR / issue only
 *   links: { files: LinkDTO[], dirs: LinkDTO[], symbols: LinkDTO[], commits: LinkDTO[], items: LinkDTO[], routes: LinkDTO[], names: LinkDTO[] },
 *   flags: string[], redactions: number,
 *   untrusted: { title: string, author: string|null, url: string|null, base: string|null, head: string|null, firstLine: string,
 *                path?: string|null }                                         // rc: the GitHub file path it comments on
 * }} GetItem
 *
 * @typedef {{ items: GetItem[], facts: ReadFacts }} GetResult
 *
 * @typedef {{
 *   ptr: string, origin: 'github'|'repo'|'vault', date: string|null, assoc: string|null,
 *   from: number, to: number, total: number,   // 1-based line numbers within the stored text
 *   firstLineNo: number,                       // repo memory: file line of the first line shown (chunks.body_line + from - 1); github: from
 *   redactions: number, flags: string[],
 *   untrusted: { author: string|null, url: string|null, lines: string[] }
 * }} SourceResult
 */

const CAP = 2000;            // candidates per list (design §6.7); a list that reaches it is named in facts.truncatedLists
const RRF_K = 60;
const SHORT = 160;           // search snippet and get first line, in characters
const MAX_GET = 5;
const GH_KINDS = { pr: ['pr'], issue: ['issue'], review: ['review', 'review_comment'], comment: ['review_comment', 'issue_comment'] };
const MEMORY_SOURCES = ['doc', 'change', 'changelog', 'commit', 'vault'];
// --state closed means what GitHub means: not open (an issue closed, a PR merged or closed unmerged)
const STATES = { open: ['open'], merged: ['merged'], 'closed-unmerged': ['closed_unmerged'], closed: ['closed', 'merged', 'closed_unmerged'] };
const LINK_GROUPS = { file: 'files', dir: 'dirs', symbol: 'symbols', commit: 'commits', item: 'items', route: 'routes', name: 'names' };
const LINK_STATUS = ['linked', 'ambiguous', 'unlinked', 'pending'];
const FLAGS = ['suspicious', 'files-truncated'];
const REDACTED = /\[REDACTED:[a-z-]+(?::[0-9a-f]{4})?\]/g;

// Stored values that land outside `untrusted` are checked for shape; one that is not an enum / date / SHA becomes null
const shape = (re) => (v) => (typeof v === 'string' && re.test(v) ? v : null);
const enumOf = shape(/^[A-Za-z_]{1,40}$/);
const hexOf = shape(/^[0-9a-f]{7,40}$/);
const dateOf = shape(/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/);
const reasonOf = shape(/^[a-z-]{1,32}$/);
const stateOf = (v) => (enumOf(v) === 'closed_unmerged' ? 'closed-unmerged' : enumOf(v));
const flagsOf = (v) => String(v ?? '').split(' ').filter((f) => FLAGS.includes(f));
const strOr = (v) => (v == null ? null : String(v));

const marks = (a) => a.map(() => '?').join(', ');
const quote = (s) => `"${s.replace(/"/g, '""')}"`;
const cmp = (a, b) => { a = String(a ?? ''); b = String(b ?? ''); return a < b ? -1 : a > b ? 1 : 0; };
const cut = (s, n) => { const cs = [...s]; return cs.length <= n ? s : cs.slice(0, n - 1).join('') + '…'; };
// one line for a search row: frontmatter and heading lines dropped (the title shows them), whitespace folded
const snippet = (body) => cut(String(body ?? '').replace(/^---\n[\s\S]*?\n---\n?/, '').replace(/^#{1,6}\s.*$/gm, '').replace(/\s+/g, ' ').trim(), SHORT);
const firstLine = (body) => cut(String(body ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '', SHORT);
// a commit chunk's body ends with the build's "files: …" trailer: not part of the message
const textOf = (c) => (c.source === 'commit' ? String(c.body ?? '').replace(/^files: .*$/m, '') : c.body);
// repo memory has no flags / redactions columns: both are read off the stored (already masked) text
const marksOf = (text) => ({ flags: flagSuspicious(text ?? '') ? ['suspicious'] : [], redactions: (String(text ?? '').match(REDACTED) || []).length });
const listOf = (json) => {
  try { const a = JSON.parse(json ?? '[]'); return Array.isArray(a) ? a.filter((x) => typeof x === 'string').slice(0, 10) : []; } catch { return []; }
};
// path filter: the path itself or anything under it (substr, not LIKE: paths contain _ and %)
const UNDER = (col) => `(${col} = ? OR substr(${col}, 1, ?) = ?)`;
const underArgs = (p) => [p, [...p].length + 1, `${p}/`];

const chunkPtr = (c, build) => (c.source === 'commit' ? `commit:${c.sha.slice(0, 8)}`
  : formatPtr({ type: c.source, path: c.source === 'vault' ? c.path.replace(/^vault:/, '') : c.path, a: c.start_line, b: c.end_line, build }));
const emptyLinks = () => Object.fromEntries(Object.values(LINK_GROUPS).map((k) => [k, []]));
const facts = (ctx, over = {}) => ({ truncatedLists: [], pathQuery: false, pathRefsPending: 0, filesTruncated: 0, githubPresent: !!ctx.gh, ...over });

function checkBuild(ctx, p) {
  if (MEMORY_TYPES.includes(p.type) && p.build !== ctx.meta.build_id) throw new StalePtrError(formatPtr(p), p.build, ctx.meta.build_id ?? null);
}

function filterOf({ kind, state, path, author, since }) {
  const kinds = kind?.length ? kind : null;
  const p = path ? String(path).replace(/^\.\//, '').replace(/\/+$/, '') : '';
  return {
    ghKinds: [...new Set(kinds ? kinds.flatMap((k) => GH_KINDS[k] ?? []) : Object.values(GH_KINDS).flat())],
    // repo memory has no state and no author: either filter keeps it out
    sources: state?.length || author ? [] : kinds ? MEMORY_SOURCES.filter((s) => kinds.includes(s)) : MEMORY_SOURCES,
    states: state?.length ? [...new Set(state.flatMap((s) => STATES[s] ?? [s]))] : null,
    path: p || null,
    author: author ? String(author).replace(/^@/, '').toLowerCase() : null,
    since: since ? String(since) : null,
  };
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

function itemLists(gh, t, f, build, add) {
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
    `SELECT 'g' || i.id AS key, 'g' || r.id AS grp, ${ROW_DATE} AS d FROM ${from} ${ROW} WHERE ${match} AND ${w.join(' AND ')} ${order} LIMIT ${CAP + 1}`)
    .all(...args, ...p));
  if (t.ascii.length) run('items_fts', 'items_fts JOIN items i ON i.id = items_fts.rowid', 'items_fts MATCH ?', [t.ascii.map(quote).join(' OR ')], 'ORDER BY bm25(items_fts, 3.0, 1.0)');
  for (const s of triTerms(t)) {
    if ([...s].length >= 3) run('items_tri', 'items_tri JOIN items i ON i.id = items_tri.rowid', 'items_tri MATCH ?', [quote(s)], 'ORDER BY bm25(items_tri, 3.0, 1.0)');
    else run('items_tri', 'items i', '(i.title LIKE ? OR i.body LIKE ?)', [`%${s}%`, `%${s}%`]);
  }
  const nums = t.prs.flatMap((n) => [`pr:${n.slice(1)}`, `issue:${n.slice(1)}`]);
  if (nums.length) run('items_keys', 'items i', `i.ptr IN (${marks(nums)})`, nums);
  for (const sha of t.shas) run('items_keys', 'items i', 'i.merge_sha LIKE ?', [`${sha}%`]);
  return pending;
}

function chunkLists(code, t, f, add) {
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
  for (const s of triTerms(t)) {
    if ([...s].length >= 3) run('chunks_tri', 'chunks_tri JOIN chunks c ON c.id = chunks_tri.rowid', 'chunks_tri MATCH ?', [quote(s)], 'ORDER BY bm25(chunks_tri, 3.0, 1.0)');
    else run('chunks_tri', 'chunks c', '(c.title LIKE ? OR c.body LIKE ?)', [`%${s}%`, `%${s}%`]);
  }
  for (const n of t.prs) run('chunks_keys', 'chunks c', `(' ' || c.prs || ' ') LIKE ?`, [`% ${n} %`]);
  for (const sha of t.shas) run('chunks_keys', 'chunks c', 'c.sha LIKE ?', [`${sha}%`]);
}

// trigram terms: Korean (no word boundaries) and identifiers / paths (partial matches: "LiveRun" in useLiveRunStatus)
const triTerms = (t) => [...new Set([...t.hangul, ...t.names.filter((n) => [...n].length >= 3)])];

function searchRow(ctx, g) {
  const id = Number(g.key.slice(1));
  if (g.key[0] === 'c') {
    const c = ctx.code.prepare('SELECT * FROM chunks WHERE id = ?').get(id);
    return { ptr: chunkPtr(c, ctx.meta.build_id), type: c.source, origin: c.source === 'vault' ? 'vault' : 'repo', state: null, date: dateOf(c.date),
      assoc: null, matched: [], flags: marksOf(textOf(c)).flags, untrusted: { title: String(c.title ?? ''), snippet: snippet(textOf(c)), author: null } };
  }
  const r = ctx.gh.prepare('SELECT * FROM items WHERE id = ?').get(id);
  const childOf = ctx.gh.prepare('SELECT ptr, flags FROM items WHERE id = ?');
  const kids = g.children.sort((a, b) => b.score - a.score || cmp(a.key, b.key)).slice(0, 3).map((c) => childOf.get(Number(c.key.slice(1))));
  const flags = flagsOf(r.flags);
  if (!flags.includes('suspicious') && kids.some((k) => flagsOf(k.flags).includes('suspicious'))) flags.unshift('suspicious');
  return { ptr: r.ptr, type: TYPE_OF_KIND[r.kind], origin: 'github', state: stateOf(r.state), date: dateOf(g.d), assoc: enumOf(r.author_assoc),
    matched: kids.map((k) => k.ptr), flags, untrusted: { title: String(r.title ?? ''), snippet: snippet(r.body), author: strOr(r.author) } };
}

/** @param {Ctx} ctx @param {string} q @param {SearchOpts} [opts] @returns {SearchResult} */
export function search(ctx, q, opts = {}) {
  const t = terms(String(q ?? ''));
  const f = filterOf(opts);
  const limit = Math.max(1, Math.floor(Number(opts.limit) || 10)), cursor = Math.max(0, Math.floor(Number(opts.cursor) || 0));
  const out = facts(ctx, { pathQuery: !!f.path });
  const lists = [];
  const add = (name, rows) => {
    if (rows.length > CAP) { rows = rows.slice(0, CAP); if (!out.truncatedLists.includes(name)) out.truncatedLists.push(name); }
    if (rows.length) lists.push(rows);
  };
  if (ctx.gh) {
    out.filesTruncated = ctx.gh.prepare(`SELECT count(*) AS n FROM items WHERE kind = 'pr' AND (' ' || flags || ' ') LIKE '% files-truncated %'`).get().n;
    if (f.ghKinds.length) out.pathRefsPending = itemLists(ctx.gh, t, f, ctx.meta.build_id, add);
  }
  if (f.sources.length) chunkLists(ctx.code, t, f, add);

  // RRF over every list, then roll children up into their parent row; total counts candidates before the roll-up
  const fused = new Map();
  for (const l of lists) l.forEach((c, rank) => {
    const x = fused.get(c.key) ?? { ...c, score: 0 };
    x.score += 1 / (RRF_K + rank + 1);
    fused.set(c.key, x);
  });
  const groups = new Map();
  for (const c of fused.values()) {
    const g = groups.get(c.grp) ?? { key: c.grp, d: c.d, score: 0, children: [] };
    g.score = Math.max(g.score, c.score);
    if (c.key !== c.grp) g.children.push(c);
    groups.set(c.grp, g);
  }
  const ordered = [...groups.values()].sort((a, b) => b.score - a.score || cmp(b.d, a.d) || cmp(a.key, b.key));
  return { query: String(q ?? ''), rows: ordered.slice(cursor, cursor + limit).map((g) => searchRow(ctx, g)), total: fused.size,
    next: cursor + limit < ordered.length ? cursor + limit : null, facts: out };
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

const positionOf = (r) => (r.kind === 'review_comment' ? { side: enumOf(r.side), startSide: enumOf(r.start_side), start: r.start_line ?? null,
  end: r.line ?? null, commit: hexOf(r.commit_id), outdated: r.line == null, originalStart: r.original_start_line ?? null,
  originalEnd: r.original_line ?? null, originalCommit: hexOf(r.original_commit_id) } : null);

function threadEntry(r, depth) {
  const rc = r.kind === 'review_comment';
  return {
    ptr: r.ptr, type: TYPE_OF_KIND[r.kind], depth, state: stateOf(r.state), date: dateOf(r.submitted_at ?? r.created_at), assoc: enumOf(r.author_assoc),
    position: positionOf(r), flags: flagsOf(r.flags),
    untrusted: { author: strOr(r.author), firstLine: firstLine(r.body), path: rc ? strOr(r.path) : null },
  };
}

// reviews, inline comments and conversation comments by time; a reply sits right under the comment it answers (depth 1)
function thread(gh, number) {
  const rows = gh.prepare(`SELECT * FROM items WHERE parent_number = ? AND kind IN ('review', 'review_comment', 'issue_comment')
    ORDER BY coalesce(submitted_at, created_at), id`).all(number);
  const byPtr = new Map(rows.map((r) => [r.ptr, r]));
  const parentOf = (r) => {
    const o = r.kind === 'review_comment' && r.in_reply_to != null ? byPtr.get(`rc:${r.in_reply_to}`) : null;
    return o && o.in_reply_to == null ? o : null;   // GitHub answers the thread's first comment; anything else stays top level
  };
  const replies = new Map();
  for (const r of rows) { const o = parentOf(r); if (o) replies.set(o.ptr, [...(replies.get(o.ptr) ?? []), r]); }
  return rows.filter((r) => !parentOf(r)).flatMap((r) => [threadEntry(r, 0), ...(replies.get(r.ptr) ?? []).map((x) => threadEntry(x, 1))]);
}

// refs of one item, by kind. A ref resolved against another build counts as pending until the next relink (design §6.6)
function links(gh, ptr, build) {
  const out = emptyLinks(), seen = new Set();
  const rank = (s) => LINK_STATUS.indexOf(s);
  const rows = gh.prepare('SELECT * FROM refs WHERE ptr = ?').all(ptr).map((r) => {
    const status = LINK_STATUS.includes(r.status) ? r.status : 'pending';
    const stale = status !== 'pending' && r.resolved_build !== build;
    return { kind: r.kind, target: String(r.target), status: stale ? 'pending' : status, reason: stale ? null : reasonOf(r.reason),
      resolved: stale || status === 'pending' ? [] : listOf(r.resolved) };
  }).sort((a, b) => cmp(a.kind, b.kind) || cmp(a.target, b.target) || rank(a.status) - rank(b.status));
  for (const r of rows) {   // the same target from two origins (pr-files and text) shows once, best status first
    const group = LINK_GROUPS[r.kind];
    if (!group || seen.has(`${r.kind}\n${r.target}`)) continue;
    seen.add(`${r.kind}\n${r.target}`);
    out[group].push({ status: r.status, reason: r.reason, resolved: r.resolved, untrusted: { target: r.target } });
  }
  return out;
}

function getGithub(ctx, p) {
  const r = findItem(ctx, p);
  const parent = r.kind === 'pr' || r.kind === 'issue';
  // a merge SHA counts only for a merged PR (an open PR's merge_commit_sha is GitHub's test merge)
  const sha = r.kind === 'pr' && r.state === 'merged' ? hexOf(r.merge_sha) : null;
  // a child's parent: the PR with that number if github.db has it, else the issue (a comment on an issue)
  const up = parent || r.parent_number == null ? null
    : ctx.gh.prepare("SELECT ptr FROM items WHERE ptr IN (?, ?) ORDER BY kind = 'pr' DESC LIMIT 1").get(`pr:${r.parent_number}`, `issue:${r.parent_number}`);
  return {
    ptr: r.ptr, type: p.type, origin: 'github', state: stateOf(r.state), assoc: enumOf(r.author_assoc), draft: !!r.draft,
    dates: { created: dateOf(r.created_at), updated: dateOf(r.updated_at), closed: dateOf(r.closed_at), merged: dateOf(r.merged_at), submitted: dateOf(r.submitted_at) },
    merge: { sha, commitPtr: sha ? `commit:${sha.slice(0, 8)}` : null, prPtr: null },
    reviewsAt: dateOf(r.reviews_at), parent: up?.ptr ?? null, position: positionOf(r), path: null, lines: null,
    thread: parent ? thread(ctx.gh, r.number) : [],
    links: links(ctx.gh, r.ptr, ctx.meta.build_id),
    flags: flagsOf(r.flags), redactions: Number(r.redactions) || 0,
    untrusted: { title: String(r.title ?? ''), author: strOr(r.author), url: strOr(r.url), base: strOr(r.base), head: strOr(r.head), firstLine: firstLine(r.body),
      ...(r.kind === 'review_comment' && { path: strOr(r.path) }) },
  };
}

function getMemory(ctx, p) {
  const c = findChunk(ctx, p);
  const commit = p.type === 'commit';
  const sha = commit ? hexOf(c.sha) : null;
  const pr = sha && ctx.gh ? ctx.gh.prepare(`SELECT ptr FROM items WHERE kind = 'pr' AND state = 'merged' AND merge_sha = ? LIMIT 1`).get(sha) : null;
  return {
    ptr: formatPtr(p), type: p.type, origin: p.type === 'vault' ? 'vault' : 'repo', state: null, assoc: null, draft: false,
    dates: { created: dateOf(c.date), updated: null, closed: null, merged: null, submitted: null },
    merge: { sha, commitPtr: null, prPtr: pr?.ptr ?? null },
    reviewsAt: null, parent: null, position: null, path: commit ? null : p.path, lines: commit ? null : { a: c.start_line, b: c.end_line },
    thread: [], links: emptyLinks(), ...marksOf(c.body),
    untrusted: { title: String(c.title ?? ''), author: null, url: null, base: null, head: null, firstLine: firstLine(textOf(c)) },
  };
}

/**
 * @param {Ctx} ctx @param {string[]} ptrs at most 5 @returns {GetResult}
 * @throws {PtrError | NotFoundError | StalePtrError | BrainError} BrainError code 'too-many-pointers' for 6 or more
 */
export function get(ctx, ptrs) {
  if (ptrs.length > MAX_GET) throw new BrainError('too-many-pointers', `get takes at most ${MAX_GET} pointers (got ${ptrs.length})`);
  const parsed = ptrs.map(parsePtr);
  for (const p of parsed) checkBuild(ctx, p);
  const items = parsed.map((p) => (GH_TYPES.includes(p.type) ? getGithub(ctx, p) : getMemory(ctx, p)));
  return { items, facts: facts(ctx, { filesTruncated: items.filter((i) => i.flags.includes('files-truncated')).length }) };
}

/**
 * Stored text only (github.db items.body or code.db chunks.body). A Phase 0 pointer whose build differs from
 * code.db meta.build_id throws StalePtrError before any content is read.
 * @param {Ctx} ctx @param {string} ptr @param {{ from?: number, maxLines?: number }} [opts] defaults 1, 200
 * @returns {SourceResult}
 */
export function source(ctx, ptr, opts = {}) {
  const p = parsePtr(ptr);
  checkBuild(ctx, p);
  const from = Math.max(1, Math.floor(Number(opts.from) || 1)), max = Math.max(1, Math.floor(Number(opts.maxLines) || 200));
  let s;
  if (GH_TYPES.includes(p.type)) {
    const r = findItem(ctx, p);
    s = { ptr: r.ptr, origin: 'github', date: dateOf(r.submitted_at ?? r.created_at), assoc: enumOf(r.author_assoc), text: r.body, base: 1,
      redactions: Number(r.redactions) || 0, flags: flagsOf(r.flags), author: strOr(r.author), url: strOr(r.url) };
  } else {
    const c = findChunk(ctx, p);
    // body_line is NULL until lane B's index-knowledge fills it: start_line is the same line unless sections() trimmed blank lines
    s = { ptr: formatPtr(p), origin: p.type === 'vault' ? 'vault' : 'repo', date: dateOf(c.date), assoc: null, text: c.body,
      base: c.body_line ?? c.start_line ?? 1, ...marksOf(c.body), author: null, url: null };
  }
  const all = s.text ? String(s.text).split('\n') : [];
  const to = Math.min(all.length, from + max - 1);
  return { ptr: s.ptr, origin: s.origin, date: s.date, assoc: s.assoc, from, to, total: all.length, firstLineNo: s.base + from - 1,
    redactions: s.redactions, flags: s.flags, untrusted: { author: s.author, url: s.url, lines: all.slice(from - 1, to) } };
}

/**
 * Quote envelope (design §6.5 L3): returns the lines to print, nothing else.
 *   ── quote <ptr> · untrusted · <origin> · @<author> (<ASSOC>) · <date> · <url>
 *   │ <line>                       github: the stored line · repo memory: "│ <lineNo>  <line>"
 *   ── end quote <ptr> · <n> redaction(s) · flag: suspicious      (the flag part only when flagged)
 * Every external value in the head line goes through fmt.safe(); the body lines are already sanitized.
 * @param {SourceResult} src @returns {string[]}
 */
export function envelope(src) {
  const u = src.untrusted;
  const who = u.author != null ? `@${safe(u.author)}${src.assoc ? ` (${safe(src.assoc)})` : ''}` : null;
  const head = [`── quote ${safe(src.ptr)}`, 'untrusted', safe(src.origin), who, src.date ? safe(src.date).slice(0, 10) : null, u.url ? safe(u.url) : null];
  const body = u.lines.map((l, i) => (src.origin === 'github' ? `│ ${l}` : `│ ${src.firstLineNo + i}  ${l}`));
  const end = [`── end quote ${safe(src.ptr)}`, plural(src.redactions, 'redaction'), src.flags.includes('suspicious') ? 'flag: suspicious' : null];
  return [head.filter(Boolean).join(' · '), ...body, end.filter(Boolean).join(' · ')];
}
