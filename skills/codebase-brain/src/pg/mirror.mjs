// mirror (Q4, design §6.4, §6.7, R3): run R of the server as local SQLite files in the Phase 0 / Phase 1 shapes, so
// the map commands run unchanged on code.db and CI runs Phase 1 sync on github.db. Lane A owns this file.
// - Files: <dir>/brain.db (code shape) and <dir>/brain.github.db (github shape, githubDbPath of it). The tables come from
//   the Phase 0 / Phase 1 schema code itself (db.mjs createDb, gh-schema.mjs openGithubDb), never a copy of the DDL.
// - Ids (contract.COLUMN_MAP): nodes.id = node_id, chunks.id = chunk_id, github items.id = item_id, edges / unresolved /
//   links / refs rowid = the server row id. nodes.key = node_rev.p0_key. meta = run.meta + contract.MIRROR_META_KEYS
//   from the run row (brain_run, brain_run_commit, brain_published_at, brain_checksum); of the dropped keys only `repo`
//   is written, from opts.repo (the local checkout); `worktree` stays absent (= no uncommitted edits, Phase 0 freshness).
// - Full pull: every row visible at R. Delta pull A -> R: rows visible at R and not at A are put, rows visible at A and
//   not at R are deleted; a row that opened and closed inside (A, R] is never sent. Deletes first (with the chunks /
//   refs of a closed revision), then puts (same id: replace). A ref row is the ref joined with its visible ref_link, so a
//   ref whose ref_link changed is rewritten too. github items also take the collection ledger and refs their
//   resolved_build from sync_state[R].
// - FTS (chunks_fts, chunks_tri, items_fts, items_tri) is rebuilt locally: all of it after a full pull, the changed rows
//   after a delta.
// - Every pull is built in a temporary copy next to the mirror (mode 0600) and checked: snapshot(copy) must give
//   run[R].checksum for the pulled shapes. A delta that fails the check is dropped and the full run is pulled; a full
//   pull that fails it throws (code 'mirror-checksum') and leaves the old mirror as it was. The read-only transaction
//   ends before anything is replaced, so a lost connection never leaves a half-done swap behind a rejected call.
// - The swap renames github.db first and brain.db last. brain.db alone (the laptop shape) is always one whole run. The
//   pair is two renames, not one step: a pull killed between them leaves github.db at R next to brain.db at A. The only
//   reader of github.db is CI, through this function, and a github-shaped pull checks the pair against the run's
//   checksum before it uses it — the old pair against run[A] before a delta, and the pair at R when brain.db already
//   names R — so a mixed pair, or one written in place (a sync on the file itself), is pulled again in full. A
//   code-shaped pull trusts brain.db's run: only this function writes it, after the check.
// - All reads of one pull are one REPEATABLE READ snapshot. bytes: what the server sent after the connection opened.
// - Errors never carry the URL or its password.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, copyFileSync, renameSync, rmSync, chmodSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import * as C from './contract.mjs';
import { snapshot } from './snapshot.mjs';
import { createDb, setMeta } from '../db.mjs';
import { openGithubDb, githubDbPath } from '../gh-schema.mjs';
import { BrainError } from '../errors.mjs';

export const MIRROR_DB = 'brain.db';
const ANY_MANIFEST = { map: 'full', docs: 'full', commits: 'append', github: 'full' };   // snapshot needs one; the state does not depend on it
const SYNC_COLUMNS = ['id', 'repo_id', 'repo', 'cursor', 'last_ok_at', 'last_full_at', 'run_status', 'run_pid', 'run_started_at',
  'last_error', 'limits', 'sanitize_version', 'schema_version'];
const fail = (code, msg) => { throw new BrainError(code, msg); };

// visibility at run $n (design §6.1); put / del: the delta A -> R ($1 = R, $2 = A)
const vis = (t, n = '$1') => `(${t}.valid_from <= ${n} AND (${t}.valid_to IS NULL OR ${t}.valid_to > ${n}))`;
const put = (t) => `(${vis(t)} AND NOT ${vis(t, '$2')})`;
const del = (t) => `(${vis(t, '$2')} AND NOT ${vis(t)})`;

