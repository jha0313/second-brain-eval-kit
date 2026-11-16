// Throwaway Neon branch for lane B's tests, until lane A's harness (test/pg/harness.mjs) is merged into this lane. One
// branch per test file, made from `production` and always deleted. Same environment as lane A's harness and
// ci/brain-test.yml: NEON_PROJECT_ID (the test project id; never written in a file), BRAIN_TEST_BRANCH_PREFIX (optional
// name prefix) and a Neon API key (NEON_API_KEY or ~/.config/neon/api-key). Connection strings, the API key and the
// writer password live in memory only: never printed, logged or written to disk; errors name the step, not the output.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

const SQL = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'sql');

/** null when this machine cannot reach Neon for tests (the suite then skips) */
export function neonEnv() {
  const project = process.env.NEON_PROJECT_ID;
  const keyFile = join(homedir(), '.config', 'neon', 'api-key');
  const key = process.env.NEON_API_KEY || (existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : '');
  return project && key ? { project, key } : null;
}

function neon(env, args, step) {
  try {
    return execFileSync('neon', [...args, '--project-id', env.project], {
      env: { ...process.env, NEON_API_KEY: env.key }, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 120_000,
    });
  } catch { throw new Error(`neon ${step} failed`); }                // the CLI output may hold a connection string
}

export async function sql(url, text, params = []) {
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 30_000 });
  c.on('error', () => {});
  await c.connect();
  try { return await c.query(text, params); } finally { await c.end().catch(() => {}); }
}

/**
 * @param {string} prefix branch name prefix (a random suffix is added)
 * @returns {Promise<{ name: string, ownerUrl: string, writerUrl: string, reset(): Promise<void>, drop(): void }>}
 */
export async function createBranch(prefix) {
  const env = neonEnv();
  if (!env) throw new Error('no Neon test environment');
  const name = `${process.env.BRAIN_TEST_BRANCH_PREFIX || prefix}-${randomBytes(3).toString('hex')}`;
  let dropped = false;
  const drop = () => {
    if (dropped) return;
    neon(env, ['branches', 'delete', name], 'branch delete');
    dropped = true;                                                  // only after it worked: a later call tries again
  };
  try {
    // a create whose reply is lost (timeout) may still have made the branch: the catch below deletes it by name
    neon(env, ['branches', 'create', '--name', name, '--parent', 'production', '--output', 'json'], 'branch create');
    const owner = new URL(neon(env, ['connection-string', name, '--role-name', 'neondb_owner', '--database-name', 'neondb'], 'connection-string').trim());
    if (!/^postgres(ql)?:$/.test(owner.protocol)) throw new Error('neon connection-string gave no URL');
    owner.searchParams.set('sslmode', 'verify-full');                 // what pg does for 'require' today, without its warning
    const ownerUrl = owner.toString();
    const password = randomBytes(24).toString('hex');
    const writer = new URL(ownerUrl);
    writer.username = 'brain_writer';
    writer.password = password;
    const reset = async () => {
      await sql(ownerUrl, `DROP SCHEMA IF EXISTS brain CASCADE; BEGIN; ${readFileSync(join(SQL, '001_init.sql'), 'utf8')}; COMMIT;
        BEGIN; ${readFileSync(join(SQL, '002_roles.sql'), 'utf8')}; COMMIT;`);
      await sql(ownerUrl, `ALTER ROLE brain_writer PASSWORD '${password}'`);   // hex only; this branch only
    };
    return { name, ownerUrl, writerUrl: writer.toString(), reset, drop };
  } catch (e) {
    try { drop(); } catch { /* no such branch (the create failed), or the delete failed: the error below is the first one */ }
    throw e;
  }
}
