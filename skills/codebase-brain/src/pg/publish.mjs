// publisher (Q3): attempt bookkeeping and the one publish transaction (R1–R2, R7–R13, R15). Lane B owns this file.
// url is always the writer URL (BRAIN_WRITER_URL, direct endpoint). It never appears in an error or a log line.
// Lock key: contract.PUBLISH_LOCK_KEY (pg_advisory_xact_lock). sql/001_init.sql also takes it (transaction-level, so it
// cannot be released early) before it accepts a run row, so run ids follow commit order even for a buggy caller.
//
// Failures. Every error is a BrainError with `stage` (what failed) and `recorded` (whether the attempt is already
// 'failed' on the server). Checks before any connection (input, R16 outbound) throw with recorded = false: the caller
// records them with failAttempt. Inside the publish transaction a failed check (R10) or a write error rolls back and
// publish records the failure itself (R11). A lost COMMIT reply is resolved under the lock (R12): ok -> the run, rolled
// back -> recorded failure, lock not acquired or no reply -> code 'outcome-unknown' (never written again). Every query
// has a client deadline as well as the server's timeouts: a connection that stops answering cannot hang the job.
//
// Changes from the Q0 stub signatures (caller: src/pg/ci-publish.mjs, which replaced the Phase 2 driver ci/brain-publish.mjs):
// - publish takes no meta, syncState or sanitizeVersion: they come from the delta (diff copies them from the new
//   snapshot; commit must equal delta.meta.commit). New: repoDir (the source checkout, for git ancestry) and onStage (a
//   test hook, awaited after each stage).
// - beginAttempt, failAttempt and resolveAttempt keep the stub signatures.
// Phase 3 S2 (src/pg/ci-publish.mjs) adds, all optional so Phase 2 callers are unchanged: beginAttempt's base also carries
// the latest run's tool_version, sanitize_version and the server's GitHub T (A5); skipAttempt (A5); publish's limits
// (transaction / statement / lock timeouts, CI_LIMITS), recordFailure: false (the caller records the failure as
// `<stage>:<kind>`), signal (abort: the socket is destroyed, the server rolls back, nothing is resolved or recorded) and
// onStage(name, { client }) with a last stage 'ok' after the attempt row turns ok, before COMMIT (fault points F7–F9);
// failAttempt also stores the CI stage names and ciError strings.
import pg from 'pg';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import * as C from './contract.mjs';
import { BrainError } from '../errors.mjs';
import { checkOutbound, factKeyOf } from './snapshot.mjs';

const BATCH = 10_000;                                              // R13
const CODE_TABLES = ['node', 'item.repo', 'item.github', 'edge', 'unresolved', 'link', 'ref_link'];

// What attempt.stage and attempt.error may hold (R11, R16): the kinds below, a SQLSTATE, or an errno name. Anything else
// is stored as 'other', so free text (and a secret in it) never reaches the server.
const STAGES = new Set(['begin', 'mirror', 'build', 'sync', 'snapshot', 'outbound', 'input', 'connect', 'stale-base',
  'sanitize', 'row-count', 'publish', 'commit', ...C.CI_STAGES]);
const ERRORS = new Set([...[...STAGES].map((s) => `${s}-failed`), 'outbound-secret', 'contract', 'base-moved',
  'attempt-not-running', 'not-descendant', 'older', 'needs-full', 'not-resanitized', 'mismatch', 'delta-mismatch',
  'wrong-commit', 'rolled-back', 'error', ...Object.keys(constants.errno).map((e) => e.toLowerCase()), 'enotfound', 'eai_again',
  ...C.CI_STAGES.flatMap((st) => C.CI_ERROR_KINDS.map((k) => `${st}:${k}`))]);
const asKind = (s, known) => (typeof s === 'string' && (known.has(s) || (known === ERRORS && /^[0-9a-z]{5}$/.test(s))) ? s : 'other');
const errorKind = (e) => asKind(String(e?.code ?? 'error').toLowerCase(), ERRORS);    // SQLSTATE or a socket error code

const fail = (code, stage, msg, extra = {}) => { throw new BrainError(code, msg, { stage, recorded: false, ...extra }); };

/**
 * A sleeping Neon compute wakes on the first connection (§6.5): retry after CI_CONNECT_BACKOFF_MS (1, 2, 4, 8 s), 30 s in
 * all. A wrong password or database (SQLSTATE class 28, 3D) is not retried. queryTimeout: the client deadline of every
 * query on it.
 */