const Q = {
  nodes: (w) => `SELECT n.node_id AS id, r.p0_key AS key, r.kind, r.name, n.path, r.line, r.end_line, r.parent_id AS parent,
    r.exported, r.lang, r.flags FROM brain.node_rev r JOIN brain.node n USING (node_id) WHERE ${w('r')}`,
  edges: (w) => `SELECT e.edge_id AS id, e.src_id AS src, e.dst_id AS dst, e.kind, s.path, e.line, e.col
    FROM brain.edge e LEFT JOIN brain.node s ON s.node_id = e.site_file_id WHERE ${w('e')}`,
  unresolved: (w) => `SELECT u.unresolved_id AS id, u.path, u.line, u.spec, u.local FROM brain.unresolved u WHERE ${w('u')}`,
  chunks: (w) => `SELECT c.chunk_id AS id, i.kind AS source, i.ptr, c.start_line, c.end_line, c.title, c.body, c.sha, c.date, c.prs,
    c.body_line FROM brain.item_rev r JOIN brain.item i USING (item_id) JOIN brain.chunk c USING (rev_id)
    WHERE i.origin = 'repo' AND ${w('r')}`,
  links: (w) => `SELECT l.link_id AS id, l.chunk_id AS chunk, l.node_id AS node, l.kind, l.evidence FROM brain.link l WHERE ${w('l')}`,
  items: (w) => `SELECT i.item_id AS id, i.ptr, i.kind, r.title, r.body, r.state, r.author, r.source_updated_at AS updated_at, r.meta
    FROM brain.item_rev r JOIN brain.item i USING (item_id) WHERE i.origin = 'github' AND ${w('r')}`,
  // a ref with its ref_link visible at R; extra narrows it (delta: refs whose revision or ref_link changed)
  refs: (extra = 'true') => `SELECT f.ref_id AS id, i.ptr, f.kind, f.target, f.origin, l.status, l.reason, l.resolved_raw AS resolved,
    count(*) OVER (PARTITION BY f.ref_id) AS links
    FROM brain.ref f JOIN brain.item_rev r USING (rev_id) JOIN brain.item i USING (item_id)
    LEFT JOIN brain.ref_link l ON l.ref_id = f.ref_id AND ${vis('l')}
    WHERE ${vis('r')} AND (${extra})`,
};
// ids that leave the mirror in a delta
const GONE = {
  nodes: `SELECT r.node_id AS id FROM brain.node_rev r WHERE ${del('r')}`,
  edges: `SELECT e.edge_id AS id FROM brain.edge e WHERE ${del('e')}`,
  unresolved: `SELECT u.unresolved_id AS id FROM brain.unresolved u WHERE ${del('u')}`,
  chunks: `SELECT c.chunk_id AS id FROM brain.item_rev r JOIN brain.item i USING (item_id) JOIN brain.chunk c USING (rev_id)
    WHERE i.origin = 'repo' AND ${del('r')}`,
  links: `SELECT l.link_id AS id FROM brain.link l WHERE ${del('l')}`,
  items: `SELECT r.item_id AS id FROM brain.item_rev r JOIN brain.item i USING (item_id) WHERE i.origin = 'github' AND ${del('r')}`,
  refs: `SELECT f.ref_id AS id FROM brain.ref f JOIN brain.item_rev r USING (rev_id) WHERE ${del('r')}
    UNION SELECT l.ref_id FROM brain.ref_link l WHERE ${del('l')} OR ${put('l')}`,
};
const REFS_CHANGED = `NOT ${vis('r', '$2')} OR EXISTS (SELECT 1 FROM brain.ref_link x WHERE x.ref_id = f.ref_id AND (${put('x')} OR ${del('x')}))`;

/**
 * @param {{ url: string, dir: string, run?: number|null, shapes: ('code'|'github')[], repo?: string|null, log?: (s: string) => void }} opts
 *   url: reader URL (laptops) or writer URL (CI); run: null = latest; shapes: laptops ['code'], CI ['code', 'github'];
 *   repo: the local checkout written as meta.repo (Phase 0 freshness and viz read it)
 * @returns {Promise<{ codeDb: string, githubDb: string|null, run: number, bytes: number }>} bytes received;
 *   githubDb is null when the github shape was not asked for or the run has no GitHub state
 */
