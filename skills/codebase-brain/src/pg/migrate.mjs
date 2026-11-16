// migration runner (Q1, design §3, §6.2). The admin runs it with the owner URL (neondb_owner); CI never holds that URL.
//   node src/pg/migrate.mjs <ownerUrl> [--password-file <file>]
// Applies sql/NNN_*.sql in name order, each once. A file runs in one transaction together with its ledger row
// (brain_migrate.applied: name, sha256 of the text) under an advisory lock, so two runners queue and a failed file leaves
// nothing behind. A file that was applied with other text is an error: an applied migration never changes.
// Passwords never live in sql/: with opts.passwordFile (JSON { "brain_writer": "...", "brain_reader": "..." }, mode
// 0600) every call sets them with ALTER ROLE ... PASSWORD after the files, so re-running with a new file rotates them.
// Neon accepts only plaintext passwords there (its control plane refuses a SCRAM verifier), so the value travels inside
// the TLS connection. Never prints a URL or a password; errors are scrubbed of both.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { BrainError } from '../errors.mjs';

const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'sql');
export const MIGRATE_LOCK_KEY = 2026111602;            // pg_advisory_xact_lock key; the publish lock is contract.PUBLISH_LOCK_KEY
export const ROLES = Object.freeze(['brain_writer', 'brain_reader']);

/** sql/NNN_name.sql files in apply order */
export const migrationFiles = () => readdirSync(SQL_DIR).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort();

function readPasswords(file) {
  const mode = statSync(file).mode & 0o777;
  if (mode & 0o077) throw new BrainError('usage', `password file must be mode 0600 (is ${mode.toString(8)})`);
  let j;
  try { j = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new BrainError('usage', 'password file is not JSON'); }
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new BrainError('usage', 'password file must be a JSON object');
  for (const [role, pw] of Object.entries(j)) {
    if (!ROLES.includes(role)) throw new BrainError('usage', `password file: unknown role ${role} (expected ${ROLES.join(', ')})`);
    if (typeof pw !== 'string' || !pw || /[\0\n\r]/.test(pw)) throw new BrainError('usage', `password file: bad password for ${role}`);
  }
  return j;
}

// What 002_roles.sql grants, and nothing more. A role that existed before (or was changed since) with more fails the run.
const WRITER_UPDATE = Object.freeze({ node_rev: ['valid_to'], item_rev: ['valid_to'], edge: ['valid_to'], unresolved: ['valid_to'],
  link: ['valid_to'], ref_link: ['valid_to'], attempt: ['status', 'stage', 'error', 'finished_at'] });
const ROLE_CHECK = `
  WITH t AS (SELECT c.oid, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'brain' AND c.relkind IN ('r', 'p', 'v', 'm'))
  SELECT r.rolname, array_remove(ARRAY[
    CASE WHEN r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls THEN 'has role attributes' END,
    (SELECT 'member of ' || string_agg(g.rolname, ', ') FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid),
    (SELECT 'table privileges ' || string_agg(t.relname || ' ' || p.p, ', ') FROM t
       CROSS JOIN unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p(p)
       WHERE has_table_privilege(r.oid, t.oid, p.p) AND NOT (r.rolname = 'brain_writer' AND p.p = 'INSERT')),
    (SELECT 'column UPDATE ' || string_agg(t.relname || '.' || a.attname, ', ') FROM t
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped
       WHERE has_column_privilege(r.oid, t.oid, a.attnum, 'UPDATE')
         AND NOT (r.rolname = 'brain_writer'
           AND a.attname::text IN (SELECT jsonb_array_elements_text(coalesce($1::jsonb -> t.relname::text, '[]'::jsonb))))),
    CASE WHEN has_database_privilege(r.oid, current_database(), 'CREATE') OR has_database_privilege(r.oid, current_database(), 'TEMP')
      THEN 'database CREATE or TEMP' END,
    CASE WHEN has_schema_privilege(r.oid, 'brain', 'CREATE') OR has_schema_privilege(r.oid, 'public', 'CREATE') THEN 'schema CREATE' END
  ], NULL) AS problems
  FROM pg_roles r WHERE r.rolname = ANY ($2::text[]) ORDER BY r.rolname`;