async function connect(url, { queryTimeout }) {
  const until = Date.now() + 30_000;
  for (const wait of [...C.CI_CONNECT_BACKOFF_MS, null]) {
    const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: Math.max(1000, until - Date.now()), query_timeout: queryTimeout });
    c.on('error', () => {});                                       // a dropped socket surfaces on the next query
    try { await c.connect(); return c; } catch (e) {
      kill(c);
      if (wait === null || /^(28|3D)/.test(e.code ?? '') || Date.now() + wait >= until) throw e;
      await sleep(wait);
    }
  }
}
/** a clean Terminate, or the socket is destroyed after 5 s (the server then ends the session and rolls back) */
async function close(c) {
  await Promise.race([c.end().catch(() => {}), new Promise((r) => setTimeout(r, 5000).unref())]);
  kill(c);
}
function kill(c) { try { c.connection.stream.destroy(); } catch { /* already gone */ } }
/** '30s' -> 30000 (a duration publish's limits validated) */
const durationMs = (d) => { const [, n, u] = /^([1-9][0-9]*)(ms|s|min)$/.exec(d); return Number(n) * { ms: 1, s: 1000, min: 60_000 }[u]; };

/**
 * R1–R2: one short transaction. Checks (and, when brain.binding is empty, writes) the binding, inserts the attempt
 * (status running), reads the latest run B. Closes the connection. A second call with the same (runId, attempt) fails
 * on the unique constraint. A binding with another source repo id refuses (code 'binding-mismatch', nothing written).
 * @param {{ url: string, gha: { runId: number, attempt: number }, sourceSha: string,
 *   binding: { sourceRepoId: number, sourceRepo: string, opsRepo: string, workflow: string } }} opts
 * @returns {Promise<{ attemptId: number, base: null | { run: number, commit: string, checksum: object, tool: string,
 *   sanitize: number, githubT: string|null } }>} githubT: the newest GitHub cursor T on the server (A5)
 */
export async function beginAttempt({ url, gha, sourceSha, binding }) {
  if (!/^[0-9a-f]{40}$/.test(sourceSha ?? '')) fail('contract', 'begin', 'sourceSha must be a 40-hex commit');
  const c = await connect(url, { queryTimeout: 45_000 });
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL statement_timeout = '30s'");
    const bound = (await c.query('SELECT source_repo_id FROM brain.binding WHERE id = 1')).rows[0];
    if (!bound) {
      await c.query('INSERT INTO brain.binding (source_repo_id, source_repo, ops_repo, workflow) VALUES ($1, $2, $3, $4)',
        [binding.sourceRepoId, binding.sourceRepo, binding.opsRepo, binding.workflow]);
    } else if (Number(bound.source_repo_id) !== binding.sourceRepoId) {
      fail('binding-mismatch', 'begin', 'this database belongs to another source repository: nothing was written');
    }
    const latest = (await c.query(`SELECT run_id, commit_sha, checksum, tool_version, sanitize_version,
      (SELECT s.state->'row'->>'cursor' FROM brain.sync_state s WHERE s.source = 'github' ORDER BY s.run_id DESC LIMIT 1) AS github_t
      FROM brain.run ORDER BY run_id DESC LIMIT 1`)).rows[0];
    const a = await c.query('INSERT INTO brain.attempt (gha_run_id, gha_attempt, source_sha, base_run) VALUES ($1, $2, $3, $4) RETURNING attempt_id',
      [gha.runId, gha.attempt, sourceSha, latest?.run_id ?? null]);
    await c.query('COMMIT');
    return { attemptId: Number(a.rows[0].attempt_id),
      base: latest ? { run: Number(latest.run_id), commit: latest.commit_sha, checksum: latest.checksum, tool: latest.tool_version,
        sanitize: latest.sanitize_version, githubT: latest.github_t ?? null } : null };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { await close(c); }
}

/**
 * A5: end a running attempt as 'skipped' (a publish of the same commit, tool and GitHub window is already on the server).
 * One statement; no publish of this attempt can be in flight. @returns {Promise<{ updated: boolean }>}
 */