export async function pullMirror({ url, dir, run = null, shapes, repo = null, log = () => {} }) {
  if (typeof url !== 'string' || !url) fail('usage', 'pullMirror needs a reader or writer URL');
  if (typeof dir !== 'string' || !dir) fail('usage', 'pullMirror needs a mirror directory');
  if (!Array.isArray(shapes) || !shapes.includes('code') || shapes.some((s) => !(s in C.CHECKSUM_SHAPES))) {
    fail('usage', "shapes must be ['code'] or ['code', 'github']");
  }
  if (run !== null && !(Number.isInteger(run) && run > 0)) fail('usage', `bad run ${run}`);
  const wantGh = shapes.includes('github');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const codeDb = join(dir, MIRROR_DB), ghDb = githubDbPath(codeDb);
  sweepLeftovers(dir);

  const secrets = [url, safePassword(url)].filter((x) => x && x.length >= 4).sort((a, b) => b.length - a.length);
  const scrub = (e) => {
    let msg = String(e?.message ?? e);
    for (const x of secrets) msg = msg.split(x).join('<redacted>');
    return new BrainError(e instanceof BrainError ? e.code : 'mirror', msg, { sqlstate: e instanceof BrainError ? undefined : e?.code });
  };
  let client = null, built = null, bytes = 0;
  try {
    client = new pg.Client({ connectionString: url });
    client.on('error', () => {});
    await client.connect();
    client.connection.stream.on('data', (b) => { bytes += b.length; });
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '5min'");        // a full pull is larger than one search statement
    const target = await runRow(client, run);
    const sync = wantGh ? (await client.query("SELECT state FROM brain.sync_state WHERE run_id = $1 AND source = 'github'", [target.run_id])).rows[0]?.state ?? null : null;
    const R = Number(target.run_id), ctx = { client, R, target, sync, wantGh, repo, dir, codeDb, ghDb, shapes };
    let have = localRun(codeDb, ghDb, wantGh && sync !== null), how = null;
    if (have === R && wantGh && sync !== null) {
      const bad = matches(codeDb, ghDb, shapes, target.checksum);
      if (bad.length) { log(`mirror at run ${R} is not that run (${bad.join(', ')}); pulling the full run`); have = null; }
    }
    if (have === R) log(`mirror already at run ${R}`);
    else {
      if (have !== null && have < R) {
        try { built = await build(ctx, have); how = `mirror run ${have} -> ${R} (delta)`; }
        catch (e) { if (e.code !== 'mirror-checksum') throw e; log(`mirror delta ${have} -> ${R}: ${e.message}; pulling the full run`); }
      }
      if (!built) { built = await build(ctx, null); how = `mirror run ${R} (full)`; }
    }
    await client.query('COMMIT');                                       // every read is done: only local renames follow
    if (built) { install(built, ctx); log(how); }
    return { codeDb, githubDb: wantGh && sync !== null ? ghDb : null, run: R, bytes };
  } catch (e) {
    throw scrub(e);
  } finally {
    if (built) discard(built);
    await client?.end().catch(() => {});
  }
}

function safePassword(url) { try { return decodeURIComponent(new URL(url).password); } catch { return null; } }

async function runRow(client, run) {
  const r = (await client.query(`SELECT run_id, commit_sha, published_at, meta, checksum FROM brain.run
    WHERE run_id = coalesce($1::bigint, (SELECT max(run_id) FROM brain.run))`, [run])).rows[0];
  return r ?? fail('not-found', run === null ? 'the server has no published run yet' : `no run ${run} on the server`);
}

/** the run the local mirror holds, or null when there is none (or the github file the pull needs is missing) */
function localRun(codeDb, ghDb, needGh) {
  if (!existsSync(codeDb) || (needGh && !existsSync(ghDb))) return null;
  try {
    const db = new DatabaseSync(codeDb, { readOnly: true });
    try { const r = db.prepare("SELECT value FROM meta WHERE key = 'brain_run'").get(); return r ? Number(JSON.parse(r.value)) : null; }
    finally { db.close(); }
  } catch { return null; }
}

/** temporary files of pulls whose process is gone (a pull killed mid-way, V18) */
function sweepLeftovers(dir) {
  for (const f of readdirSync(dir)) {
    const m = /^\.pull-(\d+)-[0-9a-f]+\./.exec(f);
    if (!m) continue;
    try { process.kill(Number(m[1]), 0); continue; } catch (e) { if (e.code === 'EPERM') continue; }
    rmSync(join(dir, f), { force: true });
  }
}

