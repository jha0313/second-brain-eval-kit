// linker: raw references out of text (pure) and their resolution against the current code.db (relink).
// Lane D owns this file. P0 STUB: extract nothing, relink is a no-op, so build and sync keep working.
//
// Contract (design §6.6):
// - extraction is PURE and index-free: it only classifies strings by shape. Whether a path exists, whether a
//   basename is unique, whether a route string is really a file path is decided at relink time.
// - extraction never emits a target that isRedacted() (sanitize.mjs); such strings get no ref at all
// - relink runs inside the caller's withWriteLock (build end, sync end). It opens github.db itself (read-write)
//   and code.db read-only, and closes both in finally. No network. git grep only via execFile, no shell.
// - relink resolves refs whose status is 'pending' or whose resolved_build differs from code.db meta.build_id
// - resolved targets that point into code are repo paths taken from code.db (already sanitized), never raw grep text
//   beyond "path:line"
import { NotImplementedError } from './errors.mjs';

/**
 * @typedef {{ kind: 'file'|'dir'|'symbol'|'commit'|'item'|'route'|'name', target: string, origin: 'text'|'merge-sha'|'inline'|'pr-files' }} RawRef
 * @typedef {{ ptr: string, kind: string, title?: string|null, body?: string|null, path?: string|null, merge_sha?: string|null }} RefSource
 *   a sanitized items row (or the subset of it extraction reads)
 */

/**
 * Raw refs for one item from its title, body, inline path and merge SHA. selfRepo 'owner/name' marks
 * owner/repo#12 of the same repo as an item ref and others as external.
 * @param {RefSource} item @param {{ selfRepo: string }} opts @returns {RawRef[]} deduplicated
 */
export function extractRefs(_item, { selfRepo: _selfRepo } = {}) { return []; }

/**
 * pr-files refs from client.files(n).files (filenames are sanitized by the caller first). A rename adds the old path too.
 * @param {{ filename: string, previous_filename?: string }[]} files @returns {RawRef[]}
 */
export function fileRefs(_files) { return []; }

/**
 * @param {{ codeDbPath: string, repoDir: string, budget?: { bytes: number, ms: number }, log?: (s: string) => void }} opts
 * @returns {Promise<null | { linked: number, ambiguous: number, unlinked: number, pending: number, build: string }>}
 *   null when there is no github.db next to the code DB
 */
export async function relink(_opts) { return null; }

export const NOT_IMPLEMENTED = NotImplementedError;   // keeps the import used while the stub is in place
