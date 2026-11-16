// snapshot · delta · upload check (Q2). Lane B owns this file. Q0 STUB: the signatures below are the contract.
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
//    brain_run (a mirror) or null (a fresh build). sync.github: githubSyncState.
import { NotImplementedError } from '../errors.mjs';

/**
 * @param {{ codeDb: string, githubDb: string|null, manifest: import('./contract.mjs').Manifest }} opts SQLite paths
 * @returns {import('./contract.mjs').State}
 */
export function snapshot(_opts) { throw new NotImplementedError('pg.snapshot'); }

/**
 * What to write so that the server goes from base to next (R7, R8). base is the snapshot of the run-B mirror (null for
 * an empty server); delta.base = base.run. Keys missing from next close only in `full` scopes. Commit items never close
 * for being outside the build window (R8), and neither do their links while the commit is missing; a commit link closes
 * when its target node closes or its commit item gets a new revision (R15).
 * @param {import('./contract.mjs').State|null} base @param {import('./contract.mjs').State} next
 * @returns {import('./contract.mjs').Delta}
 */
export function diff(_base, _next) { throw new NotImplementedError('pg.diff'); }

/**
 * The state the server shows after the delta: publish stores checksum(applyDelta(base, delta)) as run.checksum, and a
 * mirror of the new run must snapshot to the same checksum.
 * @param {import('./contract.mjs').State|null} base @param {import('./contract.mjs').Delta} delta
 * @returns {import('./contract.mjs').State}
 */
export function applyDelta(_base, _delta) { throw new NotImplementedError('pg.applyDelta'); }

/**
 * R16 upload check: the Phase 1 secret detector over every string in the delta (keys, paths, import strings, meta,
 * errors). Keys are never masked. Throws before any write connection is opened.
 * @param {import('./contract.mjs').Delta} delta
 * @throws {import('../errors.mjs').BrainError} code 'outbound-secret', with table and column names only (never the value)
 */
export function checkOutbound(_delta) { throw new NotImplementedError('pg.checkOutbound'); }
