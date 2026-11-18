// Pointer grammar (P0 contract, implemented here). A pointer is what an agent passes back to get / source.
//
//   GitHub items   pr:<n>  issue:<n>  review:<id>  rc:<id>  ic:<id>      n, id: positive integers
//   commits        commit:<sha>                                         7–40 lowercase hex
//   repo memory    <source>:<path>:<a>-<b>@<build>                      source: doc | change | changelog | vault
//                  path is the repo path (vault: the note's path inside the vault), never empty, no newline;
//                  a..b is the stored chunk's line range; build is code.db meta.build_id (8 chars [0-9a-z])
//
// Parsing reads the repo-memory form from the right, so a path may contain ':' or '@'.
//
// Server revisions (Phase 2 §6.1): any pointer but vault may end in `@r<n>` (parseRevPtr / formatRevPtr), the n-th
// revision of that item, forever the same text. Repo memory takes `@r<n>` in place of `@<build>`:
// doc:docs/billing.md:12-31@r3. parsePtr itself stays the Phase 1 grammar and refuses the suffix.

import { PtrError } from './errors.mjs';
import { parseRevPtr as splitRev, formatRevPtr as joinRev } from './pg/contract.mjs';

export const GH_TYPES = ['pr', 'issue', 'review', 'rc', 'ic'];
export const MEMORY_TYPES = ['doc', 'change', 'changelog', 'vault'];
// item kinds as stored in github.db items.kind
export const KIND_OF_TYPE = { pr: 'pr', issue: 'issue', review: 'review', rc: 'review_comment', ic: 'issue_comment' };
export const TYPE_OF_KIND = Object.fromEntries(Object.entries(KIND_OF_TYPE).map(([t, k]) => [k, t]));

const GH_RE = /^(pr|issue|review|rc|ic):([1-9]\d{0,15})$/;
const COMMIT_RE = /^commit:([0-9a-f]{7,40})$/;
const MEMORY_RE = /^(doc|change|changelog|vault):(.+):([1-9]\d*)-([1-9]\d*)@([0-9a-z]{8})$/;
const MEMORY_REV_RE = /^(doc|change|changelog):(.+):([1-9]\d*)-([1-9]\d*)$/;   // the base of a repo-memory revision pointer

/**
 * @typedef {{ type: 'pr'|'issue'|'review'|'rc'|'ic', id: number }} GhPtr
 * @typedef {{ type: 'commit', sha: string }} CommitPtr
 * @typedef {{ type: 'doc'|'change'|'changelog'|'vault', path: string, a: number, b: number, build: string }} MemoryPtr
 * @typedef {GhPtr | CommitPtr | MemoryPtr} Ptr
 */

/** @returns {Ptr} @throws {PtrError} */
export function parsePtr(s) {
  const str = String(s ?? '').trim();
  if (/[\n\r\0]/.test(str)) throw new PtrError(s);
  let m = GH_RE.exec(str);
  if (m) return { type: m[1], id: Number(m[2]) };
  m = COMMIT_RE.exec(str);
  if (m) return { type: 'commit', sha: m[1] };
  m = MEMORY_RE.exec(str);
  if (m) {
    const a = Number(m[3]), b = Number(m[4]);
    if (b < a) throw new PtrError(s);
    return { type: m[1], path: m[2], a, b, build: m[5] };
  }
  throw new PtrError(s);
}

/** @param {Ptr} p @returns {string} */
export function formatPtr(p) {
  if (GH_TYPES.includes(p.type)) return `${p.type}:${p.id}`;
  if (p.type === 'commit') return `commit:${p.sha}`;
  if (MEMORY_TYPES.includes(p.type)) return `${p.type}:${p.path}:${p.a}-${p.b}@${p.build}`;
  throw new PtrError(JSON.stringify(p));
}

// github.db items.ptr for a raw GitHub object of the given stored kind
export const itemPtr = (kind, idOrNumber) => `${TYPE_OF_KIND[kind]}:${idOrNumber}`;

/**
 * A pointer with its optional revision suffix. No suffix: parsePtr's result with rev null.
 * @returns {Ptr & { rev: number|null }} repo memory with a revision has build: null
 * @throws {PtrError}
 */
export function parseRevPtr(s) {
  const str = String(s ?? '').trim();
  const { base, rev } = splitRev(str);
  if (rev === null) return { ...parsePtr(str), rev: null };
  if (/[\n\r\0]/.test(base)) throw new PtrError(s);
  const m = MEMORY_REV_RE.exec(base);
  if (m) {
    const a = Number(m[3]), b = Number(m[4]);
    if (b < a) throw new PtrError(s);
    return { type: m[1], path: m[2], a, b, build: null, rev };
  }
  const p = parsePtr(base);
  if (MEMORY_TYPES.includes(p.type)) throw new PtrError(s);   // a build and a revision, or a vault note (never on the server)
  return { ...p, rev };
}

/** @param {Ptr & { rev?: number|null }} p @returns {string} */
export function formatRevPtr(p) {
  if (p.rev == null) return formatPtr(p);
  if (p.type === 'vault') throw new PtrError(JSON.stringify(p));
  const base = MEMORY_TYPES.includes(p.type) ? `${p.type}:${p.path}:${p.a}-${p.b}` : formatPtr(p);
  try { return joinRev(base, p.rev); } catch { throw new PtrError(JSON.stringify(p)); }
}