export async function skipAttempt({ url, attemptId }) {
  const c = await connect(url, { queryTimeout: 45_000 });
  try {
    await c.query("SET statement_timeout = '30s'");
    const r = await c.query("UPDATE brain.attempt SET status = 'skipped', finished_at = now() WHERE attempt_id = $1 AND status = 'running'", [attemptId]);
    return { updated: r.rowCount === 1 };
  } finally { await close(c); }
}

// ---------------------------------------------------------------------------------------------------------------------
// the delta, as SQL over jsonb_to_recordset batches. Every statement checks its row count: a delta that does not fit
// the server (a close of a row that is not open, a reference to a missing node) throws instead of writing less.

const chunked = (rows) => Array.from({ length: Math.ceil(rows.length / BATCH) }, (_, i) => rows.slice(i * BATCH, (i + 1) * BATCH));

async function each(c, rows, sql, params, { exact = true, what }) {
  let n = 0;
  for (const part of chunked(rows)) {
    const r = await c.query(sql, [JSON.stringify(part), ...params]);
    if (exact && r.rowCount !== part.length) fail('delta-mismatch', 'publish', `${what}: ${r.rowCount} of ${part.length} rows fit the server`, { kind: 'delta-mismatch' });
    n += r.rowCount;
  }
  return n;
}

const closeFacts = (c, run, table, keys) => each(c, keys,
  `UPDATE brain.${table} SET valid_to = $2 WHERE valid_to IS NULL AND fact_key IN (SELECT decode(k, 'hex') FROM jsonb_array_elements_text($1::jsonb) k)`,
  [run], { what: `close ${table}` });

async function writeNodes(c, run, { put, close: gone }) {
  await each(c, gone, `UPDATE brain.node_rev r SET valid_to = $2 FROM brain.node n
    WHERE n.node_id = r.node_id AND r.valid_to IS NULL AND n.key IN (SELECT jsonb_array_elements_text($1::jsonb))`, [run], { what: 'close node' });
  await each(c, put.map((n) => n.key), `UPDATE brain.node_rev r SET valid_to = $2 FROM brain.node n
    WHERE n.node_id = r.node_id AND r.valid_to IS NULL AND n.key IN (SELECT jsonb_array_elements_text($1::jsonb))`, [run], { exact: false });
  // identities: a key that reappears keeps its node_id (V7); files and dirs before the symbols that point at them
  const ids = put.map((n) => ({ key: n.key, node_kind: n.nodeKind, path: n.path, file: n.file }));
  for (const rows of [ids.filter((n) => n.node_kind !== 'symbol'), ids.filter((n) => n.node_kind === 'symbol')]) {
    await each(c, rows, `INSERT INTO brain.node (key, node_kind, path, file_id)
      SELECT x.key, x.node_kind, x.path, f.node_id FROM jsonb_to_recordset($1::jsonb) x(key text, node_kind text, path text, file text)
      LEFT JOIN brain.node f ON f.key = x.file ON CONFLICT (key) DO NOTHING`, [], { exact: false });
  }
  await each(c, ids, `SELECT 1 FROM jsonb_to_recordset($1::jsonb) x(key text, node_kind text, path text, file text)
    JOIN brain.node n ON n.key = x.key LEFT JOIN brain.node f ON f.key = x.file
    WHERE n.node_kind = x.node_kind AND n.path = x.path AND n.file_id IS NOT DISTINCT FROM f.node_id
      AND (x.file IS NULL OR f.node_id IS NOT NULL)`, [], { what: 'node identity' });
  await each(c, put.map((n) => ({ key: n.key, hash: C.hex(n.hash), ...n.rev })), `INSERT INTO brain.node_rev
      (node_id, rev_no, valid_from, hash, p0_key, kind, name, line, end_line, parent_id, exported, lang, flags)
    SELECT n.node_id, 1 + coalesce((SELECT max(r.rev_no) FROM brain.node_rev r WHERE r.node_id = n.node_id), 0), $2,
      decode(x.hash, 'hex'), x.p0_key, x.kind, x.name, x.line, x.end_line, p.node_id, x.exported = 1, x.lang, x.flags
    FROM jsonb_to_recordset($1::jsonb) x(key text, hash text, p0_key text, kind text, name text, line int, end_line int,
      parent text, exported int, lang text, flags text)
    JOIN brain.node n ON n.key = x.key LEFT JOIN brain.node p ON p.key = x.parent
    WHERE x.parent IS NULL OR p.node_id IS NOT NULL`, [run], { what: 'node_rev' });
}

