// Read path, three steps: search (pointers) -> get (meta, thread, links) -> source (stored text).
// Lane E2 owns this file. P0: the DTO contract below + stubs. Rendering to text is lane E1 (cli.mjs) and uses
// these objects only; E2 never prints and never computes coverage / freshness (it returns `facts` for that).
//
// Rules for every DTO:
// - strings written by people or taken from external text live under `untrusted` (titles, bodies, snippets,
//   logins, branch names, URLs, GitHub file paths, extracted ref targets). Enums, pointers, numbers, dates and
//   repo paths from code.db live outside it.
// - all strings come from the stores as stored (already sanitized). Nothing reads git or the working tree.
import { NotImplementedError } from './errors.mjs';

/**
 * @typedef {import('./context.mjs').Ctx} Ctx
 *
 * @typedef {{ kind?: string[], state?: string[], path?: string, author?: string, since?: string, limit?: number, cursor?: number }} SearchOpts
 *   kind values: pr, issue, review, comment, doc, change, changelog, commit, vault (review/comment narrow which children
 *   may match; rows still roll up to the parent pr/issue). state values: open, merged, closed-unmerged, closed.
 *
 * @typedef {{
 *   ptr: string, type: 'pr'|'issue'|'doc'|'change'|'changelog'|'vault'|'commit',
 *   origin: 'github'|'repo'|'vault', state: string|null, date: string|null, assoc: string|null,
 *   matched: string[],                                   // child pointers that matched (max 3): review:…, rc:…, ic:…
 *   untrusted: { title: string, snippet: string, author: string|null }
 * }} SearchRow
 *
 * @typedef {{
 *   truncatedLists: string[],     // candidate lists that hit the 2,000 cap (e.g. 'items_fts')
 *   pathQuery: boolean,           // --path was given
 *   pathRefsPending: number,      // refs that could match --path but are pending / ambiguous: budget / stale build
 *   filesTruncated: number,       // PRs with >3,000 files (their file list is incomplete)
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
 *   untrusted: { author: string|null, firstLine: string, path: string|null }
 * }} ThreadEntry
 *
 * @typedef {{
 *   ptr: string, type: string, origin: 'github'|'repo'|'vault', state: string|null, assoc: string|null, draft: boolean,
 *   dates: { created: string|null, updated: string|null, closed: string|null, merged: string|null, submitted: string|null },
 *   merge: { sha: string|null, commitPtr: string|null, prPtr: string|null },   // commitPtr for a PR, prPtr for a commit
 *   reviewsAt: string|null,
 *   path: string|null, lines: { a: number, b: number }|null,                  // repo memory only
 *   thread: ThreadEntry[],                                                    // PR / issue only
 *   links: { files: LinkDTO[], dirs: LinkDTO[], symbols: LinkDTO[], commits: LinkDTO[], items: LinkDTO[], routes: LinkDTO[], names: LinkDTO[] },
 *   flags: string[], redactions: number,
 *   untrusted: { title: string, author: string|null, url: string|null, base: string|null, head: string|null, firstLine: string }
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

/** @param {Ctx} ctx @param {string} q @param {SearchOpts} [opts] @returns {SearchResult} */
export function search(_ctx, _q, _opts = {}) { throw new NotImplementedError('read.search'); }

/** @param {Ctx} ctx @param {string[]} ptrs at most 5 @returns {GetResult} @throws {PtrError | NotFoundError | StalePtrError} */
export function get(_ctx, _ptrs) { throw new NotImplementedError('read.get'); }

/**
 * Stored text only (github.db items.body or code.db chunks.body). A Phase 0 pointer whose build differs from
 * code.db meta.build_id throws StalePtrError before any content is read.
 * @param {Ctx} ctx @param {string} ptr @param {{ from?: number, maxLines?: number }} [opts] defaults 1, 200
 * @returns {SourceResult}
 */
export function source(_ctx, _ptr, _opts = {}) { throw new NotImplementedError('read.source'); }

/**
 * Quote envelope (design §6.5 L3): returns the lines to print, nothing else.
 *   ── quote <ptr> · untrusted · <origin> · @<author> (<ASSOC>) · <date> · <url>
 *   │ <line>                       github: the stored line · repo memory: "│ <lineNo>  <line>"
 *   ── end quote <ptr> · <n> redaction(s) · flag: suspicious      (the flag part only when flagged)
 * Every external value in the head line goes through fmt.safe(); the body lines are already sanitized.
 * @param {SourceResult} src @returns {string[]}
 */
export function envelope(_src) { throw new NotImplementedError('read.envelope'); }