/** the checksum entries of the shapes, from a run row and from a mirror pair */
const wanted = (sum, shapes) => Object.fromEntries(shapes.flatMap((s) => C.CHECKSUM_SHAPES[s]).map((t) => [t, sum?.[t] ?? null]));
function matches(codeDb, ghDb, shapes, expected) {
  let state;
  try { state = snapshot({ codeDb, githubDb: ghDb, manifest: ANY_MANIFEST }); }
  catch (e) { return [`unreadable: ${e.message}`]; }                         // a broken mirror is a mismatch, not a crash
  const got = C.checksum(state, shapes), want = wanted(expected, shapes);
  return Object.keys(want).filter((t) => C.canonicalJson(got[t]) !== C.canonicalJson(want[t]));
}

/**
 * Build run R in temporary files (from = null: full; from = A: the mirror at A plus the delta) and check them.
 * @returns {Promise<{ tmpCode: string, tmpGh: string, gh: boolean }>} checked files for install(); nothing is left on a throw
 */
async function build(ctx, from) {
  const { client, R, dir, codeDb, ghDb, wantGh, sync, shapes } = ctx;
  const gh = wantGh && sync !== null;
  const tag = `.pull-${process.pid}-${randomBytes(4).toString('hex')}`;
  const out = { tmpCode: join(dir, `${tag}.db`), tmpGh: githubDbPath(join(dir, `${tag}.db`)), gh };
  let code = null, ghdb = null, ok = false;
  try {
    if (from !== null && gh) {
      const prev = (await client.query('SELECT checksum FROM brain.run WHERE run_id = $1', [from])).rows[0];
      const bad = prev ? matches(codeDb, ghDb, shapes, prev.checksum) : ['run'];
      if (bad.length) fail('mirror-checksum', `the mirror at run ${from} is not that run (${bad.join(', ')})`);
    }
    if (from === null) {
      code = createDb(out.tmpCode);                                                  // Phase 0 tables, mode 0600
      if (gh) ghdb = openGithubDb(out.tmpGh, { create: true });                     // Phase 1 tables, mode 0600
    } else {
      copyFileSync(codeDb, out.tmpCode); chmodSync(out.tmpCode, 0o600);
      code = new DatabaseSync(out.tmpCode);
      code.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA secure_delete = ON;');   // as createDb
      if (gh) { copyFileSync(ghDb, out.tmpGh); chmodSync(out.tmpGh, 0o600); ghdb = openGithubDb(out.tmpGh); }
    }
    try {
      await writeCode(ctx, code, from);
      if (ghdb) await writeGithub(ctx, ghdb, from);
    } catch (e) {
      // the old mirror does not take the delta (a row it should not have, a missing table): pull the full run instead
      if (from !== null && e.code === 'ERR_SQLITE_ERROR') fail('mirror-checksum', `the delta does not apply to the mirror at run ${from}`);
      throw e;
    }
    if (from === null) code.exec('ANALYZE');
    code.close(); code = null;
    ghdb?.close(); ghdb = null;

    const bad = matches(out.tmpCode, gh ? out.tmpGh : null, shapes, ctx.target.checksum);
    if (bad.length) fail('mirror-checksum', `run ${R} checksum differs (${bad.join(', ')})`);
    ok = true;
    return out;
  } finally {
    try { code?.close(); } catch { /* closed */ }
    try { ghdb?.close(); } catch { /* closed */ }
    if (!ok) discard(out);
  }
}

/** Replace the mirror with checked files: github.db first, brain.db (its meta names the run) last. */
function install({ tmpCode, tmpGh, gh }, { codeDb, ghDb }) {
  // sidecars of the files being replaced: SQLite would apply a stale journal to the new file on its next open
  for (const final of [codeDb, ghDb]) for (const s of ['-journal', '-wal', '-shm']) rmSync(final + s, { force: true });
  if (gh) renameSync(tmpGh, ghDb); else rmSync(ghDb, { force: true });           // a github file of another run must not stay
  renameSync(tmpCode, codeDb);
}

