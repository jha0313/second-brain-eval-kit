// What both stores (sqlite.mjs, pg.mjs) read a search request as, and the row shapes they hand to read.mjs.
// Lane C owns src/store/*.
import { terms } from '../why.mjs';

export const CAP = 2000;     // candidates per list (design §6.7); a list that reaches it is marked truncated
export const MAX_GET = 5;
const GH_KINDS = { pr: ['pr'], issue: ['issue'], review: ['review', 'review_comment'], comment: ['review_comment', 'issue_comment'] };
const MEMORY_SOURCES = ['doc', 'change', 'changelog', 'commit', 'vault'];
// --state closed means what GitHub means: not open (an issue closed, a PR merged or closed unmerged)
const STATES = { open: ['open'], merged: ['merged'], 'closed-unmerged': ['closed_unmerged'], closed: ['closed', 'merged', 'closed_unmerged'] };
export const LINK_STATUS = ['linked', 'ambiguous', 'unlinked', 'pending'];

/** @param {import('../read.mjs').SearchOpts} opts */
export function filterOf({ kind, state, path, author, since }) {
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

/** the query terms (why.mjs) and the trigram terms: Korean (no word boundaries) and identifiers / paths (partial matches) */
export function termsOf(q) {
  const t = terms(String(q ?? ''));
  return { ...t, tri: [...new Set([...t.hangul, ...t.names.filter((n) => [...n].length >= 3)])] };
}

export const listOf = (json) => {
  try { const a = JSON.parse(json ?? '[]'); return Array.isArray(a) ? a.filter((x) => typeof x === 'string').slice(0, 10) : []; } catch { return []; }
};

/**
 * One candidate as a store lists it: light, so a search moves keys, not bodies (§6.9). key / grp are opaque to read.mjs
 * (equal keys = the same row; grp = the row it ranks as: a review or comment ranks as its PR / issue, everything else as
 * itself). d: the group's date (tie-break). GitHub rows also carry their own ptr and flags (a matched child is shown
 * by those alone). Hydrate a group with store.rows([grp]).
 * @typedef {{ key: string, grp: string, d: string|null, ptr?: string, flags?: string|null }} Candidate
 */