async function writeItems(c, run, { put, close: gone }) {
  const closeRevs = `UPDATE brain.item_rev r SET valid_to = $2 FROM brain.item i
    WHERE i.item_id = r.item_id AND r.valid_to IS NULL AND i.ptr IN (SELECT jsonb_array_elements_text($1::jsonb))`;
  await each(c, gone, closeRevs, [run], { what: 'close item' });
  await each(c, put.map((i) => i.ptr), closeRevs, [run], { exact: false });
  await each(c, put.map((i) => ({ ptr: i.ptr, kind: i.kind, origin: i.origin })), `INSERT INTO brain.item (ptr, kind, origin)
    SELECT x.ptr, x.kind, x.origin FROM jsonb_to_recordset($1::jsonb) x(ptr text, kind text, origin text) ON CONFLICT (ptr) DO NOTHING`,
  [], { exact: false });
  await each(c, put.map((i) => ({ ptr: i.ptr, kind: i.kind, hash: C.hex(i.hash), ...i.rev })), `INSERT INTO brain.item_rev
      (item_id, rev_no, valid_from, hash, title, body, state, author, source_updated_at, meta, sanitize_version)
    SELECT i.item_id, 1 + coalesce((SELECT max(r.rev_no) FROM brain.item_rev r WHERE r.item_id = i.item_id), 0), $2,
      decode(x.hash, 'hex'), x.title, x.body, x.state, x.author, x.source_updated_at, x.meta, x.sanitize_version
    FROM jsonb_to_recordset($1::jsonb) x(ptr text, kind text, hash text, title text, body text, state text, author text,
      source_updated_at text, meta jsonb, sanitize_version int)
    JOIN brain.item i ON i.ptr = x.ptr AND i.kind = x.kind`, [run], { what: 'item_rev' });
  const newRev = `JOIN brain.item i ON i.ptr = x.ptr JOIN brain.item_rev r ON r.item_id = i.item_id AND r.valid_from = $2 AND r.valid_to IS NULL`;
  await each(c, put.flatMap((i) => i.chunks.map((ch) => ({ ptr: i.ptr, ...ch }))), `INSERT INTO brain.chunk
      (rev_id, ord, start_line, end_line, title, body, sha, date, prs, body_line)
    SELECT r.rev_id, x.ord, x.start_line, x.end_line, x.title, x.body, x.sha, x.date, x.prs, x.body_line
    FROM jsonb_to_recordset($1::jsonb) x(ptr text, ord int, start_line int, end_line int, title text, body text, sha text,
      date text, prs text, body_line int) ${newRev}`, [run], { what: 'chunk' });
  await each(c, put.flatMap((i) => i.refs.map((rf, ord) => ({ ptr: i.ptr, ord, ...rf }))), `INSERT INTO brain.ref (rev_id, ord, kind, target, origin)
    SELECT r.rev_id, x.ord, x.kind, x.target, x.origin
    FROM jsonb_to_recordset($1::jsonb) x(ptr text, ord int, kind text, target text, origin text) ${newRev}`, [run], { what: 'ref' });
}

// the current revision of x.ptr whose content hash is x.rev_hash (a link / ref_link names its chunk / ref that way)
const CURRENT_REV = `JOIN brain.item i ON i.ptr = x.ptr
  JOIN brain.item_rev r ON r.item_id = i.item_id AND r.valid_to IS NULL AND r.hash = decode(x.rev_hash, 'hex')`;