/**
 * @param {string} ownerUrl owner connection string (command-line argument only, design §6.2)
 * @param {{ passwordFile?: string, log?: (s: string) => void }} [opts]
 *   passwordFile: JSON { "brain_writer": "...", "brain_reader": "..." }, mode 0600
 * @returns {Promise<{ applied: string[] }>} file names applied by this call
 */
export async function migrate(ownerUrl, { passwordFile, log = () => {} } = {}) {
  if (typeof ownerUrl !== 'string' || !/^postgres(ql)?:\/\//.test(ownerUrl)) throw new BrainError('usage', 'migrate needs the owner URL (postgresql://...)');
  const secrets = [ownerUrl, safePassword(ownerUrl)];
  const scrub = (e) => {
    let msg = String(e?.message ?? e);
    for (const s of secrets.filter((x) => x && x.length >= 4).sort((a, b) => b.length - a.length)) msg = msg.split(s).join('<redacted>');
    return new BrainError(e instanceof BrainError ? e.code : 'migrate', msg, { sqlstate: e instanceof BrainError ? undefined : e?.code });
  };
  let client = null;
  const applied = [];
  try {
    const passwords = passwordFile ? readPasswords(passwordFile) : {};
    secrets.push(...Object.values(passwords));
    client = new pg.Client({ connectionString: ownerUrl });
    client.on('error', () => {});
    await client.connect();
    const tx = async (fn) => {
      await client.query('BEGIN');
      try {
        await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATE_LOCK_KEY]);
        const r = await fn();
        await client.query('COMMIT');
        return r;
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    };
    await tx(() => client.query(`CREATE SCHEMA IF NOT EXISTS brain_migrate;
      REVOKE ALL ON SCHEMA brain_migrate FROM PUBLIC;
      CREATE TABLE IF NOT EXISTS brain_migrate.applied (
        name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`));
    for (const name of migrationFiles()) {
      const text = readFileSync(join(SQL_DIR, name), 'utf8');
      const sha = createHash('sha256').update(text, 'utf8').digest('hex');
      const did = await tx(async () => {
        const row = (await client.query('SELECT sha256 FROM brain_migrate.applied WHERE name = $1', [name])).rows[0];
        if (row) {
          if (row.sha256 !== sha) throw new BrainError('migrate', `${name} was applied with different text: never edit an applied migration, add a new file`);
          return false;
        }
        await client.query(text);
        await client.query('INSERT INTO brain_migrate.applied (name, sha256) VALUES ($1, $2)', [name, sha]);
        return true;
      });
      log(did ? `applied ${name}` : `already applied ${name}`);
      if (did) applied.push(name);
    }
    // the role check, then the passwords, in one transaction under the lock: two runners queue, the passwords change
    // together, and a role with more than 002 grants fails the run before any password changes (Neon forwards role
    // changes to its control plane, so the check comes first rather than relying on the rollback)
    await tx(async () => {
      const bad = (await client.query(ROLE_CHECK, [JSON.stringify(WRITER_UPDATE), ROLES])).rows;
      if (bad.length !== ROLES.length) throw new BrainError('migrate', `roles missing: expected ${ROLES.join(', ')}`);
      const problems = bad.filter((r) => r.problems.length).map((r) => `${r.rolname}: ${r.problems.join('; ')}`);
      if (problems.length) throw new BrainError('migrate', `roles have more than sql/002_roles.sql grants (${problems.join(' | ')}): revoke it, then migrate again`);
      for (const [role, pw] of Object.entries(passwords)) {
        await client.query(`ALTER ROLE ${client.escapeIdentifier(role)} PASSWORD ${client.escapeLiteral(pw)}`);
      }
    });
    for (const role of Object.keys(passwords)) log(`password set for ${role}`);
    return { applied };
  } catch (e) {
    throw scrub(e);
  } finally {
    await client?.end().catch(() => {});
  }
}

function safePassword(url) { try { return decodeURIComponent(new URL(url).password); } catch { return null; } }

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [url, flag, file] = process.argv.slice(2);
  if (!url || (flag && (flag !== '--password-file' || !file))) {
    console.error('usage: node src/pg/migrate.mjs <ownerUrl> [--password-file <file>]');
    process.exit(2);
  }
  migrate(url, { passwordFile: file, log: (s) => console.error(s) })
    .then(({ applied }) => console.error(`done: ${applied.length} file(s) applied`))
    .catch((e) => { console.error(`migrate failed: ${e.message}`); process.exit(1); });
}
