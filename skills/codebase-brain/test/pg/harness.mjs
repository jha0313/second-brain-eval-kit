// Neon test harness (Q11, design §7.1): one Neon branch per suite, made copy-on-write from the project's `production`
// branch and deleted when the suite ends — in after(), and from a process exit / SIGINT / SIGTERM handler when the
// suite dies first. Each branch is also created with an expiry (BRANCH_TTL_MS) as a last safety net.
//   env NEON_PROJECT_ID           required; without it every suite that uses a branch is skipped
//       NEON_API_KEY              else read from ~/.config/neon/api-key
//       BRAIN_TEST_BRANCH_PREFIX  branch name prefix (default brain-test). At most SLOTS branches per prefix are alive
//                                 on this machine at once: node --test runs files in parallel, the Free plan allows 10
//                                 branches per project, and other lanes share them.
// Secrets (connection strings, passwords, the API key) stay in this process: never logged, never put in an assertion
// message. redact() scrubs them from text that leaves the harness (errors from the Neon CLI).
import { before, after } from 'node:test';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { migrate } from '../../src/pg/migrate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const SEED_SQL = join(here, 'golden', 'seed.sql');
export const ROLES = Object.freeze(['brain_writer', 'brain_reader']);
const PARENT = 'production', DATABASE = 'neondb', OWNER_ROLE = 'neondb_owner';
const SLOTS = 2, SLOT_WAIT_MS = 15 * 60e3, BRANCH_TTL_MS = 2 * 3600e3;
const PROJECT = process.env.NEON_PROJECT_ID || null;
const PREFIX = process.env.BRAIN_TEST_BRANCH_PREFIX || 'brain-test';

/** false when Neon suites can run, else the skip reason (for test(..., { skip })) */
export const neonSkip = () => (PROJECT ? false : 'NEON_PROJECT_ID is not set (Neon branch suites are skipped)');

// ---------------------------------------------------------------------------------------------------------------------
// secrets

const secrets = new Set();
const keep = (s) => { if (s && s.length >= 8) secrets.add(s); return s; };
/** Replace every secret this process knows with <redacted>. */
export function redact(text) {
  let out = String(text ?? '');
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) out = out.split(s).join('<redacted>');   // a URL before its password
  return out;
}

function apiKey() {
  if (process.env.NEON_API_KEY) return keep(process.env.NEON_API_KEY);
  const file = join(homedir(), '.config', 'neon', 'api-key');
  if (existsSync(file)) return keep(readFileSync(file, 'utf8').trim());
  throw new Error('no Neon API key: set NEON_API_KEY or write ~/.config/neon/api-key');
}

const neonArgs = (args) => [...args, '--project-id', PROJECT, '--no-analytics', '--no-color'];
const neonEnv = () => ({ ...process.env, NEON_API_KEY: apiKey() });
async function neon(args) {
  try { return (await promisify(execFile)('neon', neonArgs(args), { env: neonEnv(), maxBuffer: 16 << 20 })).stdout.trim(); }
  catch (e) { throw new Error(redact(`neon ${args[0]} ${args[1] ?? ''} failed: ${e.stderr || e.message}`)); }
}

/** A Neon URL as the harness hands it out: certificate verified (pg treats sslmode=require so anyway), no libpq-only params. */
function normalizeUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('the Neon CLI returned an unparsable connection string'); }   // never echo it
  u.searchParams.delete('channel_binding');
  u.searchParams.set('sslmode', 'verify-full');
  return u.toString();
}
const withRole = (url, role, password) => { const u = new URL(url); u.username = role; u.password = password; return u.toString(); };
const passwordOf = (raw) => { try { return decodeURIComponent(new URL(raw).password); } catch { return null; } };

