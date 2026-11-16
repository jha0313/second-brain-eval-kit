// Fault-injection runner (Phase 3 S6, design §7 and §7.2). One Neon branch (lane A's harness) per invocation:
//   baseline: fresh schema -> suite.prepare -> suite.clean -> normalized dump B, read-back
//   each scenario: fresh schema -> suite.prepare -> scenario.fault (its own checks) -> scenario.after ?? suite.clean
//                  -> normalized dump, which must equal B ("same as if the failure had not happened"), read-back, and
//                  the server outside the brain schemas as it was before the first scenario
// "Fresh" drops schemas brain, brain_migrate and brain_test and migrates again on the same branch: cheaper than a branch
// per scenario, and only one branch is alive. Roles, their settings and database grants live outside those schemas, so
// each scenario also compares SERVER_FINGERPRINT with the one taken at the start: a scenario that leaves such state
// behind fails instead of leaking into the next one. Read-back: the latest run is pulled with pullMirror, which checks it
// against its stored checksum (the dump drops the checksum hashes of the build stamps; this catches a bad hash). The normalized dump follows contract S0 (DUMP_EXCLUDE_TABLES,
// DUMP_NATURAL_KEYS, DUMP_VOLATILE_COLUMNS, DUMP_VOLATILE_PATHS): surrogate ids become natural keys, run ids become run
// ordinals (a rolled-back transaction burns identity values), and volatile values are dropped, one canonical JSON line
// per row, sorted.
//   node test/pg/faults.mjs [suite[:scenario] ...]    (NEON_PROJECT_ID set; default: every suite)
// Output names tables, scenarios and row counts only; a mismatch prints the first differing lines (fixture data, no
// URL: the harness redacts its secrets from errors).
import * as C from '../../src/pg/contract.mjs';
import { createBranch, neonSkip, redact } from './harness.mjs';
import { beginAttempt, publish } from '../../src/pg/publish.mjs';
import { diff, applyDelta } from '../../src/pg/snapshot.mjs';
import { fixtureBuilds } from './fixture-builds.mjs';
import { pullMirror } from '../../src/pg/mirror.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Drop one contract DUMP_VOLATILE_PATHS path from v in place; '*' keeps every key at that level and drops its value. */
export function dropPath(v, [head, ...rest]) {
  if (v === null || typeof v !== 'object') return;
  for (const k of head === '*' ? Object.keys(v) : [head]) {
    if (!(k in v)) continue;
    if (rest.length) dropPath(v[k], rest);
    else if (head === '*') v[k] = null;                              // keep the key, drop the value
    else delete v[k];
  }
}

/**
 * Every domain table but DUMP_EXCLUDE_TABLES, read in one snapshot, normalized (see the header).
 * @param {import('./harness.mjs').Branch} branch @returns {Promise<{ lines: string[], raw: string }>} raw: the same rows with
 *   the surrogate ids kept (volatile values dropped too), so two dumps' raw texts differ only where their ids differ
 */
