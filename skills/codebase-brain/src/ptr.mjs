// Pointer grammar (P0 contract, implemented here). A pointer is what an agent passes back to get / source.
//
//   GitHub items   pr:<n>  issue:<n>  review:<id>  rc:<id>  ic:<id>      n, id: positive integers
//   commits        commit:<sha>                                         7–40 lowercase hex
//   repo memory    <source>:<path>:<a>-<b>@<build>                      source: doc | change | changelog | vault
//                  path is the repo path (vault: the note's path inside the vault), never empty, no newline;
//                  a..b is the stored chunk's line range; build is code.db meta.build_id (8 chars [0-9a-z])
//
// Parsing reads the repo-memory form from the right, so a path may contain ':' or '@'.

import { PtrError } from './errors.mjs';

export const GH_TYPES = ['pr', 'issue', 'review', 'rc', 'ic'];
export const MEMORY_TYPES = ['doc', 'change', 'changelog', 'vault'];
// item kinds as stored in github.db items.kind
export const KIND_OF_TYPE = { pr: 'pr', issue: 'issue', review: 'review', rc: 'review_comment', ic: 'issue_comment' };
export const TYPE_OF_KIND = Object.fromEntries(Object.entries(KIND_OF_TYPE).map(([t, k]) => [k, t]));

const GH_RE = /^(pr|issue|review|rc|ic):([1-9]\d{0,15})$/;
const COMMIT_RE = /^commit:([0-9a-f]{7,40})$/;
const MEMORY_RE = /^(doc|change|changelog|vault):(.+):([1-9]\d*)-([1-9]\d*)@([0-9a-z]{8})$/;

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
