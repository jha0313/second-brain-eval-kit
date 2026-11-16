// Server mode (design §6.2, §6.4): which server a command reads, the reader check, and the local mirror the map
// commands read. Lane C owns this file.
// - The reader URL: BRAIN_READER_URL from the environment, else the same name in brain's own .env.local (the skill
//   directory). DATABASE_URL / DATABASE_URL_UNPOOLED (the owner URL `neon init` writes) are never read.
// - connectReader: the first statement checks the account (logged in as brain_reader and acting as it, no write
//   privilege on any brain table, a member of no role it could SET ROLE to), the second that brain.binding names the
//   checkout's origin. Either failing ends the connection and refuses (exit 2).
// - Mirrors: ~/.cache/brain/mirror/<source_repo_id>/latest and .../as-of, one of each (§6.4). A pull holds
//   withWriteLock(<dir>/brain.db), so two agent sessions on one laptop pull one at a time: the lock's busy_timeout is
//   0, so the second retries for up to LOCK_WAIT_MS, then finds the mirror already at the run and pulls nothing.
//   A mirror is "at the run" when its meta names the run, its publish time and its commit as the store's view does
//   (sameRun): run numbers alone do not tell two servers (or two Neon branches) of one repo apart.
// - The URL and its password never reach an error message (secretsOf: the CLI's scrub cuts them out of all output).
import { existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { BrainError, LockBusyError } from '../errors.mjs';
import { withWriteLock } from '../gh-schema.mjs';
import { pullMirror, MIRROR_DB } from '../pg/mirror.mjs';

export const ENV_FILE = fileURLToPath(new URL('../../.env.local', import.meta.url));
export const LOCK_WAIT_MS = 30e3;
const RETRY_MS = 250;

/** @returns {string|null} the reader URL, or null (local mode) */
export function readerUrl(env = process.env, file = ENV_FILE) {
  if (env.BRAIN_READER_URL) return env.BRAIN_READER_URL;
  if (!existsSync(file)) return null;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?BRAIN_READER_URL\s*=\s*(.*)$/.exec(line);
    if (m) return m[1].trim().replace(/^(['"])(.*)\1$/, '$2') || null;
  }
  return null;
}

/** the URL and its passwords (user:password@ and ?password=), longest first, for scrubbing */
export function secretsOf(url) {
  const pw = [];
  try { const u = new URL(url); pw.push(decodeURIComponent(u.password), u.searchParams.get('password')); } catch { /* not a URL: the whole string is the secret */ }
  return [url, ...pw].filter((s) => s && s.length >= 4).sort((a, b) => b.length - a.length);
}

/**
 * Connect with the reader URL and refuse anything but the reader of this checkout's brain.
 * @param {string} url @param {{ origin: { owner: string, repo: string } | null }} o the checkout's origin remote
 * @returns {Promise<{ client: import('pg').Client, binding: { id: string, repo: string } }>}
 */
export async function connectReader(url, { origin }) {
  const client = new pg.Client({ connectionString: url, application_name: 'brain' });
  client.on('error', () => {});
  try {
    await client.connect();
    // session_user: the login (options=-c role=… changes current_user only); writes: any brain table; roles: SET ROLE
    const me = (await client.query(`SELECT session_user AS who, current_user AS cur, to_regclass('brain.run') IS NOT NULL AS migrated,
      EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'brain' AND c.relkind IN ('r', 'p')
        AND has_table_privilege(c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE')) AS can_write,
      EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = session_user) AS has_roles`)).rows[0];
    if (me.who !== 'brain_reader' || me.cur !== 'brain_reader') {
      throw new BrainError('not-reader', `BRAIN_READER_URL logs in as ${JSON.stringify(String(me.who))}, not brain_reader (the read-only account): refusing to use it`);
    }
    if (me.can_write || me.has_roles) {
      throw new BrainError('not-reader', `brain_reader on this server is not read-only (${me.can_write ? 'it can write brain tables' : 'it can SET ROLE to another role'}): refusing to use it — the admin runs migrate`);
    }
    if (!me.migrated) throw new BrainError('no-brain', 'the server has no brain schema yet (not migrated)');
    const b = (await client.query('SELECT source_repo_id, source_repo FROM brain.binding')).rows[0];
    if (!b) throw new BrainError('no-brain', 'the server brain has no binding yet (nothing was published)');
    const here = origin ? `${origin.owner}/${origin.repo}` : null;
    if (!here || here.toLowerCase() !== String(b.source_repo).toLowerCase()) {
      throw new BrainError('wrong-repo', `the server brain is for ${b.source_repo}, this checkout's origin is ${here ?? 'missing'}: refusing to mix them`);
    }
    return { client, binding: { id: String(b.source_repo_id), repo: b.source_repo } };
  } catch (e) {
    await client.end().catch(() => {});
    if (e instanceof BrainError) throw e;
    throw new BrainError('server', `cannot read the server brain: ${e?.message ?? e}`, { sqlstate: e?.code });   // the CLI scrubs the message
  }
}

/** the mirror a map command reads: the latest run, or one --as-of run */
export const mirrorDir = (sourceRepoId, asOf, home = homedir()) => join(home, '.cache', 'brain', 'mirror', String(sourceRepoId), asOf ? 'as-of' : 'latest');

/** Does a mirror's meta (getMeta: values parsed) hold the run a store view names? */
export const sameRun = (meta, view) => meta != null && Number(meta.brain_run) === view.run
  && meta.brain_published_at === view.publishedAt && meta.brain_run_commit === view.runCommit;

function mirrorMeta(codeDb) {
  if (!existsSync(codeDb)) return null;
  try {
    const db = new DatabaseSync(codeDb, { readOnly: true });
    try { return Object.fromEntries(db.prepare("SELECT key, value FROM meta WHERE key LIKE 'brain_%'").all().map((r) => [r.key, JSON.parse(r.value)])); }
    finally { db.close(); }
  } catch { return null; }
}

/**
 * The mirror in dir at the view's run: as it is when it holds that run (sameRun), else pulled under the dir's lock
 * (re-checked once held). A mirror of another run with the same number (another server) is pulled again in full.
 * @param {{ url: string, dir: string, view: { run: number, publishedAt: string, runCommit: string }, repo: string|null }} o
 * @returns {Promise<{ codeDb: string, pulled: boolean, bytes: number }>}
 * @throws {LockBusyError} another pull held the lock for longer than waitMs
 */
export async function ensureMirror({ url, dir, view, repo, log = () => {}, waitMs = LOCK_WAIT_MS }) {
  const codeDb = join(dir, MIRROR_DB), run = view.run;
  if (sameRun(mirrorMeta(codeDb), view)) return { codeDb, pulled: false, bytes: 0 };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + waitMs;
  for (let waited = false; ; waited = true) {
    try {
      const { value } = await withWriteLock(codeDb, async () => {
        const have = mirrorMeta(codeDb);
        if (sameRun(have, view)) return { codeDb, pulled: false, bytes: 0 };           // pulled while we waited
        if (Number(have?.brain_run) === run) rmSync(codeDb, { force: true });          // that number, another run: pullMirror would keep it
        const m = await pullMirror({ url, dir, run, shapes: ['code'], repo, log });
        return { codeDb, pulled: true, bytes: m.bytes };
      });
      return value;
    } catch (e) {
      if (!(e instanceof LockBusyError) || Date.now() >= deadline) throw e;
      if (!waited) log(`brain: another session is pulling the mirror (pid ${e.pid}); waiting up to ${Math.round(waitMs / 1000)} s`);
      await new Promise((r) => setTimeout(r, RETRY_MS));
    }
  }
}