export async function normalizedDump(branch) {
  const c = await branch.connect('owner');
  const rows = {}, fks = new Map(), ids = new Map();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tables = (await c.query(`SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'brain' AND c.relkind = 'r' ORDER BY 1`)).rows.map((r) => r.t).filter((t) => !C.DUMP_EXCLUDE_TABLES.includes(t));
    for (const r of (await c.query(`SELECT cl.relname AS t, a.attname AS col, rc.relname AS ref FROM pg_constraint co
      JOIN pg_class cl ON cl.oid = co.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace JOIN pg_class rc ON rc.oid = co.confrelid
      JOIN pg_attribute a ON a.attrelid = cl.oid AND a.attnum = co.conkey[1]
      WHERE co.contype = 'f' AND n.nspname = 'brain' AND cardinality(co.conkey) = 1`)).rows) fks.set(`${r.t}.${r.col}`, r.ref);
    for (const r of (await c.query(`SELECT cl.relname AS t, a.attname AS col FROM pg_attribute a JOIN pg_class cl ON cl.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = cl.relnamespace WHERE n.nspname = 'brain' AND a.attidentity <> ''`)).rows) ids.set(r.t, r.col);
    for (const t of [...new Set([...tables, ...fks.values()])]) {
      rows[t] = (await c.query(`SELECT to_jsonb(x) AS j FROM brain.${t} x`)).rows.map((r) => r.j);
    }
    await c.query('COMMIT');
  } finally { await c.end().catch(() => {}); }

  const byId = Object.fromEntries(Object.entries(rows).map(([t, rs]) => [t, new Map(ids.has(t) ? rs.map((r) => [String(r[ids.get(t)]), r]) : [])]));
  const ordinal = new Map([...byId.run.keys()].map(Number).sort((a, b) => a - b).map((id, i) => [String(id), i + 1]));
  const memo = new Map();
  const ref = (table, id) => {                                       // the natural key of the row `id` of `table`
    if (id === null || id === undefined) return null;
    if (table === 'run') return ordinal.get(String(id)) ?? `missing run ${id}`;
    if (table === 'attempt') return undefined;                       // excluded table: the column is volatile (contract)
    const k = `${table}#${id}`;
    if (!memo.has(k)) {
      const row = byId[table]?.get(String(id));
      if (!row) throw new Error(`${table} ${id} is referenced but missing`);
      memo.set(k, natural(table, row));
    }
    return memo.get(k);
  };
  const natural = (table, row) => {
    const spec = C.DUMP_NATURAL_KEYS[table];
    if (!spec) throw new Error(`no natural key for brain.${table} (contract DUMP_NATURAL_KEYS)`);
    const key = spec.map((s) => { const col = s.split('->')[0]; return fks.has(`${table}.${col}`) ? ref(fks.get(`${table}.${col}`), row[col]) : row[col]; });
    return key.length === 1 ? key[0] : key;
  };
  const lines = [], raw = [];
  for (const t of Object.keys(rows).filter((x) => !C.DUMP_EXCLUDE_TABLES.includes(x)).sort()) {
    for (const r of rows[t]) {
      const out = {}, kept = {};
      for (const [col, v] of Object.entries(r)) {
        if ((C.DUMP_VOLATILE_COLUMNS[t] ?? []).includes(col)) continue;
        kept[col] = structuredClone(v);
        if (ids.get(t) === col) { if (t === 'run') out[col] = ordinal.get(String(v)); continue; }   // surrogate id
        out[col] = fks.has(`${t}.${col}`) ? ref(fks.get(`${t}.${col}`), v) : structuredClone(v);
      }
      for (const p of C.DUMP_VOLATILE_PATHS[t] ?? []) { dropPath(out, p); dropPath(kept, p); }
      lines.push(`${t} ${C.canonicalJson(out)}`);
      raw.push(`${t} ${C.canonicalJson(kept)}`);
    }
  }
  return { lines: lines.sort(), raw: raw.sort().join('\n') };
}

/** Server state that resetSchema does not rebuild: the brain roles (attributes, settings, memberships), the database ACL,
 * the schemas besides brain_test (harness-owned) with their ACLs, and the objects in public. */
export const SERVER_FINGERPRINT = `SELECT jsonb_build_object(
  'roles', (SELECT jsonb_agg(jsonb_build_array(rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin,
    rolreplication, rolbypassrls, rolconnlimit, rolvaliduntil) ORDER BY rolname) FROM pg_roles WHERE rolname LIKE 'brain%'),
  'members', (SELECT coalesce(jsonb_agg(jsonb_build_array(r.rolname, m.rolname) ORDER BY r.rolname, m.rolname), '[]') FROM pg_auth_members a
    JOIN pg_roles r ON r.oid = a.roleid JOIN pg_roles m ON m.oid = a.member WHERE r.rolname LIKE 'brain%' OR m.rolname LIKE 'brain%'),
  'settings', (SELECT coalesce(jsonb_agg(jsonb_build_array(r.rolname, s.setdatabase <> 0, s.setconfig) ORDER BY r.rolname, s.setdatabase), '[]')
    FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole),
  'db', (SELECT datacl::text FROM pg_database WHERE datname = current_database()),
  'schemas', (SELECT jsonb_agg(jsonb_build_array(nspname, nspacl::text) ORDER BY nspname) FROM pg_namespace
    WHERE nspname NOT LIKE 'pg\\_%' AND nspname NOT IN ('information_schema', 'brain_test')),
  'public', (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public')) AS f`;
