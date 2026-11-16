// mirror (Q4): run R of the server as local SQLite files in the Phase 0 / Phase 1 shapes. Lane A owns this file.
// Q0 STUB: the signature below is the contract. Mapping: contract.COLUMN_MAP and design §6.7.
// - ids: nodes.id = node_id, chunks.id = chunk_id, github items.id = item_id, edges / unresolved / links / refs rowid =
//   the server row id. code.db nodes.key = node_rev.p0_key. meta = run.meta + contract.MIRROR_META_KEYS (brain_run,
//   brain_run_commit, brain_published_at, brain_checksum from the run row); the dropped keys (repo, worktree) are
//   written from the local checkout.
// - delta A -> B: rows with valid_from in (A, B] are put, rows with valid_to in (A, B] are deleted, rows with both are
//   skipped. Deletes first (with the chunks / refs of a closed revision), then puts (same id: replace).
// - FTS tables (chunks_fts, chunks_tri, items_fts, items_tri) are rebuilt locally for the changed rows.
// - Built in a temporary copy; snapshot(copy) must match run.checksum for the pulled shapes (contract.checksum), then
//   the copy is renamed over the old mirror. A mismatch drops the copy and pulls the full run.
import { NotImplementedError } from '../errors.mjs';

/**
 * @param {{ url: string, dir: string, run?: number|null, shapes: ('code'|'github')[] }} opts
 *   url: reader URL (laptops) or writer URL (CI); run: null = latest; shapes: laptops ['code'], CI ['code', 'github']
 * @returns {Promise<{ codeDb: string, githubDb: string|null, run: number, bytes: number }>} bytes received
 */
export async function pullMirror(_opts) { throw new NotImplementedError('pg.pullMirror'); }