async function writeFacts(c, run, delta) {
  const key = (t) => (f) => ({ k: factKeyOf(t, f), ...f });
  for (const t of ['edge', 'unresolved', 'link', 'ref_link']) await closeFacts(c, run, t, delta[t].close);
  await each(c, delta.edge.put.map(key('edge')), `INSERT INTO brain.edge (fact_key, src_id, dst_id, kind, site_file_id, line, col, valid_from)
    SELECT decode(x.k, 'hex'), s.node_id, d.node_id, x.kind, f.node_id, x.line, x.col, $2
    FROM jsonb_to_recordset($1::jsonb) x(k text, src text, dst text, kind text, site text, line int, col int)
    JOIN brain.node s ON s.key = x.src JOIN brain.node d ON d.key = x.dst LEFT JOIN brain.node f ON f.key = x.site
    WHERE x.site IS NULL OR f.node_id IS NOT NULL`, [run], { what: 'edge' });
  await each(c, delta.unresolved.put.map(key('unresolved')), `INSERT INTO brain.unresolved (fact_key, path, line, spec, local, valid_from)
    SELECT decode(x.k, 'hex'), x.path, x.line, x.spec, x.local, $2
    FROM jsonb_to_recordset($1::jsonb) x(k text, path text, line int, spec text, local int)`, [run], { what: 'unresolved' });
  await each(c, delta.link.put.map(key('link')).map((l) => ({ ...l, rev_hash: l.revHash })), `INSERT INTO brain.link
      (fact_key, chunk_id, node_id, kind, evidence, valid_from)
    SELECT decode(x.k, 'hex'), ch.chunk_id, n.node_id, x.kind, x.evidence, $2
    FROM jsonb_to_recordset($1::jsonb) x(k text, ptr text, rev_hash text, ord int, node text, kind text, evidence text)
    ${CURRENT_REV} JOIN brain.chunk ch ON ch.rev_id = r.rev_id AND ch.ord = x.ord JOIN brain.node n ON n.key = x.node`,
  [run], { what: 'link' });
  await each(c, delta.ref_link.put.map(key('ref_link')).map((l) => ({ ...l, rev_hash: l.revHash, resolved_raw: l.resolvedRaw })), `INSERT INTO brain.ref_link
      (fact_key, ref_id, status, reason, resolved, resolved_raw, valid_from)
    SELECT decode(x.k, 'hex'), rf.ref_id, x.status, x.reason, x.resolved, x.resolved_raw, $2
    FROM jsonb_to_recordset($1::jsonb) x(k text, ptr text, rev_hash text, ord int, status text, reason text, resolved jsonb, resolved_raw text)
    ${CURRENT_REV} JOIN brain.ref rf ON rf.rev_id = r.rev_id AND rf.ord = x.ord`, [run], { what: 'ref_link' });
}

/** R9 row-count check: the open rows per table, in checksum's table names. */
async function openCounts(c) {
  const r = await c.query(`SELECT
    (SELECT count(*) FROM brain.node_rev WHERE valid_to IS NULL) AS "node",
    (SELECT count(*) FROM brain.item_rev r JOIN brain.item i USING (item_id) WHERE r.valid_to IS NULL AND i.origin = 'repo') AS "item.repo",
    (SELECT count(*) FROM brain.item_rev r JOIN brain.item i USING (item_id) WHERE r.valid_to IS NULL AND i.origin = 'github') AS "item.github",
    (SELECT count(*) FROM brain.edge WHERE valid_to IS NULL) AS "edge",
    (SELECT count(*) FROM brain.unresolved WHERE valid_to IS NULL) AS "unresolved",
    (SELECT count(*) FROM brain.link WHERE valid_to IS NULL) AS "link",
    (SELECT count(*) FROM brain.ref_link WHERE valid_to IS NULL) AS "ref_link"`);
  return Object.fromEntries(CODE_TABLES.map((t) => [t, Number(r.rows[0][t])]));
}

/**
 * git: is `older` an ancestor of (or equal to) `newer` in the source checkout? Unknown commits count as no. git gets
 * PATH and HOME only: no child process of the publisher sees the writer URL.
 */