const fingerprint = async (branch) => JSON.stringify((await branch.query('owner', SERVER_FINGERPRINT)).rows[0].f);

/** pullMirror of the latest run into a scratch dir: throws unless the server's rows read back to the run's checksum. */
async function readBack(branch) {
  const dir = mkdtempSync(join(tmpdir(), 'brain-faults-'));
  try { await pullMirror({ url: branch.readerUrl, dir: join(dir, 'm'), shapes: ['code', 'github'] }); } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Drop schemas brain, brain_migrate (its ledger) and brain_test (failOn), then migrate: an empty server again. */
export async function resetSchema(branch) {
  await branch.query('owner', 'DROP SCHEMA IF EXISTS brain_test CASCADE; DROP SCHEMA IF EXISTS brain CASCADE; DROP SCHEMA IF EXISTS brain_migrate CASCADE;');
  await branch.migrate();
}

/** Lines of a that b lacks and of b that a lacks (multisets), at most n each. */
export function dumpDiff(a, b, n = 3) {
  const count = (xs) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map());
  const ca = count(a), cb = count(b), only = (x, y) => [...x].flatMap(([k, v]) => Array(Math.max(0, v - (y.get(k) ?? 0))).fill(k));
  const gone = only(ca, cb), extra = only(cb, ca);
  return { gone: gone.length, extra: extra.length, sample: [...gone.slice(0, n).map((l) => `- ${l}`), ...extra.slice(0, n).map((l) => `+ ${l}`)] };
}

/**
 * Run a suite's scenarios on one branch. ctx = { branch, suite: <the suite's own state>, baseline } is passed to every
 * step. @param {{ name: string, setup?: (ctx) => Promise<void>, prepare: (ctx) => Promise<void>, clean: (ctx) => Promise<void>,
 *   scenarios: { name: string, fault: (ctx) => Promise<void>, after?: (ctx) => Promise<void> }[] }} suite
 * @returns {Promise<{ name: string, ok: boolean, detail: string }[]>}
 */
export async function runSuite(suite, { branch, only = null, log = (s) => console.log(s) }) {
  const ctx = { branch, suite: {}, baseline: null };
  if (suite.setup) await suite.setup(ctx);
  await resetSchema(branch);
  const server = await fingerprint(branch);
  await suite.prepare(ctx);
  await suite.clean(ctx);
  ctx.baseline = await normalizedDump(branch);
  await readBack(branch);
  log(`${suite.name}: baseline ${ctx.baseline.lines.length} rows`);
  const results = [];
  for (const s of suite.scenarios.filter((x) => !only || only.includes(x.name))) {
    const t0 = Date.now();
    let ok = false, detail = '';
    try {
      await resetSchema(branch);
      await suite.prepare(ctx);
      await s.fault(ctx);
      await (s.after ?? suite.clean)(ctx);
      const got = await normalizedDump(branch);
      const d = dumpDiff(ctx.baseline.lines, got.lines);
      if (d.gone || d.extra) throw new Error(`dump differs: ${d.gone} rows gone, ${d.extra} extra\n${d.sample.map((l) => `    ${l.slice(0, 240)}`).join('\n')}`);
      await readBack(branch);
      if (await fingerprint(branch) !== server) throw new Error('roles, grants or schemas outside brain changed: the next scenario would not start fresh');
      ok = true;
      detail = `dump = baseline (${got.lines.length} rows)`;
    } catch (e) { detail = redact(/^dump differs/.test(e?.message) ? e.message : e?.stack ?? String(e)).split('\n').slice(0, 6).join('\n'); }
    log(`  ${ok ? 'PASS' : 'FAIL'} ${suite.name}:${s.name} (${((Date.now() - t0) / 1000).toFixed(1)} s) ${detail}`);
    results.push({ name: s.name, ok, detail });
  }
  return results;
}

