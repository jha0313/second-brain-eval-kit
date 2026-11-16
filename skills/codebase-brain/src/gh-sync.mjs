// brain sync: incremental GitHub collection into github.db. Lane G owns this file.
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
import { renameSync, rmSync } from 'node:fs';
import { BrainError, GhError, GuardError, LockBusyError } from './errors.mjs';
import { githubDbPath, openGithubDb, readSyncState, writeSyncState, withWriteLock } from './gh-schema.mjs';
import { itemPtr } from './ptr.mjs';
import { failpoint } from './seams.mjs';
import { SANITIZE_VERSION, sanitize, sanitizeLine, redactValues } from './sanitize.mjs';
import { extractRefs, fileRefs, relink } from './link.mjs';

/**
 * A sanitized items row ready to store (column names as in gh-schema.mjs items). ptr and kind are required.
 * @typedef {Record<string, any> & { ptr: string, kind: string }} ItemRow
 * @typedef {{ item: ItemRow, refs: import('./link.mjs').RawRef[] }} PageEntry   refs: origins text | merge-sha | inline only
 * @typedef {{ sanitize: Function, sanitizeLine: Function, extractRefs: Function, fileRefs: Function, relink: Function }} SyncDeps
 * @typedef {{ status: 'ok'|'failed'|'busy', cursor: string|null, counts: { prs: number, issues: number, reviews: number,
 *   reviewComments: number, issueComments: number, files: number, requests: number }, error: string|null, staleLock: boolean,
 *   relink: import('./link.mjs').RelinkResult | { error: string } | null }} SyncResult
 *   status 'busy': another write holds the lock; sync returns it (never throws LockBusyError), nothing is written.
 *   relink: null when relink did not run (nothing was written: repo id mismatch, getRepo failure, a failure at
 *   sync:after-repo, a failed --full, busy); { error } when it failed (the sync is still ok, plan §3.1).
 */

const DEFAULT_DEPS = { sanitize, sanitizeLine, extractRefs, fileRefs, relink };
const ITEM_ORIGINS = ['text', 'merge-sha', 'inline'];
// every items column an item upsert may write: not id, and not the step-owned detail_for / reviews_at
const ITEM_COLS = new Set(['ptr', 'kind', 'number', 'parent_number', 'review_id', 'in_reply_to', 'state', 'draft', 'author',
  'author_assoc', 'title', 'body', 'url', 'created_at', 'updated_at', 'submitted_at', 'closed_at', 'merged_at', 'merge_sha',
  'base', 'head', 'path', 'side', 'start_side', 'start_line', 'line', 'original_start_line', 'original_line', 'commit_id',
  'original_commit_id', 'redactions', 'flags']);
const COUNT_KEY = { pr: 'prs', issue: 'issues', review: 'reviews', review_comment: 'reviewComments', issue_comment: 'issueComments' };
const STREAMS = [['issues', 'issue'], ['issue-comments', 'issue_comment'], ['review-comments', 'review_comment']];
const PULL_URL = /\/pulls\/(\d+)$/, ISSUE_URL = /\/issues\/(\d+)$/;
const HOUR = 3_600_000;

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const time = (v) => { const ms = v == null ? NaN : Date.parse(v); return Number.isNaN(ms) ? null : iso(ms); };
const sha = (v) => (typeof v === 'string' && /^[0-9a-f]{7,40}$/.test(v) ? v : null);
const int = (v) => (Number.isSafeInteger(v) ? v : null);
const id = (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 1) throw new BrainError('bad-item', 'a GitHub object without a usable number or id');
  return n;
};
const numberIn = (url, re) => { const m = re.exec(String(url ?? '')); return m ? id(m[1]) : null; };
const flagSet = (s) => new Set(String(s ?? '').split(' ').filter(Boolean));
const withFlag = (s, name, on) => { const f = flagSet(s); if (on) f.add(name); else f.delete(name); return [...f].join(' '); };
const limitsOf = (db) => ({ filesTruncated: db.prepare("SELECT COUNT(*) AS n FROM items WHERE kind = 'pr' AND ' ' || flags || ' ' LIKE '% files-truncated %'").get().n });
const removeStore = (path) => { for (const p of [path, `${path}-journal`]) rmSync(p, { force: true }); };

