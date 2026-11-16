// github.db: GitHub memory (P0 contract, implemented here). It lives next to code.db and outlives builds.
// Writers: brain sync (gh-sync.mjs) and relink (link.mjs), always inside withWriteLock().
// Readers: search / get / source open it with openGithubDb(path, { readOnly: true }).
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, chmodSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { BrainError, LockBusyError } from './errors.mjs';

export const GH_SCHEMA_VERSION = 1;

// Column ownership (who may write what), so one writer never erases another's work:
//   item upsert (sync, one page per transaction): every items column except detail_for, reviews_at and the
//     'files-truncated' flag; FTS rows; refs with origin text | merge-sha | inline (replaced per item)
//   files fetch (sync): refs with origin pr-files, items.detail_for, the 'files-truncated' flag (one transaction)
//   reviews fetch (sync): review rows (upsert) and the PR's items.reviews_at
//   relink (link.mjs): refs.status | reason | resolved | resolved_build only
//   final run transaction (sync): sync_state.cursor | last_ok_at | run_status ...
export const GH_SCHEMA = `
CREATE TABLE IF NOT EXISTS sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  repo_id INTEGER,              -- GitHub numeric repo id this file is bound to
  repo TEXT,                    -- owner/name, display only
  cursor TEXT,                  -- server time T (Date header) of the last fully successful run
  last_ok_at TEXT,              -- when that run finished (local clock, ISO)
  last_full_at TEXT,            -- last successful --full
  run_status TEXT,              -- running | ok | failed | interrupted
  run_pid INTEGER,
  run_started_at TEXT,
  last_error TEXT,              -- short, sanitized, no token
  limits TEXT,                  -- JSON: {"filesTruncated": n}
  sanitize_version INTEGER,     -- SANITIZE_VERSION every stored string went through
  schema_version INTEGER
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,       -- stable rowid; FTS rows use it
  ptr TEXT UNIQUE NOT NULL,     -- pr:123 issue:45 review:9 rc:7 ic:8 (ptr.mjs)
  kind TEXT NOT NULL,           -- pr | issue | review | review_comment | issue_comment
  number INTEGER,               -- PR / issue number (pr, issue)
  parent_number INTEGER,        -- the PR or issue a review / comment belongs to
  review_id INTEGER,            -- review comment: its review
  in_reply_to INTEGER,          -- review comment reply: the comment it answers
  state TEXT,                   -- pr: open | merged | closed_unmerged · issue: open | closed · review: APPROVED ...
  draft INTEGER DEFAULT 0,
  author TEXT, author_assoc TEXT,
  title TEXT, body TEXT,        -- sanitized
  url TEXT,
  created_at TEXT, updated_at TEXT, submitted_at TEXT, closed_at TEXT, merged_at TEXT,
  merge_sha TEXT, base TEXT, head TEXT,
  detail_for TEXT,              -- the PR updated_at when its files were fetched
  reviews_at TEXT,              -- when this PR's reviews were last fetched
  path TEXT, side TEXT, start_side TEXT, start_line INTEGER, line INTEGER,
  original_start_line INTEGER, original_line INTEGER, commit_id TEXT, original_commit_id TEXT,
  redactions INTEGER DEFAULT 0,
  flags TEXT DEFAULT ''         -- space-separated: suspicious files-truncated
);
CREATE INDEX IF NOT EXISTS items_parent ON items(parent_number);
CREATE INDEX IF NOT EXISTS items_review ON items(review_id);
CREATE INDEX IF NOT EXISTS items_state_kind ON items(state, kind);
CREATE INDEX IF NOT EXISTS items_updated ON items(updated_at);
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(title, body, tokenize = "porter unicode61 tokenchars '_'");
CREATE VIRTUAL TABLE IF NOT EXISTS items_tri USING fts5(title, body, tokenize = 'trigram');
CREATE TABLE IF NOT EXISTS refs (
  ptr TEXT NOT NULL,            -- the item that makes the reference
  kind TEXT NOT NULL,           -- file | dir | symbol | commit | item | route | name
  target TEXT NOT NULL,         -- string key: path, Name, sha, pr:12 / owner/repo#12, /api/run, jobs.reserve
  origin TEXT NOT NULL,         -- pr-files | merge-sha | inline | text
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | linked | ambiguous | unlinked
  reason TEXT,                  -- not-in-index | no-match | too-many | budget | external-repo | not-local | not-synced | redacted
  resolved TEXT,                -- JSON array (max 10) of "path", "path:line", "path#Name" or a pointer
  resolved_build TEXT,          -- code.db build_id the status was computed against
  UNIQUE (ptr, kind, target, origin)
);
CREATE INDEX IF NOT EXISTS refs_target ON refs(target);
CREATE INDEX IF NOT EXISTS refs_ptr ON refs(ptr);
CREATE INDEX IF NOT EXISTS refs_status ON refs(status);
INSERT OR IGNORE INTO sync_state(id, schema_version) VALUES (1, ${GH_SCHEMA_VERSION});
`;

