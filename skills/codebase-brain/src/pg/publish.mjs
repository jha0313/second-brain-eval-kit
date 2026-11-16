// publisher (Q3): attempt bookkeeping and the one publish transaction (R1–R2, R7–R13, R15). Lane B owns this file.
// Q0 STUB: the signatures below are the contract. url is always the writer URL (BRAIN_WRITER_URL, direct endpoint).
// Lock key: contract.PUBLISH_LOCK_KEY (pg_advisory_xact_lock). sql/001_init.sql also takes it (transaction-level, so it
// cannot be released early) before it accepts a run row, so run ids follow commit order even for a buggy caller.
import { NotImplementedError } from '../errors.mjs';

/**
 * R1–R2: one short transaction. Checks (and, when brain.binding is empty, writes) the binding, inserts the attempt
 * (status running), reads the latest run B. Closes the connection. A second call with the same (runId, attempt) fails
 * on the unique constraint.
 * @param {{ url: string, gha: { runId: number, attempt: number }, sourceSha: string,
 *   binding: { sourceRepoId: number, sourceRepo: string, opsRepo: string, workflow: string } }} opts
 * @returns {Promise<{ attemptId: number, base: null | { run: number, commit: string, checksum: object } }>}
 */
export async function beginAttempt(_opts) { throw new NotImplementedError('pg.beginAttempt'); }

/**
 * R9: transaction_timeout 60s (10 min for the first publish, R13) -> BEGIN -> SET LOCAL statement_timeout 30s,
 * lock_timeout 15s -> pg_advisory_xact_lock(PUBLISH_LOCK_KEY) -> checks (latest run = base, commit descends from the base
 * commit unless mode = 'bootstrap', attempt running) -> run INSERT -> delta -> sync_state -> current row counts =
 * checksum rows -> attempt ok -> COMMIT. A failed check: ROLLBACK and failAttempt(stage 'stale-base') (R10).
 * @param {{ url: string, attemptId: number, base: number|null, delta: import('./contract.mjs').Delta,
 *   checksum: Record<string, { rows: number, sha256: string }>, syncState: Record<'github', object>,
 *   meta: Record<string, unknown>, mode: 'normal'|'bootstrap', commit: string, toolVersion: string, sanitizeVersion: number }} opts
 * @returns {Promise<{ run: number }>}
 */
export async function publish(_opts) { throw new NotImplementedError('pg.publish'); }

/**
 * R11: new connection, BEGIN, the publish lock, UPDATE attempt SET status = 'failed' ... WHERE attempt_id = $1 AND
 * status = 'running', COMMIT. error holds the stage and the error kind only (checked like R16).
 * @param {{ url: string, attemptId: number, stage: string, error: string }} opts @returns {Promise<{ updated: boolean }>}
 */
export async function failAttempt(_opts) { throw new NotImplementedError('pg.failAttempt'); }

/**
 * R12: after a lost COMMIT reply. New connection, the publish lock with lock_timeout 60s, then: a run row for the
 * attempt -> 'ok'; none -> 'rolled-back' (the caller then runs failAttempt); lock not acquired -> 'unknown'. Never writes.
 * @param {{ url: string, attemptId: number }} opts
 * @returns {Promise<{ outcome: 'ok'|'rolled-back'|'unknown', run: number|null }>}
 */
export async function resolveAttempt(_opts) { throw new NotImplementedError('pg.resolveAttempt'); }