/** An error safe to print: redacted message, the pg fields tests branch on, nothing else attached. */
export function scrubError(e) {
  const out = new Error(redact(e?.message ?? e));
  for (const k of ['code', 'severity', 'detail', 'hint', 'where', 'schema', 'table', 'column', 'constraint', 'routine']) {
    if (e?.[k] !== undefined) out[k] = typeof e[k] === 'string' ? redact(e[k]) : e[k];
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// slots: an exclusive SQLite lock per slot file; the OS releases it when the process dies

/** @returns {Promise<() => void>} release */
export async function takeSlot({ prefix = PREFIX, slots = SLOTS, waitMs = SLOT_WAIT_MS } = {}) {
  const dir = join(tmpdir(), 'brain-test-slots');
  mkdirSync(dir, { recursive: true });
  const until = Date.now() + waitMs;
  for (;;) {
    for (let i = 0; i < slots; i++) {
      const db = new DatabaseSync(join(dir, `${prefix}-${i}.lock`));
      try {
        db.exec('PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;');
        db.exec(`CREATE TABLE IF NOT EXISTS holder (pid INTEGER); DELETE FROM holder; INSERT INTO holder VALUES (${process.pid}); COMMIT;`);
        return () => db.close();                 // locking_mode EXCLUSIVE: the lock stays held until close
      } catch { db.close(); }
    }
    if (Date.now() > until) throw new Error(`no free Neon branch slot for prefix ${prefix} after ${waitMs} ms`);
    await new Promise((res) => setTimeout(res, Math.min(2000, waitMs)));
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// branches

// branch name -> { passwordDir }, from just before the create call until the branch is deleted. The exit handler deletes
// by name (the CLI takes a name or an id), so a create whose reply never arrived is deleted too.
const live = new Map();
let handlersOn = false;
const deleteSync = (name) => {
  try { execFileSync('neon', neonArgs(['branches', 'delete', name]), { env: neonEnv(), stdio: 'ignore', timeout: 60e3 }); } catch { /* the TTL deletes it */ }
};
function deleteLiveSync() {
  for (const [name, entry] of live) {
    deleteSync(name);
    if (entry.passwordDir) rmSync(entry.passwordDir, { recursive: true, force: true });
  }
  live.clear();
}
function exitHandlers() {
  if (handlersOn) return;
  handlersOn = true;
  process.on('exit', deleteLiveSync);
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) process.on(sig, () => { deleteLiveSync(); process.exit(code); });
}

/**
 * Create a branch from production and return its handle. The caller must drop() it (useBranch does it in after()).
 * The branch inherits production's owner password; the harness replaces it on the branch at once, so every URL it hands
 * out carries passwords made for this branch only.
 * @param {string} suite short name, [a-z0-9-]
 * @returns {Promise<Branch>}
 */
export async function createBranch(suite) {
  if (!PROJECT) throw new Error(neonSkip());
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(suite)) throw new Error(`bad suite name ${suite}`);
  const release = await takeSlot();
  const name = `${PREFIX}-${suite}-${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  const entry = { passwordDir: null };
  exitHandlers();
  live.set(name, entry);
  let created = false;
  try {
    const expires = new Date(Date.now() + BRANCH_TTL_MS).toISOString().replace(/\.\d+Z$/, 'Z');
    const out = JSON.parse(await neon(['branches', 'create', '--name', name, '--parent', PARENT, '--no-secrets', '--expires-at', expires, '-o', 'json']));
    created = true;
    const id = out.branch.id;
    if (out.branch.name !== name || out.branch.default) throw new Error(`unexpected branch ${out.branch.name}`);
    const cs = async (pooled) => {
      const raw = keep(await neon(['connection-string', id, '--role-name', OWNER_ROLE, '--database-name', DATABASE, ...(pooled ? ['--pooled'] : [])]));
      keep(passwordOf(raw));
      return normalizeUrl(raw);
    };
    const inherited = await cs(false), inheritedPooled = await cs(true);
    const passwords = Object.fromEntries([OWNER_ROLE, ...ROLES].map((r) => [r, keep(randomBytes(24).toString('base64url'))]));
    const c = new pg.Client({ connectionString: inherited });
    c.on('error', () => {});
    try {
      await c.connect();
      await c.query(`ALTER ROLE ${OWNER_ROLE} PASSWORD ${c.escapeLiteral(passwords[OWNER_ROLE])}`);   // this branch only
    } finally { await c.end().catch(() => {}); }
    entry.passwordDir = mkdtempSync(join(tmpdir(), 'brain-test-pw-'));
    const passwordFile = join(entry.passwordDir, 'passwords.json');
    writeFileSync(passwordFile, JSON.stringify(Object.fromEntries(ROLES.map((r) => [r, passwords[r]]))), { mode: 0o600 });
    const ownerUrl = keep(withRole(inherited, OWNER_ROLE, passwords[OWNER_ROLE]));
    const ownerPooledUrl = keep(withRole(inheritedPooled, OWNER_ROLE, passwords[OWNER_ROLE]));
    const urls = {
      owner: ownerUrl, ownerPooled: ownerPooledUrl,
      writer: keep(withRole(ownerUrl, 'brain_writer', passwords.brain_writer)),          // direct endpoint (§5.3)
      reader: keep(withRole(ownerPooledUrl, 'brain_reader', passwords.brain_reader)),    // pooled endpoint (§5.3)
      readerDirect: keep(withRole(ownerUrl, 'brain_reader', passwords.brain_reader)),
    };
    return new Branch({ id, name, urls, passwordFile, passwordDir: entry.passwordDir, release });
  } catch (e) {
    // a failed create leaves nothing; anything else must be deleted before the slot is given back
    const gone = await neon(['branches', 'delete', name]).then(() => true, () => !created);
    if (gone) {
      live.delete(name);
      if (entry.passwordDir) rmSync(entry.passwordDir, { recursive: true, force: true });
      release();
    }
    throw scrubError(e);
  }
}

/**
 * node:test helper: a branch for the whole file, created in before() and deleted in after(). The returned object is
 * empty until before() ran; with NEON_PROJECT_ID unset nothing is created (mark the tests with { skip: neonSkip() }).
 * @param {string} suite @returns {Branch}
 */
export function useBranch(suite) {
  const handle = Object.create(Branch.prototype);
  if (!PROJECT) return handle;
  before(async () => { Object.assign(handle, await createBranch(suite)); });
  after(async () => { await handle.drop?.(); });
  return handle;
}

export class Branch {
  constructor({ id, name, urls, passwordFile, passwordDir, release }) {
    Object.assign(this, { id, name, urls, passwordFile });
    this.ownerUrl = urls.owner; this.writerUrl = urls.writer; this.readerUrl = urls.reader;
    this.passwordDir = passwordDir; this.release = release;
  }

  /** @param {keyof Branch['urls']} who @returns {Promise<pg.Client>} connected */
  async connect(who = 'owner') {
    const url = this.urls[who];
    if (!url) throw new Error(`no url for ${who}`);
    const c = new pg.Client({ connectionString: url });
    c.on('error', () => {});                     // a cut connection (proxy tests) must not crash the process
    try { await c.connect(); } catch (e) { throw scrubError(e); }
    return c;
  }

  /** One query on a fresh connection; errors come back scrubbed (scrubError). */
  async query(who, sql, params) {
    const c = await this.connect(who);
    try { return await c.query(sql, params); } catch (e) { throw scrubError(e); } finally { await c.end().catch(() => {}); }
  }

  /** Run a SQL file (simple protocol, may hold several statements and its own BEGIN / COMMIT) as the owner. */
  async runSql(file) { await this.query('owner', readFileSync(file, 'utf8')); }

  /** sql/*.sql via migrate(), with this branch's writer / reader passwords. */
  async migrate() { return migrate(this.ownerUrl, { passwordFile: this.passwordFile }); }

  /** The golden state as run 1 (test/pg/golden/seed.sql); needs migrate() first. */
  async seed() { await this.runSql(SEED_SQL); }

  /**
   * The domain dump for "그대로" (design §7.1): every row and every column of every table in schema brain, history
   * included, except attempt. One line per row: `<table> <to_jsonb(row)>`, tables by name, rows by primary key.
   * @returns {Promise<string>}
   */
  async dump() {
    const c = await this.connect('owner');
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');      // one snapshot for every table
      const tables = (await c.query(`
        SELECT c.relname AS name,
               (SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY k.ord)
                  FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum) AS pk
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_index i ON i.indrelid = c.oid AND i.indisprimary
        WHERE n.nspname = 'brain' AND c.relkind = 'r' AND c.relname <> 'attempt'
        ORDER BY c.relname COLLATE "C"`)).rows;
      const out = [];
      for (const { name, pk } of tables) {
        if (!pk) throw new Error(`brain.${name} has no primary key: the dump needs a stable order`);
        const rows = (await c.query(`SELECT to_jsonb(t)::text AS j FROM brain.${pg.escapeIdentifier(name)} t ORDER BY ${pk}`)).rows;
        for (const r of rows) out.push(`${name} ${r.j}`);
      }
      await c.query('COMMIT');
      return out.join('\n');
    } catch (e) { throw scrubError(e); } finally { await c.end().catch(() => {}); }
  }

  /**
   * Failure injection in the database: from the (after + 1)-th `op` row on brain.<table> in one transaction, raise
   * 'brain_test: injected failure' (SQLSTATE P0001). Lives in schema brain_test; clearFailures() removes it.
   * @param {string} table @param {{ op?: 'INSERT'|'UPDATE', after?: number }} [opts]
   */
  async failOn(table, { op = 'INSERT', after = 0 } = {}) {
    if (!/^[a-z_]+$/.test(table) || !['INSERT', 'UPDATE'].includes(op) || !Number.isInteger(after) || after < 0) throw new Error('bad failOn');
    await this.query('owner', `
      CREATE SCHEMA IF NOT EXISTS brain_test;
      CREATE OR REPLACE FUNCTION brain_test.fail() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        k text := 'brain_test.n_' || TG_TABLE_NAME || '_' || lower(TG_OP);
        n int := coalesce(nullif(pg_catalog.current_setting(k, true), ''), '0')::int + 1;
      BEGIN
        PERFORM pg_catalog.set_config(k, n::text, true);
        IF n > TG_ARGV[0]::int THEN
          RAISE EXCEPTION 'brain_test: injected failure on brain.% %', TG_TABLE_NAME, TG_OP USING ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
      END $$;
      DROP TRIGGER IF EXISTS zz_brain_test_fail_${op.toLowerCase()} ON brain.${table};
      CREATE TRIGGER zz_brain_test_fail_${op.toLowerCase()} BEFORE ${op} ON brain.${table}
        FOR EACH ROW EXECUTE FUNCTION brain_test.fail('${after}');`);
  }

  /** Remove every failOn trigger and schema brain_test. */
  async clearFailures() {
    await this.query('owner', `
      DO $$ DECLARE r record; BEGIN
        FOR r IN SELECT t.tgname, c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                 JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'brain' AND t.tgname LIKE 'zz_brain_test_fail_%' LOOP
          EXECUTE format('DROP TRIGGER %I ON brain.%I', r.tgname, r.relname);
        END LOOP;
      END $$;
      DROP SCHEMA IF EXISTS brain_test CASCADE;`);
  }

  /** Delete the branch (idempotent), then release its slot. A failed delete keeps the slot; the exit handler retries. */
  async drop() {
    if (!this.name || !live.has(this.name)) return;
    await neon(['branches', 'delete', this.id]);
    live.delete(this.name);
    rmSync(this.passwordDir, { recursive: true, force: true });
    this.release();
  }
}

/** Is a branch with this id or name still listed in the project? (tests check that cleanup really deleted it) */
export async function branchExists(idOrName) {
  const list = JSON.parse(await neon(['branches', 'list', '-o', 'json']));
  return (list.branches ?? list).some((b) => b.id === idOrName || b.name === idOrName);
}