/** code DB path -> the github DB next to it: brain.db -> brain.github.db, <hash>.db -> <hash>.github.db */
export function githubDbPath(codeDbPath) {
  return codeDbPath.replace(/\.db$/, '') + '.github.db';
}

/**
 * Open github.db. Rollback journal (DELETE) + synchronous=FULL: crash-safe commits, and read-only copies
 * (eval workspaces) open without -wal / -shm files. secure_delete zeroes overwritten bytes.
 * @param {string} path
 * @param {{ create?: boolean, readOnly?: boolean }} [opts]
 * @returns {DatabaseSync | null} null when the file does not exist and create is false
 */
export function openGithubDb(path, { create = false, readOnly = false } = {}) {
  const exists = existsSync(path);
  if (!exists && !create) return null;
  if (readOnly) return new DatabaseSync(path, { readOnly: true });
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  if (!exists) chmodSync(path, 0o600);
  db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON; PRAGMA foreign_keys = OFF;');
  db.exec(GH_SCHEMA);
  return db;
}

/** @returns {Record<string, any>} the one sync_state row (limits parsed) */
export function readSyncState(db) {
  const r = db.prepare('SELECT * FROM sync_state WHERE id = 1').get() || {};
  return { ...r, limits: r.limits ? JSON.parse(r.limits) : {} };
}

/** @param {Record<string, any>} patch columns to set (limits as an object) */
export function writeSyncState(db, patch) {
  const cols = Object.keys(patch);
  if (!cols.length) return;
  const vals = cols.map((k) => (k === 'limits' && patch[k] && typeof patch[k] === 'object' ? JSON.stringify(patch[k]) : patch[k] ?? null));
  db.prepare(`UPDATE sync_state SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = 1`).run(...vals);
}

/**
 * One async write lifecycle per repo: build, sync, relink, --full swap all run inside it.
 * The lock is an SQLite file `<codeDbPath>.lock` held with BEGIN EXCLUSIVE in locking_mode=EXCLUSIVE: the OS releases
 * it when the holder exits or is killed, so there is no stale lock to detect or delete (and no remover race).
 * - held by another process, or already by this one (nested writes are a bug) -> LockBusyError
 * - staleLock: true when the previous holder never released it cleanly (it crashed); the caller decides what that
 *   means (sync marks the previous run interrupted)
 * `<lock>.pid` holds the current holder's pid for messages only; correctness never depends on it.
 * @template T
 * @param {string} codeDbPath
 * @param {(info: { staleLock: boolean }) => Promise<T> | T} fn
 * @returns {Promise<{ value: T, staleLock: boolean }>}
 * @throws {LockBusyError}
 */
export async function withWriteLock(codeDbPath, fn) {
  const lock = `${codeDbPath}.lock`;
  if (heldHere.has(lock)) throw new LockBusyError(process.pid);
  mkdirSync(dirname(lock), { recursive: true });
  const db = new DatabaseSync(lock);
  let staleLock;
  try {
    chmodSync(lock, 0o600);
    db.exec('PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE;');
    try { db.exec('BEGIN EXCLUSIVE'); }
    catch (e) {
      if (e.errcode === 5 || e.errcode === 6) throw new LockBusyError(holderPid(lock));
      // a file that is not an SQLite lock is never removed automatically (that would bring back a check-then-delete race)
      if (e.errcode === 26) throw new BrainError('lock-unreadable', `${lock} is not a brain lock file: delete it if no brain build or sync is running`);
      throw e;
    }
    db.exec('CREATE TABLE IF NOT EXISTS holder (id INTEGER PRIMARY KEY CHECK (id = 1), pid INTEGER, started_at TEXT, clean INTEGER)');
    const prev = db.prepare('SELECT clean FROM holder WHERE id = 1').get();
    staleLock = !!prev && !prev.clean;
    db.prepare('INSERT OR REPLACE INTO holder (id, pid, started_at, clean) VALUES (1, ?, ?, 0)').run(process.pid, new Date().toISOString());
    db.exec('COMMIT');                                           // exclusive locking mode: the lock stays held
    writeFileSync(`${lock}.pid`, String(process.pid), { mode: 0o600 });
  } catch (e) { db.close(); throw e; }
  heldHere.add(lock);
  try { return { value: await fn({ staleLock }), staleLock }; }
  finally {
    heldHere.delete(lock);
    try { db.exec('UPDATE holder SET clean = 1 WHERE id = 1'); } catch { /* the next holder then sees staleLock: true */ }
    db.close();
    try { rmSync(`${lock}.pid`, { force: true }); } catch { /* diagnostic file only */ }
  }
}

const heldHere = new Set();
const holderPid = (lock) => { try { return Number(readFileSync(`${lock}.pid`, 'utf8')) || 0; } catch { return 0; } };
