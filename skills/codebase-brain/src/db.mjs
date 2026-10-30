// brain.db: one SQLite file per repo@commit. Code facts and team knowledge share it,
// so `why` can walk doc -> code -> commit without a second index of the code.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, existsSync, rmSync } from 'node:fs';

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);

-- files and symbols. key = "path" for files, "path#Name" / "path#Class.member" for symbols
CREATE TABLE nodes (
  id INTEGER PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL,          -- file | function | class | method | interface | type | enum | variable | namespace | package
  name TEXT NOT NULL,
  path TEXT,
  line INTEGER,
  end_line INTEGER,
  parent INTEGER,              -- class for methods, file for top-level symbols
  exported INTEGER DEFAULT 0,
  lang TEXT,
  flags TEXT DEFAULT ''        -- file roles: test, page, route, layout, server-action, client, generated, script
);
CREATE INDEX nodes_name ON nodes(name);
CREATE INDEX nodes_path ON nodes(path);

-- typed edges. file->file: imports | imports-type | reexports | dynamic-import | includes
-- symbol->symbol (src = enclosing symbol or file): call | new | renders | extends | implements | type | ref | import | export
CREATE TABLE edges (
  src INTEGER NOT NULL,
  dst INTEGER NOT NULL,
  kind TEXT NOT NULL,
  path TEXT,                   -- site file
  line INTEGER,
  col INTEGER
);
CREATE INDEX edges_dst ON edges(dst, kind);
CREATE INDEX edges_src ON edges(src, kind);

-- imports the indexer could not resolve to a file. Local-looking ones lower coverage.
CREATE TABLE unresolved (path TEXT, line INTEGER, spec TEXT, local INTEGER);

-- team knowledge: doc sections, changes/ fragments, CHANGELOG entries, commits, vault notes
CREATE TABLE chunks (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,        -- doc | change | changelog | commit | vault
  path TEXT,                   -- file path (doc/vault) or null (commit)
  start_line INTEGER,
  end_line INTEGER,
  title TEXT,
  body TEXT,
  sha TEXT,
  date TEXT,
  prs TEXT                     -- "#12 #34"
);
CREATE VIRTUAL TABLE chunks_fts USING fts5(title, body, content='chunks', content_rowid='id',
  tokenize = "porter unicode61 tokenchars '_'");
-- trigram twin for Korean and partial identifiers ("크레딧", "LiveRun"): substring match, no word boundaries needed
CREATE VIRTUAL TABLE chunks_tri USING fts5(title, body, content='chunks', content_rowid='id', tokenize = 'trigram');

-- knowledge -> code links: mentions-path | mentions-symbol (doc text) | touches (commit diff)
CREATE TABLE links (chunk INTEGER NOT NULL, node INTEGER NOT NULL, kind TEXT NOT NULL, evidence TEXT);
CREATE INDEX links_node ON links(node);
CREATE INDEX links_chunk ON links(chunk);
`;

export function defaultDbPath(repo) {
  const h = createHash('sha1').update(repo).digest('hex').slice(0, 12);
  return join(homedir(), '.cache', 'codebase-brain', `${h}.db`);
}

export function createDb(path) {
  mkdirSync(join(path, '..'), { recursive: true });
  for (const p of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(p)) rmSync(p);
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;');
  db.exec(SCHEMA);
  return db;
}

export function openDb(path) {
  if (!existsSync(path)) throw new Error(`no index at ${path} — run: brain build <repo>`);
  return new DatabaseSync(path, { readOnly: true });
}

export function getMeta(db) {
  const meta = {};
  for (const { key, value } of db.prepare('SELECT key, value FROM meta').all()) meta[key] = JSON.parse(value);
  return meta;
}

export function setMeta(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
}

// Batched writes keep a 5,000-file build inside one transaction.
export function inTransaction(db, fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