function descends(repoDir, older, newer) {
  try {
    execFileSync('git', ['-C', repoDir, 'merge-base', '--is-ancestor', older, newer], { stdio: 'ignore', env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    return true;
  } catch { return false; }
}

/**
 * R9: transaction_timeout 60s (10 min for the first publish, R13) -> BEGIN -> SET LOCAL statement_timeout 30s,
 * lock_timeout 15s -> pg_advisory_xact_lock(PUBLISH_LOCK_KEY) -> checks (latest run = base, commit descends from the base
 * commit unless mode = 'bootstrap', attempt running; R15 sanitize_version) -> run INSERT -> delta -> sync_state ->
 * current row counts = checksum rows -> attempt ok -> COMMIT. A failed check: ROLLBACK and failAttempt(stage 'stale-base') (R10).
 * The base must also be the one beginAttempt recorded for this attempt. After a sanitize_version bump every current item
 * revision and the GitHub sync state must carry the new version (R15), whatever the delta says.
 * The run's meta, sanitize_version and sync_state come from the delta (diff copies them from the new snapshot).
 * @param {{ url: string, attemptId: number, base: number|null, delta: import('./contract.mjs').Delta,
 *   checksum: Record<string, { rows: number, sha256: string }>, mode: 'normal'|'bootstrap', commit: string,
 *   toolVersion: string, repoDir: string, onStage?: (stage: string, ctx: { client: object }) => unknown,
 *   limits?: { txTimeout: string, statementTimeout: string, lockTimeout: string }, recordFailure?: boolean,
 *   signal?: AbortSignal }} opts
 *   checksum: contract.checksum(applyDelta(base state, delta)); commit: the source commit (= delta.meta.commit and the
 *   attempt's source_sha); repoDir: the source checkout (git ancestry, normal mode); onStage: hook awaited after each
 *   stage ('locked', 'run', 'nodes', 'items', 'facts', 'counts', 'ok'; then 'committed' once COMMIT has returned or a
 *   lost COMMIT resolved as ok, or 'rolled-back' once it resolved as not committed, each before any connection closes
 *   and with its errors ignored) with the client; limits: default
 *   transaction_timeout 60s (10min for the first publish), statement_timeout 30s, lock_timeout 15s (each query's
 *   client deadline is statement_timeout + 15 s); recordFailure: false leaves every failure unrecorded (recorded =
 *   false) for the caller; signal: abort destroys the socket (the server rolls back) and throws code 'aborted' without
 *   resolving or recording
 * @returns {Promise<{ run: number }>}
 */
export async function publish({ url, attemptId, base, delta, checksum, mode, commit, toolVersion, repoDir, onStage = null,
  limits = null, recordFailure = true, signal = null }) {
  // before any connection (recorded = false: the caller runs failAttempt)
  C.validateManifest(delta.manifest);
  if (base !== null && !(Number.isSafeInteger(base) && base > 0)) fail('contract', 'input', 'base must be null or a run id');
  if (delta.base !== base) fail('contract', 'input', 'the delta was made for another base run');   // no values: never echo input
  if (!/^[0-9a-f]{40}$/.test(commit ?? '') || delta.meta.commit !== commit) fail('contract', 'input', 'commit must be the 40-hex sha the delta was built from');
  if (mode !== 'normal' && mode !== 'bootstrap') fail('contract', 'input', 'mode must be normal or bootstrap');
  const sanitizeVersion = delta.meta.sanitize_version;
  if (!Number.isInteger(sanitizeVersion)) fail('contract', 'input', 'delta.meta has no sanitize_version');
  for (const t of [...C.CHECKSUM_SHAPES.code, ...C.CHECKSUM_SHAPES.github]) {
    if (!Number.isInteger(checksum?.[t]?.rows)) fail('contract', 'input', `checksum has no ${t}`);
  }
  const first = base === null;
  const lim = limits ?? { txTimeout: first ? '10min' : '60s', statementTimeout: '30s', lockTimeout: '15s' };
  for (const v of [lim.txTimeout, lim.statementTimeout, lim.lockTimeout]) {
    if (!/^[1-9][0-9]*(ms|s|min)$/.test(v ?? '')) fail('contract', 'input', 'limits must be durations like 60s or 10min');
  }
  try { checkOutbound(delta); } catch (e) { Object.assign(e, { stage: 'outbound', recorded: false }); throw e; }

  const record = (st, kind) => (recordFailure ? failAttempt({ url, attemptId, stage: st, error: kind }).then((r) => r.updated, () => false) : false);
  if (signal?.aborted) fail('aborted', 'publish', 'aborted before the publish connection');
  let c;
  try { c = await connect(url, { queryTimeout: durationMs(lim.statementTimeout) + 15_000 }); } catch (e) {   // statement_timeout + margin
    if (signal?.aborted) fail('aborted', 'publish', 'aborted while the publish connection opened');   // not recorded
    const kind = errorKind(e);
    fail('publish-failed', 'connect', `could not connect to the server (${kind}): nothing was written`, { kind, recorded: await record('connect', kind) });
  }
  const stage = async (name) => { if (onStage) await onStage(name, { client: c }); };
  const abort = () => kill(c);                                     // the server sees the socket close and rolls back
  signal?.addEventListener('abort', abort, { once: true });
  let committing = false;
  try {
    if (signal?.aborted) fail('aborted', 'publish', 'aborted while the publish connection opened');   // the catch drops it
    await c.query(`SET transaction_timeout = '${lim.txTimeout}'`);
    await c.query('BEGIN');
    await c.query(`SET LOCAL statement_timeout = '${lim.statementTimeout}'`);
    await c.query(`SET LOCAL lock_timeout = '${lim.lockTimeout}'`);
    await c.query('SELECT pg_advisory_xact_lock($1)', [C.PUBLISH_LOCK_KEY]);
    await stage('locked');
    const latest = (await c.query('SELECT run_id, commit_sha, sanitize_version FROM brain.run ORDER BY run_id DESC LIMIT 1')).rows[0] ?? null;
    const att = (await c.query('SELECT status, source_sha, base_run FROM brain.attempt WHERE attempt_id = $1', [attemptId])).rows[0];
    if (att && att.source_sha !== commit) fail('contract', 'input', 'commit is not the source commit of this attempt', { kind: 'wrong-commit' });
    const runOf = (v) => (v === null || v === undefined ? null : Number(v));
    const stale = runOf(latest?.run_id) !== base || (att && runOf(att.base_run) !== base) ? 'base-moved'
      : att?.status !== 'running' ? 'attempt-not-running'
        : mode === 'normal' && latest && !descends(repoDir, latest.commit_sha, commit) ? 'not-descendant' : null;
    if (stale) fail('stale-base', 'stale-base', `the base run changed or the commit does not descend from it (${stale}): nothing was written`, { kind: stale });
    if (latest && sanitizeVersion < latest.sanitize_version) {
      fail('sanitize-version', 'sanitize', 'this kit sanitizes with an older version than the server: nothing was written', { kind: 'older' });
    }
    if (latest && sanitizeVersion > latest.sanitize_version && delta.manifest.github !== 'full') {
      fail('sanitize-version', 'sanitize', 'a new sanitize_version needs a full publish (--full, R15): nothing was written', { kind: 'needs-full' });
    }

    const run = Number((await c.query(`INSERT INTO brain.run (attempt_id, commit_sha, mode, tool_version, sanitize_version, meta, checksum)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING run_id`,
    [attemptId, commit, mode, toolVersion, sanitizeVersion, JSON.stringify(delta.meta), JSON.stringify(checksum)])).rows[0].run_id);
    await stage('run');
    await writeNodes(c, run, delta.nodes);
    await stage('nodes');
    await writeItems(c, run, delta.items);
    await stage('items');
    await writeFacts(c, run, delta);
    if (delta.sync.github) await c.query("INSERT INTO brain.sync_state (run_id, source, state) VALUES ($1, 'github', $2)", [run, JSON.stringify(delta.sync.github)]);
    await stage('facts');
    if (latest && sanitizeVersion > latest.sanitize_version) {      // R15: nothing current may keep the old rules
      const old = Number((await c.query('SELECT count(*) AS n FROM brain.item_rev WHERE valid_to IS NULL AND sanitize_version <> $1', [sanitizeVersion])).rows[0].n);
      if (old > 0 || (delta.sync.github && delta.sync.github.row?.sanitize_version !== sanitizeVersion)) {
        fail('sanitize-version', 'sanitize', `${old} current item revisions or the GitHub state keep an older sanitize_version: nothing was written`, { kind: 'not-resanitized' });
      }
    }
    const counts = await openCounts(c);
    const off = CODE_TABLES.find((t) => counts[t] !== checksum[t].rows);
    if (off) fail('row-count', 'row-count', `${off}: the server holds ${counts[off]} open rows, the checksum ${checksum[off].rows}`, { kind: 'mismatch' });
    await stage('counts');
    const ok = await c.query("UPDATE brain.attempt SET status = 'ok', finished_at = now() WHERE attempt_id = $1 AND status = 'running'", [attemptId]);
    if (ok.rowCount !== 1) fail('stale-base', 'stale-base', 'the attempt is no longer running', { kind: 'attempt-not-running' });
    await stage('ok');
    committing = true;
    await c.query({ text: 'COMMIT', query_timeout: 15_000 });
    await stage('committed').catch(() => {});                       // a hook cannot undo a commit
    return { run };
  } catch (e) {
    if (signal?.aborted) {                                         // the caller is shutting down: it resolves and records
      kill(c);
      fail('aborted', committing ? 'commit' : 'publish', 'the publish was aborted', { kind: committing ? 'outcome-unknown' : 'aborted' });
    }
    if (committing) {                                              // R12: the COMMIT reply is lost (or COMMIT failed)
      kill(c);
      const r = await resolveAttempt({ url, attemptId, onOutcome: (o) => { stage(o === 'ok' ? 'committed' : 'rolled-back').catch(() => {}); } });
      if (r.outcome === 'ok') return { run: r.run };
      if (r.outcome === 'rolled-back') {
        fail('publish-failed', 'commit', 'the COMMIT did not happen: nothing was written', { kind: 'rolled-back', recorded: await record('commit', 'rolled-back') });
      }
      fail('outcome-unknown', 'commit', 'the COMMIT reply was lost and the outcome is unknown: do not publish again until it is resolved');
    }
    await c.query({ text: 'ROLLBACK', query_timeout: 5_000 }).catch(() => {});
    kill(c);                                                       // a dead socket: the server rolls back on its own
    if (e instanceof BrainError && e.stage) { e.recorded = await record(e.stage, e.kind ?? e.code); throw e; }
    const kind = errorKind(e);
    const why = typeof e.message === 'string' && e.message.startsWith('brain.') ? `: ${e.message.slice(0, 200)}` : '';   // guard messages name tables only
    return fail('publish-failed', 'publish', `the publish transaction failed (${kind}${why}): nothing was written`,
      { kind, recorded: await record('publish', kind) });
  } finally { signal?.removeEventListener('abort', abort); await close(c); }
}

/**
 * R11: new connection, BEGIN, the publish lock, UPDATE attempt SET status = 'failed' ... WHERE attempt_id = $1 AND
 * status = 'running', COMMIT. stage and error must be known kinds (STAGES, ERRORS, a SQLSTATE or an errno name);
 * anything else is stored as 'other', so free text (and a secret in it) never reaches the server. Every query has a
 * client deadline of 75 s (lock_timeout 60 s + margin).
 * @param {{ url: string, attemptId: number, stage: string, error: string|null }} opts @returns {Promise<{ updated: boolean }>}
 */
export async function failAttempt({ url, attemptId, stage, error = null }) {
  const c = await connect(url, { queryTimeout: 75_000 });
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL lock_timeout = '60s'");
    await c.query('SELECT pg_advisory_xact_lock($1)', [C.PUBLISH_LOCK_KEY]);
    const r = await c.query("UPDATE brain.attempt SET status = 'failed', stage = $2, error = $3, finished_at = now() WHERE attempt_id = $1 AND status = 'running'",
      [attemptId, asKind(stage, STAGES), error === null || error === undefined ? null : asKind(error, ERRORS)]);
    await c.query('COMMIT');
    return { updated: r.rowCount === 1 };
  } catch (e) {
    await c.query({ text: 'ROLLBACK', query_timeout: 5_000 }).catch(() => {});
    throw e;
  } finally { await close(c); }
}

/**
 * R12: after a lost COMMIT reply. New connection, the publish lock with lock_timeout 60s, then: a run row for the
 * attempt -> 'ok'; none -> 'rolled-back' (the caller then runs failAttempt). Lock not acquired, no connection or no answer
 * within the client deadline (75 s) -> 'unknown'. Never writes. onOutcome('ok'|'rolled-back') is called as soon as the
 * server has answered, before the lock is released and the connection closed.
 * @param {{ url: string, attemptId: number, onOutcome?: (outcome: 'ok'|'rolled-back') => void }} opts
 * @returns {Promise<{ outcome: 'ok'|'rolled-back'|'unknown', run: number|null }>}
 */
export async function resolveAttempt({ url, attemptId, onOutcome = null }) {
  let c;
  try {
    c = await connect(url, { queryTimeout: 75_000 });
    await c.query('BEGIN');
    await c.query("SET LOCAL lock_timeout = '60s'");
    await c.query('SELECT pg_advisory_xact_lock($1)', [C.PUBLISH_LOCK_KEY]);
    const r = (await c.query('SELECT run_id FROM brain.run WHERE attempt_id = $1', [attemptId])).rows[0];
    const out = r ? { outcome: 'ok', run: Number(r.run_id) } : { outcome: 'rolled-back', run: null };
    try { onOutcome?.(out.outcome); } catch { /* a hook cannot change the outcome */ }
    return out;
  } catch { return { outcome: 'unknown', run: null }; }               // 55P03 lock_not_available, a timeout, a dead socket
  finally {
    if (c) {
      await c.query({ text: 'ROLLBACK', query_timeout: 5_000 }).catch(() => {});
      await close(c);
    }
  }
}