// ---------------------------------------------------------------------------------------------------------------------
// suites

/** Phase 2 publisher runs of the fixture builds (s1, then s2), for the round trip. */
function publisherRuns() {
  let fx, gha = 0;
  const pub = async (branch, server, next) => {
    gha += 1;
    const a = await beginAttempt({ url: branch.writerUrl, gha: { runId: 70_000 + gha, attempt: 1 }, sourceSha: next.meta.commit,
      binding: { sourceRepoId: 4242, sourceRepo: 'o/r', opsRepo: 'o/brain-ops', workflow: '.github/workflows/brain-publish.yml' } });
    const base = server && { ...server, run: a.base.run };
    const delta = diff(base, next), after = applyDelta(base, delta);
    await publish({ url: branch.writerUrl, attemptId: a.attemptId, base: a.base?.run ?? null, delta, checksum: C.checksum(after),
      mode: 'normal', commit: next.meta.commit, toolVersion: 'faults', repoDir: fx.repo });
    return after;
  };
  return {
    setup: async () => { fx ??= fixtureBuilds(); },
    prepare: async (ctx) => { ctx.suite.s1 = await pub(ctx.branch, null, fx.s1); },
    clean: async (ctx) => { await pub(ctx.branch, ctx.suite.s1, fx.s2); },
    again: async (ctx) => { await pub(ctx.branch, ctx.suite.s1, fx.s1); },   // a run with no change (runner self-test)
  };
}

/** S6: the runner itself. `empty` burns identity values between the runs, like a rolled-back publish: the raw dump
 * changes, the normalized one must not. */
const runs = publisherRuns();
export const ROUNDTRIP = {
  name: 'roundtrip',
  ...runs,
  scenarios: [{
    name: 'empty',
    fault: async (ctx) => {
      await ctx.branch.query('owner', `DO $$ DECLARE r record; BEGIN
        FOR r IN SELECT c.relname AS t, a.attname AS col FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'brain' AND a.attidentity <> '' LOOP
          PERFORM nextval(pg_get_serial_sequence(format('brain.%I', r.t), r.col)) FROM generate_series(1, 3);
        END LOOP; END $$`);
    },
    after: async (ctx) => {
      await runs.clean(ctx);
      if ((await normalizedDump(ctx.branch)).raw === ctx.baseline.raw) throw new Error('the raw dump did not change: the scenario proves nothing');
    },
  }],
};

export const SUITES = [ROUNDTRIP];

// ---------------------------------------------------------------------------------------------------------------------
// CLI

async function main(args) {
  if (neonSkip()) { console.log(`faults: ${neonSkip()}`); return 0; }
  const want = args.map((a) => a.split(':'));
  const suites = SUITES.filter((s) => !want.length || want.some(([n]) => n === s.name));
  const unknown = want.filter(([n, sc]) => !SUITES.some((s) => s.name === n && (!sc || s.scenarios.some((x) => x.name === sc))));
  if (unknown.length) {
    console.log(`faults: no such suite or scenario: ${unknown.map((w) => w.join(':')).join(' ')} (have ${SUITES.flatMap((s) => s.scenarios.map((x) => `${s.name}:${x.name}`)).join(' ')})`);
    return 2;
  }
  const branch = await createBranch('faults');
  let failed = 0;
  try {
    for (const s of suites) {
      const only = want.filter(([n, sc]) => n === s.name && sc).map(([, sc]) => sc);
      const res = await runSuite(s, { branch, only: only.length ? only : null });
      failed += res.filter((r) => !r.ok).length;
    }
  } finally { await branch.drop(); }
  console.log(failed ? `faults: ${failed} FAILED` : 'faults: all passed');
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(redact(e?.stack ?? String(e))); process.exit(1); });
}
