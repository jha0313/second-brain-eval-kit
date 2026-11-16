// Read path, three steps: search (pointers) -> get (meta, thread, links) -> source (stored text).
// Rendering to text is cli.mjs / render.mjs and uses these objects only; this file never prints and never computes
// coverage / freshness (it returns `facts` for that). Lane C owns it from Phase 2 on.
// The rows come from a store (src/store/*: SQLite in local mode, Postgres in server mode); this file shapes them.
// - search / get / source (ctx, …): the Phase 1 API, synchronous, on a read context (the SQLite store's core).
// - searchIn / getIn / sourceIn (store, …): async, any store; the result also carries `view` (the run it read). A call
//   after the first passes asOf = view.run, so one command reads one run (design §6.4, V16).
//
// Rules for every DTO:
// - strings written by people or taken from external text live under `untrusted` (titles, bodies, snippets,
//   logins, branch names, URLs, GitHub file paths, extracted ref targets). Enums, pointers, numbers, dates and
//   repo paths from code.db live outside it.
// - all strings come from the stores as stored (already sanitized). Nothing reads git or the working tree.
import { BrainError } from './errors.mjs';
import { parseRevPtr, formatRevPtr, GH_TYPES, TYPE_OF_KIND } from './ptr.mjs';
import { safe, plural } from './fmt.mjs';
import { flagSuspicious } from './sanitize.mjs';
import { core } from './store/sqlite.mjs';
import { MAX_GET, LINK_STATUS, filterOf, listOf } from './store/common.mjs';

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
 *                path?: string|null },                                        // rc: the GitHub file path it comments on
 *   revs?: { rev: number, run: number, publishedAt: string|null, state: string|null }[]   // server store only: every revision
 * }} GetItem
 *
 * @typedef {{ items: GetItem[], facts: ReadFacts }} GetResult
 *
 * @typedef {{
 *   ptr: string, origin: 'github'|'repo'|'vault', date: string|null, assoc: string|null,
 *   state: string|null, draft: boolean, ended: string|null,   // github: item state, merged_at ?? closed_at; repo/vault: null, false, null
 *   from: number, to: number, total: number,   // 1-based line numbers within the stored text
 *   firstLineNo: number,                       // repo memory: file line of the first line shown (chunks.body_line + from - 1); github: from
 *   redactions: number, flags: string[],
 *   untrusted: { author: string|null, url: string|null, lines: string[] }
 * }} SourceResult
 */

const RRF_K = 60;
const SHORT = 160;           // search snippet and get first line, in characters
const LINK_GROUPS = { file: 'files', dir: 'dirs', symbol: 'symbols', commit: 'commits', item: 'items', route: 'routes', name: 'names' };
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