function tx(db, fn) {
  db.exec('BEGIN');
  try { const v = fn(); db.exec('COMMIT'); return v; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

/**
 * @param {{ codeDbPath: string, repoDir: string, client: import('./gh-client.mjs').GhClient, full?: boolean,
 *   log?: (s: string) => void, clock?: import('./gh-client.mjs').Clock, deps?: Partial<SyncDeps>, token?: string|null }} opts
 *   token: the active token, used only to cut it out by value (redactValues) of last_error, result.error and
 *   result.relink.error; the client already holds it for requests.
 * @returns {Promise<SyncResult>}
 */
export async function sync({ codeDbPath, repoDir, client, full = false, log = () => {}, clock = { now: () => Date.now() }, deps = {}, token = null }) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const counts = { prs: 0, issues: 0, reviews: 0, reviewComments: 0, issueComments: 0, files: 0, requests: 0 };
  const run = { codeDbPath, repoDir, client, full, log, deps: d, counts, now: () => iso(clock.now()),
    clean: (e) => redactValues(d.sanitizeLine(String(e?.message ?? e)), [token]) };
  try {
    const { value, staleLock } = await withWriteLock(codeDbPath, () => runLocked(run));
    return { ...value, staleLock };
  } catch (e) {
    if (e instanceof LockBusyError) return { status: 'busy', cursor: null, counts, error: e.message, staleLock: false, relink: null };
    throw e;
  }
}

async function runLocked(run) {
  const { codeDbPath, client, full, deps, counts } = run;
  const ghPath = githubDbPath(codeDbPath), tmpPath = `${ghPath}.full-tmp`;
  const result = { status: 'failed', cursor: null, counts, error: null, relink: null };
  let main = openGithubDb(ghPath, { create: !full });   // --full leaves a missing store missing until the swap
  let db = null;                                        // the store this run writes: main, or the --full temp store
  let relinkAfter = false;
  try {
    const state = main ? readSyncState(main) : {};
    result.cursor = state.cursor ?? null;
    // rows stored by an older sanitizer: after a successful sync, or a first sync that failed part-way (no cursor)
    const have = state.sanitize_version ?? -1;
    if (!full && have < SANITIZE_VERSION && (state.cursor || main.prepare('SELECT 1 FROM items LIMIT 1').get())) {
      throw new GuardError('github', have, SANITIZE_VERSION);
    }
    try {
      const repo = await client.getRepo();
      const T = time(repo.serverDate);
      if (!T) throw new GhError('protocol', 'the repo response has no usable Date header');   // R1
      if (state.repo_id != null && Number(state.repo_id) !== Number(repo.id)) {
        result.error = `github.db is bound to GitHub repo id ${Number(state.repo_id)}, origin is repo id ${Number(repo.id)}: nothing written`;
        return result;
      }
      failpoint('sync:after-repo');
      // this run holds the lock, so a run still marked running died (its lock was stale)
      if (state.run_status === 'running') writeSyncState(main, { run_status: 'interrupted' });
      if (full) { removeStore(tmpPath); db = openGithubDb(tmpPath, { create: true }); } else db = main;
      relinkAfter = !full;
      // a first or full sync stamps the sanitizer version with its first write, so even a partial store records it
      writeSyncState(db, { run_status: 'running', run_pid: process.pid, run_started_at: run.now(), last_error: null,
        repo_id: Number(repo.id), repo: deps.sanitizeLine(String(repo.fullName)),
        ...(full || !state.cursor ? { sanitize_version: SANITIZE_VERSION } : {}) });
      const W = state.cursor && !full ? iso(Date.parse(state.cursor) - HOUR) : null;   // R2
      await collect(run, db, { W, T, selfRepo: String(repo.fullName) });
      failpoint('sync:final:before');
      tx(db, () => {   // R11: the cursor moves only here
        writeSyncState(db, { cursor: T, run_status: 'ok', last_ok_at: run.now(), last_error: null, limits: limitsOf(db),
          ...(full ? { last_full_at: run.now() } : {}) });
        failpoint('sync:final:inside');
      });
      if (full) {
        db.close(); db = null;
        main?.close(); main = null;
        failpoint('sync:full:before-swap');
        renameSync(tmpPath, ghPath);
        relinkAfter = true;
      }
      result.status = 'ok';
      result.cursor = T;
    } catch (e) {
      result.error = run.clean(e);
      if (full) { db?.close(); db = null; removeStore(tmpPath); }   // the old store stays exactly as it was
      else writeSyncState(main, { run_status: 'failed', last_error: result.error, limits: limitsOf(main) });
    }
  } finally {
    if (db && db !== main) db.close();
    main?.close();
  }
  counts.requests = client.stats().requests;
  if (relinkAfter) {
    try { failpoint('sync:relink'); result.relink = await deps.relink({ codeDbPath, repoDir: run.repoDir, log: run.log }); }
    catch (e) { result.relink = { error: run.clean(e) }; }
  }
  return result;
}

// R3–R8: every request whose success the final transaction stands for
async function collect(run, db, { W, T, selfRepo }) {
  const { client, deps, counts, log } = run;
  const seen = Object.fromEntries(Object.keys(COUNT_KEY).map((k) => [k, new Set()]));
  let pages = 0, fileLists = 0;
  const store = (kind, raws) => {
    const { items } = ingestRaw(db, kind, raws, { selfRepo, deps });
    for (const it of items) seen[kind].add(it.ptr);
    counts[COUNT_KEY[kind]] = seen[kind].size;
    return items;
  };
  const changed = new Set();   // R8: PRs in the R3 window, and PRs that got a comment in this run's streams
  for await (const raws of client.pullsDesc({ stopBefore: W })) {
    for (const it of store('pr', raws)) changed.add(it.number);
    failpoint(`sync:page:${++pages}`);
  }
  for (const [stream, kind] of STREAMS) {
    for await (const raws of client.streamSince(stream, { since: W })) {
      for (const it of store(kind, raws)) if (it.parent_number != null) changed.add(it.parent_number);
      failpoint(`sync:page:${++pages}`);
    }
  }
  log(`github: ${counts.prs} PRs · ${counts.issues} issues · ${counts.issueComments + counts.reviewComments} comments`);
  // a comment parent that is not a stored PR is an issue: it has no reviews or files
  const prs = db.prepare("SELECT number, state, updated_at, detail_for FROM items WHERE kind = 'pr' ORDER BY number").all()
    .filter((p) => changed.has(p.number) || p.state === 'open');
  for (const p of prs) {
    const reviews = await client.reviews(p.number);
    tx(db, () => {
      store('review', reviews.map((r) => ({ ...r, pull_number: p.number })));
      db.prepare('UPDATE items SET reviews_at = ? WHERE ptr = ?').run(T, itemPtr('pr', p.number));
    });
    failpoint(`sync:page:${++pages}`);
    if (!changed.has(p.number) || (p.detail_for && p.detail_for === p.updated_at)) continue;
    const { files, truncated } = await client.files(p.number);
    storeFiles(db, p.number, files, truncated, deps);
    counts.files += files.length;
    failpoint(`sync:files:${++fileLists}`);
  }
  log(`github: reviews for ${prs.length} PRs · files for ${fileLists} PRs`);
}

// files step: this PR's pr-files refs, detail_for and the 'files-truncated' flag, in one transaction
function storeFiles(db, number, files, truncated, deps) {
  const ptr = itemPtr('pr', number);
  const clean = files.map((f) => ({ filename: deps.sanitizeLine(String(f.filename)),
    ...(f.previous_filename != null && { previous_filename: deps.sanitizeLine(String(f.previous_filename)) }) }));
  const refs = deps.fileRefs(clean);
  tx(db, () => {
    db.prepare("DELETE FROM refs WHERE ptr = ? AND origin = 'pr-files'").run(ptr);
    const add = db.prepare("INSERT OR IGNORE INTO refs(ptr, kind, target, origin) VALUES (?, ?, ?, 'pr-files')");
    for (const r of refs) add.run(ptr, r.kind, r.target);
    const { flags } = db.prepare('SELECT flags FROM items WHERE ptr = ?').get(ptr);
    db.prepare('UPDATE items SET detail_for = updated_at, flags = ? WHERE ptr = ?').run(withFlag(flags, 'files-truncated', !!truncated), ptr);
  });
}

/**
 * Store one page atomically: for each entry, upsert the item (R6: an older updated_at never overwrites; reviews
 * overwrite every field), replace its FTS rows, replace its refs of origins text | merge-sha | inline (new ones
 * 'pending'), and leave detail_for, reviews_at, the 'files-truncated' flag and pr-files refs untouched.
 * @param {import('node:sqlite').DatabaseSync} db @param {PageEntry[]} entries
 * @returns {{ inserted: number, updated: number, skipped: number }}
 */
export function upsertPage(db, entries) {
  const out = { inserted: 0, updated: 0, skipped: 0 };
  const prevOf = db.prepare('SELECT id, updated_at, flags FROM items WHERE ptr = ?');
  const textOf = db.prepare('SELECT title, body FROM items WHERE id = ?');
  const fts = ['items_fts', 'items_tri'].map((t) => [db.prepare(`DELETE FROM ${t} WHERE rowid = ?`), db.prepare(`INSERT INTO ${t}(rowid, title, body) VALUES (?, ?, ?)`)]);
  const dropRefs = db.prepare(`DELETE FROM refs WHERE ptr = ? AND origin IN (${ITEM_ORIGINS.map(() => '?').join(', ')})`);
  const addRef = db.prepare('INSERT OR IGNORE INTO refs(ptr, kind, target, origin) VALUES (?, ?, ?, ?)');
  // a savepoint: one transaction on its own, and nests inside the reviews step's transaction
  db.exec('SAVEPOINT upsert_page');
  try {
    for (const { item, refs } of entries) {
      const prev = prevOf.get(item.ptr);
      if (prev && item.kind !== 'review' && prev.updated_at && item.updated_at && item.updated_at < prev.updated_at) { out.skipped++; continue; }
      const row = { ...item, flags: withFlag(item.flags, 'files-truncated', flagSet(prev?.flags).has('files-truncated')) };
      const cols = Object.keys(row).filter((k) => ITEM_COLS.has(k));
      const vals = cols.map((k) => row[k] ?? null);
      let rowid;
      if (prev) {
        db.prepare(`UPDATE items SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...vals, prev.id);
        rowid = prev.id; out.updated++;
      } else {
        rowid = Number(db.prepare(`INSERT INTO items(${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...vals).lastInsertRowid);
        out.inserted++;
      }
      const t = textOf.get(rowid);
      for (const [del, ins] of fts) { del.run(rowid); ins.run(rowid, t.title ?? '', t.body ?? ''); }
      dropRefs.run(item.ptr, ...ITEM_ORIGINS);
      for (const r of refs || []) if (ITEM_ORIGINS.includes(r.origin)) addRef.run(item.ptr, r.kind, r.target, r.origin);
    }
    db.exec('RELEASE upsert_page');
  } catch (e) {
    db.exec('ROLLBACK TO upsert_page'); db.exec('RELEASE upsert_page');
    throw e;
  }
  return out;
}

/**
 * Production ingestion path for raw GitHub objects of one kind (used by sync and by eval preparation to add a
 * synthetic item exactly the way real ones are stored): normalize fields -> sanitize -> extractRefs -> upsertPage.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {'pr'|'issue'|'review'|'review_comment'|'issue_comment'} kind
 * @param {object[]} raws raw REST objects (reviews need { ...review, pull_number })
 * @param {{ selfRepo: string, deps?: Partial<SyncDeps> }} opts
 * @returns {{ inserted: number, updated: number, skipped: number, items: ItemRow[] }} items: the rows as stored
 */
export function ingestRaw(db, kind, raws, { selfRepo, deps = {} } = {}) {
  if (!COUNT_KEY[kind]) throw new BrainError('bad-kind', `unknown item kind: ${String(kind).slice(0, 40)}`);
  const d = { ...DEFAULT_DEPS, ...deps };
  const entries = raws.filter((r) => !(kind === 'issue' && r.pull_request))   // R5: the issues API lists PRs too
    .map((raw) => { const item = toRow(kind, raw, d); return { item, refs: d.extractRefs(item, { selfRepo }) }; });
  return { ...upsertPage(db, entries), items: entries.map((e) => e.item) };
}

// Raw REST object -> items row. GitHub strings pass deps.sanitize (bodies) or deps.sanitizeLine before any bind;
// times, SHAs and numbers are re-parsed into values built here, so no raw text is stored through them.
// redactions and 'suspicious' cover every stored string of the item, not only the body.
function toRow(kind, raw, deps) {
  let redactions = 0, suspicious = false;
  const check = (s) => { const r = deps.sanitize(s); redactions += r.redactions; suspicious ||= r.suspicious; return r.text; };
  const line = (v) => { if (v == null) return null; check(String(v)); return deps.sanitizeLine(String(v)); };
  const row = fieldsOf(kind, raw, line, (v) => (v == null ? null : check(String(v))));
  return { ...row, redactions, flags: suspicious ? 'suspicious' : '' };
}

function fieldsOf(kind, raw, line, text) {
  const row = { kind, author: line(raw.user?.login), author_assoc: line(raw.author_association), body: text(raw.body), url: line(raw.html_url) };
  const dates = { created_at: time(raw.created_at), updated_at: time(raw.updated_at) };
  if (kind === 'pr') {
    const n = id(raw.number);
    return { ...row, ...dates, ptr: itemPtr(kind, n), number: n, title: line(raw.title), draft: raw.draft ? 1 : 0,
      state: raw.merged_at ? 'merged' : raw.state === 'closed' ? 'closed_unmerged' : 'open',   // R10
      closed_at: time(raw.closed_at), merged_at: time(raw.merged_at),
      merge_sha: raw.merged_at ? sha(raw.merge_commit_sha) : null,   // an unmerged PR's merge_commit_sha is a test merge
      base: line(raw.base?.ref), head: line(raw.head?.ref) };
  }
  if (kind === 'issue') {
    const n = id(raw.number);
    return { ...row, ...dates, ptr: itemPtr(kind, n), number: n, title: line(raw.title),
      state: raw.state === 'closed' ? 'closed' : 'open', closed_at: time(raw.closed_at) };
  }
  if (kind === 'review') {
    return { ...row, ptr: itemPtr(kind, id(raw.id)),
      parent_number: raw.pull_number != null ? id(raw.pull_number) : numberIn(raw.pull_request_url, PULL_URL),
      state: line(raw.state), submitted_at: time(raw.submitted_at), commit_id: sha(raw.commit_id) };
  }
  if (kind === 'review_comment') {
    return { ...row, ...dates, ptr: itemPtr(kind, id(raw.id)), parent_number: numberIn(raw.pull_request_url, PULL_URL),
      review_id: int(raw.pull_request_review_id), in_reply_to: int(raw.in_reply_to_id), path: line(raw.path),
      side: line(raw.side), start_side: line(raw.start_side), start_line: int(raw.start_line), line: int(raw.line),
      original_start_line: int(raw.original_start_line), original_line: int(raw.original_line),
      commit_id: sha(raw.commit_id), original_commit_id: sha(raw.original_commit_id) };
  }
  return { ...row, ...dates, ptr: itemPtr(kind, id(raw.id)), parent_number: numberIn(raw.issue_url, ISSUE_URL) };   // issue_comment
}

/** origin URL -> { owner, repo } for github.com (https, ssh, git@), else null. */
export function parseRemote(url) {
  const m = /github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(url ?? '').trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}
