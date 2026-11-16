// brain sync: incremental GitHub collection into github.db. Lane G owns this file. P0: contract + stubs.
//
// Contract (design §6.2 R1–R13, §6.3):
// - sync() takes withWriteLock itself, opens github.db read-write (openGithubDb create), and closes it in finally
// - first call of the run: client.getRepo(); repo id mismatch with sync_state.repo_id -> status 'failed', nothing written
// - item pages are committed one transaction per page via upsertPage(); the cursor is written ONLY in the final
//   transaction, after every request of R3–R8 succeeded (R11)
// - every external string is sanitized (deps.sanitize / sanitizeLine) BEFORE the first SQL bind; redaction counts
//   and the suspicious flag are stored on the item
// - sync_state.sanitize_version is set to SANITIZE_VERSION on a successful --full or first sync; an incremental run
//   on a store with a lower version fails with GuardError('github') (the user must run --full)
// - after the final transaction (ok or failed) relink() runs inside the same lock; its failure never fails the sync
// - --full: collect into `<github.db>.full-tmp`, close it, then rename over github.db (still inside the lock)
import { NotImplementedError } from './errors.mjs';

/**
 * A sanitized items row ready to store (column names as in gh-schema.mjs items). ptr and kind are required.
 * @typedef {Record<string, any> & { ptr: string, kind: string }} ItemRow
 * @typedef {{ item: ItemRow, refs: import('./link.mjs').RawRef[] }} PageEntry   refs: origins text | merge-sha | inline only
 * @typedef {{ sanitize: Function, sanitizeLine: Function, extractRefs: Function, fileRefs: Function, relink: Function }} SyncDeps
 * @typedef {{ status: 'ok'|'failed'|'busy', cursor: string|null, counts: { prs: number, issues: number, reviews: number,
 *   reviewComments: number, issueComments: number, files: number, requests: number }, error: string|null, staleLock: boolean,
 *   relink: object|null }} SyncResult
 */

/**
 * @param {{ codeDbPath: string, repoDir: string, client: import('./gh-client.mjs').GhClient, full?: boolean,
 *   log?: (s: string) => void, clock?: import('./gh-client.mjs').Clock, deps?: Partial<SyncDeps> }} opts
 * @returns {Promise<SyncResult>}
 */
export async function sync(_opts) { throw new NotImplementedError('gh-sync.sync'); }

/**
 * Store one page atomically: for each entry, upsert the item (R6: an older updated_at never overwrites; reviews
 * overwrite every field), replace its FTS rows, replace its refs of origins text | merge-sha | inline (new ones
 * 'pending'), and leave detail_for, reviews_at, the 'files-truncated' flag and pr-files refs untouched.
 * @param {import('node:sqlite').DatabaseSync} db @param {PageEntry[]} entries
 * @returns {{ inserted: number, updated: number, skipped: number }}
 */
export function upsertPage(_db, _entries) { throw new NotImplementedError('gh-sync.upsertPage'); }

/**
 * Production ingestion path for raw GitHub objects of one kind (used by sync and by eval preparation to add a
 * synthetic item exactly the way real ones are stored): normalize fields -> sanitize -> extractRefs -> upsertPage.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {'pr'|'issue'|'review'|'review_comment'|'issue_comment'} kind
 * @param {object[]} raws raw REST objects (reviews need { ...review, pull_number })
 * @param {{ selfRepo: string, deps?: Partial<SyncDeps> }} opts
 */
export function ingestRaw(_db, _kind, _raws, _opts) { throw new NotImplementedError('gh-sync.ingestRaw'); }

/** origin URL -> { owner, repo } for github.com (https, ssh, git@), else null. */
export function parseRemote(url) {
  const m = /github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(url ?? '').trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}