const cmp = (a, b) => { a = String(a ?? ''); b = String(b ?? ''); return a < b ? -1 : a > b ? 1 : 0; };
const cut = (s, n) => { const cs = [...s]; return cs.length <= n ? s : cs.slice(0, n - 1).join('') + '…'; };
// one line for a search row: frontmatter and heading lines dropped (the title shows them), whitespace folded
const snippet = (body) => cut(String(body ?? '').replace(/^---\n[\s\S]*?\n---\n?/, '').replace(/^#{1,6}\s.*$/gm, '').replace(/\s+/g, ' ').trim(), SHORT);
const firstLine = (body) => cut(String(body ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '', SHORT);
// a commit chunk's body ends with the build's "files: …" trailer: not part of the message
const textOf = (c) => (c.source === 'commit' ? String(c.body ?? '').replace(/^files: .*$/m, '') : c.body);
// repo memory has no flags / redactions columns: both are read off the stored (already masked) text
const marksOf = (text) => ({ flags: flagSuspicious(text ?? '') ? ['suspicious'] : [], redactions: (String(text ?? '').match(REDACTED) || []).length });
const emptyLinks = () => Object.fromEntries(Object.values(LINK_GROUPS).map((k) => [k, []]));
const factsOf = (githubPresent, over = {}) => ({ truncatedLists: [], pathQuery: false, pathRefsPending: 0, filesTruncated: 0, githubPresent, ...over });
const revsOf = (revs) => (Array.isArray(revs) ? { revs: revs.map((r) => ({ rev: Number(r.rev), run: Number(r.run), publishedAt: dateOf(r.publishedAt), state: stateOf(r.state) })) } : {});

// ---------- search: RRF over the store's candidate lists, roll-up into parents, then the shown groups hydrated ----------

function rank(c, opts) {
  const limit = Math.max(1, Math.floor(Number(opts.limit) || 10)), cursor = Math.max(0, Math.floor(Number(opts.cursor) || 0));
  const out = factsOf(c.facts.githubPresent, { pathQuery: !!filterOf(opts).path, pathRefsPending: c.facts.pathRefsPending, filesTruncated: c.facts.filesTruncated });
  for (const l of c.lists) if (l.truncated && !out.truncatedLists.includes(l.name)) out.truncatedLists.push(l.name);
  // RRF over every list, then roll children up into their parent row; total counts candidates before the roll-up
  const fused = new Map();
  for (const l of c.lists) l.rows.forEach((x, rank) => {
    const f = fused.get(x.key) ?? { ...x, score: 0 };
    f.score += 1 / (RRF_K + rank + 1);
    fused.set(x.key, f);
  });
  const groups = new Map();
  for (const x of fused.values()) {
    const g = groups.get(x.grp) ?? { key: x.grp, d: x.d, score: 0, children: [] };
    g.score = Math.max(g.score, x.score);
    if (x.key !== x.grp) g.children.push(x);
    groups.set(x.grp, g);
  }
  const ordered = [...groups.values()].sort((a, b) => b.score - a.score || cmp(b.d, a.d) || cmp(a.key, b.key));
  return { shown: ordered.slice(cursor, cursor + limit), total: fused.size, next: cursor + limit < ordered.length ? cursor + limit : null, facts: out };
}

function searchRow(g, r) {
  if (!r) throw new BrainError('store', `the store lost search row ${g.key}`);
  if (r.origin !== 'github') {
    return { ptr: r.ptr, type: r.source, origin: r.origin, state: null, date: dateOf(r.date), assoc: null, matched: [], flags: marksOf(textOf(r)).flags,
      untrusted: { title: String(r.title ?? ''), snippet: snippet(textOf(r)), author: null } };
  }
  const kids = g.children.sort((a, b) => b.score - a.score || cmp(a.key, b.key)).slice(0, 3);
  const flags = flagsOf(r.flags);
  if (!flags.includes('suspicious') && kids.some((k) => flagsOf(k.flags).includes('suspicious'))) flags.unshift('suspicious');
  return { ptr: r.ptr, type: TYPE_OF_KIND[r.kind], origin: 'github', state: stateOf(r.state), date: dateOf(g.d), assoc: enumOf(r.author_assoc),
    matched: kids.map((k) => k.ptr), flags, untrusted: { title: String(r.title ?? ''), snippet: snippet(r.body), author: strOr(r.author) } };
}

function searchResult(q, rk, rows) {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return { query: String(q ?? ''), rows: rk.shown.map((g) => searchRow(g, byKey.get(g.key))), total: rk.total, next: rk.next, facts: rk.facts };
}

/** @param {Ctx} ctx @param {string} q @param {SearchOpts} [opts] @returns {SearchResult} */
export function search(ctx, q, opts = {}) {
  const rk = rank(core.candidates(ctx, q, opts), opts);
  return searchResult(q, rk, core.rows(ctx, rk.shown.map((g) => g.key)).rows);
}

/**
 * @param {import('./pg/contract.mjs').Store} store @param {string} q @param {SearchOpts & import('./pg/contract.mjs').AtRun} [opts]
 * @returns {Promise<SearchResult & { view: import('./pg/contract.mjs').View }>}
 */
export async function searchIn(store, q, opts = {}) {
  const c = await store.candidates(q, opts);
  const rk = rank(c, opts);
  const { rows } = rk.shown.length ? await store.rows(rk.shown.map((g) => g.key), { asOf: c.view.run }) : { rows: [] };
  return { ...searchResult(q, rk, rows), view: c.view };
}

// ---------- get ----------

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

// thread rows by time (the store's order); a reply sits right under the comment it answers (depth 1)
function threadOf(rows) {
  const byPtr = new Map(rows.map((r) => [r.ptr, r]));
  const parentOf = (r) => {
    const o = r.kind === 'review_comment' && r.in_reply_to != null ? byPtr.get(`rc:${r.in_reply_to}`) : null;
    return o && o.in_reply_to == null ? o : null;   // GitHub answers the thread's first comment; anything else stays top level
  };
  const replies = new Map();
  for (const r of rows) { const o = parentOf(r); if (o) replies.set(o.ptr, [...(replies.get(o.ptr) ?? []), r]); }
  return rows.filter((r) => !parentOf(r)).flatMap((r) => [threadEntry(r, 0), ...(replies.get(r.ptr) ?? []).map((x) => threadEntry(x, 1))]);
}

// refs of one item, by kind. A ref resolved against another build (row.stale) counts as pending until the next relink (§6.6)
function linksOf(refs) {
  const out = emptyLinks(), seen = new Set();
  const rank = (s) => LINK_STATUS.indexOf(s);
  const rows = refs.map((r) => {
    const status = LINK_STATUS.includes(r.status) ? r.status : 'pending';
    const stale = status !== 'pending' && r.stale;
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

function getGithub(r, p) {
  const parent = r.kind === 'pr' || r.kind === 'issue';
  // a merge SHA counts only for a merged PR (an open PR's merge_commit_sha is GitHub's test merge)
  const sha = r.kind === 'pr' && r.state === 'merged' ? hexOf(r.merge_sha) : null;
  return {
    ptr: p.rev == null ? r.ptr : formatRevPtr(p), type: p.type, origin: 'github', state: stateOf(r.state), assoc: enumOf(r.author_assoc), draft: !!r.draft,
    dates: { created: dateOf(r.created_at), updated: dateOf(r.updated_at), closed: dateOf(r.closed_at), merged: dateOf(r.merged_at), submitted: dateOf(r.submitted_at) },
    merge: { sha, commitPtr: sha ? `commit:${sha.slice(0, 8)}` : null, prPtr: null },
    reviewsAt: dateOf(r.reviews_at), parent: r.parentPtr ?? null, position: positionOf(r), path: null, lines: null,
    thread: parent ? threadOf(r.thread) : [],
    links: linksOf(r.refs),
    flags: flagsOf(r.flags), redactions: Number(r.redactions) || 0,
    untrusted: { title: String(r.title ?? ''), author: strOr(r.author), url: strOr(r.url), base: strOr(r.base), head: strOr(r.head), firstLine: firstLine(r.body),
      ...(r.kind === 'review_comment' && { path: strOr(r.path) }) },
    ...revsOf(r.revs),
  };
}

function getMemory(c, p) {
  const commit = p.type === 'commit';
  const sha = commit ? hexOf(c.sha) : null;
  return {
    ptr: formatRevPtr(p), type: p.type, origin: p.type === 'vault' ? 'vault' : 'repo', state: null, assoc: null, draft: false,
    dates: { created: dateOf(c.date), updated: null, closed: null, merged: null, submitted: null },
    merge: { sha, commitPtr: null, prPtr: c.prPtr ?? null },
    reviewsAt: null, parent: null, position: null, path: commit ? null : p.path, lines: commit ? null : { a: c.start_line, b: c.end_line },
    thread: [], links: emptyLinks(), ...marksOf(c.body),
    untrusted: { title: String(c.title ?? ''), author: null, url: null, base: null, head: null, firstLine: firstLine(textOf(c)) },
    ...revsOf(c.revs),
  };
}

function checkCount(ptrs) {
  if (ptrs.length > MAX_GET) throw new BrainError('too-many-pointers', `get takes at most ${MAX_GET} pointers (got ${ptrs.length})`);
  return ptrs.map(parseRevPtr);
}
function getResult(res, parsed) {
  const items = res.items.map((it, i) => (GH_TYPES.includes(parsed[i].type) ? getGithub(it, parsed[i]) : getMemory(it, parsed[i])));
  return { items, facts: factsOf(res.view.sync != null, { filesTruncated: items.filter((i) => i.flags.includes('files-truncated')).length }) };
}

/**
 * @param {Ctx} ctx @param {string[]} ptrs at most 5 @returns {GetResult}
 * @throws {PtrError | NotFoundError | StalePtrError | BrainError} BrainError code 'too-many-pointers' for 6 or more
 */
export function get(ctx, ptrs) {
  const parsed = checkCount(ptrs);
  return getResult(core.get(ctx, ptrs), parsed);
}

/** @param {import('./pg/contract.mjs').Store} store @param {string[]} ptrs @param {import('./pg/contract.mjs').AtRun} [opts] */
export async function getIn(store, ptrs, opts = {}) {
  const parsed = checkCount(ptrs);
  const res = await store.get(ptrs, opts);
  return { ...getResult(res, parsed), view: res.view };
}

// ---------- source ----------

function sourceResult(r, p, opts) {
  const from = Math.max(1, Math.floor(Number(opts.from) || 1)), max = Math.max(1, Math.floor(Number(opts.maxLines) || 200));
  const s = r.origin === 'github'
    ? { ptr: p.rev == null ? r.ptr : formatRevPtr(p), origin: 'github', date: dateOf(r.submitted_at ?? r.created_at), assoc: enumOf(r.author_assoc), text: r.body, base: 1,
      redactions: Number(r.redactions) || 0, flags: flagsOf(r.flags), author: strOr(r.author), url: strOr(r.url),
      state: stateOf(r.state), draft: !!r.draft, ended: dateOf(r.merged_at ?? r.closed_at) }
    // body_line is NULL until lane B's index-knowledge fills it: start_line is the same line unless sections() trimmed blank lines
    : { ptr: formatRevPtr(p), origin: p.type === 'vault' ? 'vault' : 'repo', date: dateOf(r.date), assoc: null, text: r.body,
      base: r.body_line ?? r.start_line ?? 1, ...marksOf(r.body), author: null, url: null, state: null, draft: false, ended: null };
  const all = s.text ? String(s.text).split('\n') : [];
  const to = Math.min(all.length, from + max - 1);
  return { ptr: s.ptr, origin: s.origin, date: s.date, assoc: s.assoc, state: s.state, draft: s.draft, ended: s.ended, from, to, total: all.length,
    firstLineNo: s.base + from - 1, redactions: s.redactions, flags: s.flags, untrusted: { author: s.author, url: s.url, lines: all.slice(from - 1, to) } };
}

/**
 * Stored text only (github.db items.body or code.db chunks.body). A Phase 0 pointer whose build differs from
 * code.db meta.build_id throws StalePtrError before any content is read.
 * @param {Ctx} ctx @param {string} ptr @param {{ from?: number, maxLines?: number }} [opts] defaults 1, 200
 * @returns {SourceResult}
 */
export function source(ctx, ptr, opts = {}) {
  const p = parseRevPtr(ptr);
  return sourceResult(core.source(ctx, ptr).row, p, opts);
}

/** @param {import('./pg/contract.mjs').Store} store @param {string} ptr @param {{ from?: number, maxLines?: number } & import('./pg/contract.mjs').AtRun} [opts] */
export async function sourceIn(store, ptr, opts = {}) {
  const p = parseRevPtr(ptr);
  const { row, view } = await store.source(ptr, { asOf: opts.asOf ?? null });
  return { ...sourceResult(row, p, opts), view };
}

/**
 * Quote envelope (design §6.5 L3): returns the lines to print, nothing else.
 *   ── quote <ptr> · untrusted · <origin> · <state> · @<author> (<ASSOC>) · <date> · <url>
 *   │ <line>                       github: the stored line · repo memory: "│ <lineNo>  <line>"
 *   ── end quote <ptr> · <n> redaction(s) · flag: suspicious      (the flag part only when flagged)
 * <state> (github items that have one): "open", "open (draft)", "approved", "closed 2026-11-16", "merged 2026-11-10".
 * Without it a claim in a closed issue read as live work (dev trial B12).
 * Every external value in the head line goes through fmt.safe(); the body lines are already sanitized.
 * @param {SourceResult} src @returns {string[]}
 */
export function envelope(src) {
  const u = src.untrusted;
  const who = u.author != null ? `@${safe(u.author)}${src.assoc ? ` (${safe(src.assoc)})` : ''}` : null;
  const st = src.state
    ? `${safe(src.state).toLowerCase().replace(/_/g, '-')}${src.draft ? ' (draft)' : ''}${src.state !== 'open' && src.ended ? ` ${safe(src.ended).slice(0, 10)}` : ''}` : null;
  const head = [`── quote ${safe(src.ptr)}`, 'untrusted', safe(src.origin), st, who, src.date ? safe(src.date).slice(0, 10) : null, u.url ? safe(u.url) : null];
  const body = u.lines.map((l, i) => (src.origin === 'github' ? `│ ${l}` : `│ ${src.firstLineNo + i}  ${l}`));
  const end = [`── end quote ${safe(src.ptr)}`, plural(src.redactions, 'redaction'), src.flags.includes('suspicious') ? 'flag: suspicious' : null];
  return [head.filter(Boolean).join(' · '), ...body, end.filter(Boolean).join(' · ')];
}