function discard({ tmpCode, tmpGh }) {
  for (const f of [tmpCode, tmpGh]) for (const s of ['', '-journal', '-wal', '-shm']) rmSync(f + s, { force: true });
}

const rows = async (client, sql, params) => (await client.query(sql, params)).rows;
const ids = async (client, sql, params) => (await rows(client, sql, params)).map((r) => Number(r.id));
const num = (v) => (v === null || v === undefined ? null : Number(v));

async function writeCode({ client, R, target, repo }, db, from) {
  const p = from === null ? [R] : [R, from];
  const w = from === null ? (t) => vis(t) : put;
  const got = {};
  for (const t of ['nodes', 'edges', 'unresolved', 'chunks', 'links']) got[t] = await rows(client, Q[t](w), p);   // one at a time: one connection
  const { nodes, edges, unresolved, chunks, links } = got;
  let gone = null;
  if (from !== null) {
    gone = {};
    for (const t of ['nodes', 'edges', 'unresolved', 'chunks', 'links']) gone[t] = await ids(client, GONE[t], p);
  }

  db.exec('BEGIN');
  try {
    if (gone) {
      const delRow = (table, col) => { const s = db.prepare(`DELETE FROM ${table} WHERE ${col} = ?`); return (id) => s.run(id); };
      gone.links.forEach(delRow('links', 'rowid'));
      gone.edges.forEach(delRow('edges', 'rowid'));
      gone.unresolved.forEach(delRow('unresolved', 'rowid'));
      gone.nodes.forEach(delRow('nodes', 'id'));
      dropChunks(db, [...gone.chunks, ...chunks.map((c) => Number(c.id))]);       // put ids too: replace means delete + insert
    }
    const insNode = db.prepare(`INSERT OR REPLACE INTO nodes (id, key, kind, name, path, line, end_line, parent, exported, lang, flags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const n of nodes) insNode.run(Number(n.id), n.key, n.kind, n.name, n.path, n.line, n.end_line, num(n.parent), n.exported ? 1 : 0, n.lang, n.flags);
    const insEdge = db.prepare('INSERT OR REPLACE INTO edges (rowid, src, dst, kind, path, line, col) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const e of edges) insEdge.run(Number(e.id), Number(e.src), Number(e.dst), e.kind, e.path, e.line, e.col);
    const insUnres = db.prepare('INSERT OR REPLACE INTO unresolved (rowid, path, line, spec, local) VALUES (?, ?, ?, ?, ?)');
    for (const u of unresolved) insUnres.run(Number(u.id), u.path, u.line, u.spec, u.local);
    const insChunk = db.prepare(`INSERT INTO chunks (id, source, path, start_line, end_line, title, body, sha, date, prs, body_line)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const fts = ['chunks_fts', 'chunks_tri'].map((t) => db.prepare(`INSERT INTO ${t} (rowid, title, body) VALUES (?, ?, ?)`));
    for (const c of chunks) {
      const id = Number(c.id), path = c.source === 'commit' ? null : c.ptr.slice(c.source.length + 1);
      insChunk.run(id, c.source, path, c.start_line, c.end_line, c.title, c.body, c.sha, c.date, c.prs, c.body_line);
      for (const s of fts) s.run(id, c.title, c.body);                             // as index-knowledge: the stored values
    }
    const insLink = db.prepare('INSERT OR REPLACE INTO links (rowid, chunk, node, kind, evidence) VALUES (?, ?, ?, ?, ?)');
    for (const l of links) insLink.run(Number(l.id), Number(l.chunk), Number(l.node), l.kind, l.evidence);

    db.exec('DELETE FROM meta');
    for (const [k, v] of Object.entries(target.meta)) setMeta(db, k, v);
    setMeta(db, 'brain_run', R);
    setMeta(db, 'brain_run_commit', target.commit_sha);
    setMeta(db, 'brain_published_at', new Date(target.published_at).toISOString());
    setMeta(db, 'brain_checksum', target.checksum);
    if (repo) setMeta(db, 'repo', resolve(repo));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/** delete chunk rows and their external-content FTS entries (FTS5 needs the old values to delete them) */
function dropChunks(db, chunkIds) {
  const old = db.prepare('SELECT title, body FROM chunks WHERE id = ?');
  const fts = ['chunks_fts', 'chunks_tri'].map((t) => db.prepare(`INSERT INTO ${t} (${t}, rowid, title, body) VALUES ('delete', ?, ?, ?)`));
  const delChunk = db.prepare('DELETE FROM chunks WHERE id = ?');
  for (const id of chunkIds) {
    const o = old.get(id);
    if (!o) continue;
    for (const s of fts) s.run(id, o.title, o.body);
    delChunk.run(id);
  }
}

async function writeGithub({ client, R, sync }, db, from) {
  const p = from === null ? [R] : [R, from];
  const items = await rows(client, Q.items(from === null ? (t) => vis(t) : put), p);
  const refs = await rows(client, Q.refs(from === null ? 'true' : REFS_CHANGED), p);
  const gone = from === null ? null : { items: await ids(client, GONE.items, p), refs: await ids(client, GONE.refs, p) };
  for (const r of refs) {
    if (Number(r.links) !== 1 || r.status === null) fail('mirror-state', `run ${R}: ref ${r.id} of ${r.ptr} has ${r.status === null ? 0 : r.links} visible ref_link rows`);
  }
  const ledger = sync.items ?? {}, other = sync.refs?.other ?? {}, build = sync.refs?.build ?? null;

  db.exec('BEGIN');
  try {
    const ftsDel = ['items_fts', 'items_tri'].map((t) => db.prepare(`DELETE FROM ${t} WHERE rowid = ?`));
    const ftsIns = ['items_fts', 'items_tri'].map((t) => db.prepare(`INSERT INTO ${t} (rowid, title, body) VALUES (?, ?, ?)`));
    if (gone) {
      const delItem = db.prepare('DELETE FROM items WHERE id = ?'), delRef = db.prepare('DELETE FROM refs WHERE rowid = ?');
      for (const id of [...gone.items, ...items.map((i) => Number(i.id))]) { delItem.run(id); for (const s of ftsDel) s.run(id); }
      for (const id of [...gone.refs, ...refs.map((r) => Number(r.id))]) delRef.run(id);
    }
    const cols = ['id', 'ptr', 'kind', 'title', 'body', 'state', 'author', 'updated_at', ...C.ITEM_META_COLUMNS, ...C.LEDGER_COLUMNS];
    const insItem = db.prepare(`INSERT INTO items (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
    for (const i of items) {
      const id = Number(i.id), meta = i.meta ?? {}, led = ledger[i.ptr] ?? {};
      insItem.run(id, i.ptr, i.kind, i.title, i.body, i.state, i.author, i.updated_at,
        ...C.ITEM_META_COLUMNS.map((c) => meta[c] ?? null), ...C.LEDGER_COLUMNS.map((c) => led[c] ?? null));
      for (const s of ftsIns) s.run(id, i.title ?? '', i.body ?? '');               // as gh-sync upsertPage
    }
    const insRef = db.prepare('INSERT INTO refs (rowid, ptr, kind, target, origin, status, reason, resolved, resolved_build) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const r of refs) insRef.run(Number(r.id), r.ptr, r.kind, r.target, r.origin, r.status, r.reason, r.resolved, null);

    // ledger and stamps come whole with every run: rewrite them for every row
    db.exec('UPDATE items SET detail_for = NULL, reviews_at = NULL');
    const setLed = db.prepare('UPDATE items SET detail_for = ?, reviews_at = ? WHERE ptr = ?');
    for (const [ptr, l] of Object.entries(ledger)) setLed.run(l.detail_for ?? null, l.reviews_at ?? null, ptr);
    db.prepare('UPDATE refs SET resolved_build = ?').run(build);
    const setBuild = db.prepare('UPDATE refs SET resolved_build = ? WHERE ptr = ? AND kind = ? AND target = ? AND origin = ?');
    for (const [k, v] of Object.entries(other)) { const [ptr, kind, target, origin] = JSON.parse(k); setBuild.run(v, ptr, kind, target, origin); }

    const row = sync.row ?? {};
    const keys = Object.keys(row);
    const unknown = keys.filter((k) => !SYNC_COLUMNS.includes(k));
    if (unknown.length) fail('mirror-state', `run ${R}: sync_state has unknown columns ${unknown.join(', ')}`);
    db.exec('DELETE FROM sync_state');
    db.prepare(`INSERT INTO sync_state (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => row[k]));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
