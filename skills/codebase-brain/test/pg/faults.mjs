// Fault-injection runner (Phase 3 S6, design §7 and §7.2). One Neon branch (lane A's harness) per invocation:
//   baseline: fresh schema -> suite.prepare -> suite.clean -> normalized dump B, read-back
//   each scenario: fresh schema -> suite.prepare -> scenario.fault (its own checks) -> scenario.after ?? suite.clean
//                  -> normalized dump, which must equal B ("same as if the failure had not happened"), read-back, and
//                  the server outside the brain schemas as it was before the first scenario
// "Fresh" drops schemas brain, brain_migrate and brain_test and migrates again on the same branch: cheaper than a branch
// per scenario, and only one branch is alive. Roles, their settings and database grants live outside those schemas, so
// each scenario also compares SERVER_FINGERPRINT with the one taken at the start: a scenario that leaves such state
// behind fails instead of leaking into the next one. Read-back: every run is pulled with pullMirror, which checks it
// against its stored checksum (the dump drops the sha256 of the checksum lines that hash build stamps; this catches a
// bad hash there). The normalized dump follows contract S0 (DUMP_EXCLUDE_TABLES,
// DUMP_NATURAL_KEYS, DUMP_VOLATILE_COLUMNS, DUMP_VOLATILE_PATHS): surrogate ids become natural keys, run ids become run
// ordinals (a rolled-back transaction burns identity values), and volatile values are dropped, one canonical JSON line
// per row, sorted.
//   node test/pg/faults.mjs [suite[:scenario] ...]    (NEON_PROJECT_ID set; default: every suite)
// Suites: roundtrip (the runner itself), ci (ci-publish F2–F15; F1 is S7's, on the sandbox), a5 (P22).
// Output names tables, scenarios and row counts only; a mismatch prints the first differing lines (fixture data, no
// URL: the harness redacts its secrets from errors).
import * as C from '../../src/pg/contract.mjs';
import { createBranch, neonSkip, redact } from './harness.mjs';
import { beginAttempt, publish } from '../../src/pg/publish.mjs';
import { diff, applyDelta } from '../../src/pg/snapshot.mjs';
import { fixtureBuilds } from './fixture-builds.mjs';
import { pullMirror } from '../../src/pg/mirror.mjs';
import { failAttempt } from '../../src/pg/publish.mjs';
import { commitProxy } from './commit-proxy.mjs';
import { SLEEPER } from '../../src/pg/ci-publish.mjs';
import { OWNER, REPO, REPO_ID, NOW, canaries, githubSecretCorpus, replayRoutes, writeReplay, setupRepo } from '../security/lib.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';

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

/** Every row of every brain table but the excluded ones (attempt), exactly as stored: ids, volatile columns and all. */
export async function exactDump(branch) {
  const c = await branch.connect('owner');
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tables = (await c.query(`SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'brain' AND c.relkind = 'r' ORDER BY 1`)).rows.map((r) => r.t).filter((t) => !C.DUMP_EXCLUDE_TABLES.includes(t));
    const out = [];
    for (const t of tables) for (const r of (await c.query(`SELECT to_jsonb(x)::text AS j FROM brain.${t} x`)).rows) out.push(`${t} ${r.j}`);
    await c.query('COMMIT');
    return out.sort();
  } finally { await c.end().catch(() => {}); }
}

/** Server state that resetSchema does not rebuild: the brain roles (attributes, memberships), every role and database
 * setting (ALTER ROLE / ALTER DATABASE ... SET; '*' = all roles), the database ACL, the schemas besides brain_test
 * (harness-owned) with their ACLs, and the objects in public. */
export const SERVER_FINGERPRINT = `SELECT jsonb_build_object(
  'roles', (SELECT jsonb_agg(jsonb_build_array(rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin,
    rolreplication, rolbypassrls, rolconnlimit, rolvaliduntil) ORDER BY rolname) FROM pg_roles WHERE rolname LIKE 'brain%'),
  'members', (SELECT coalesce(jsonb_agg(jsonb_build_array(r.rolname, m.rolname) ORDER BY r.rolname, m.rolname), '[]') FROM pg_auth_members a
    JOIN pg_roles r ON r.oid = a.roleid JOIN pg_roles m ON m.oid = a.member WHERE r.rolname LIKE 'brain%' OR m.rolname LIKE 'brain%'),
  'settings', (SELECT coalesce(jsonb_agg(jsonb_build_array(coalesce(r.rolname, '*'), s.setdatabase <> 0, s.setconfig)
    ORDER BY coalesce(r.rolname, '*'), s.setdatabase), '[]') FROM pg_db_role_setting s LEFT JOIN pg_roles r ON r.oid = s.setrole),
  'db', (SELECT datacl::text FROM pg_database WHERE datname = current_database()),
  'schemas', (SELECT jsonb_agg(jsonb_build_array(nspname, nspacl::text) ORDER BY nspname) FROM pg_namespace
    WHERE nspname NOT LIKE 'pg\\_%' AND nspname NOT IN ('information_schema', 'brain_test')),
  'public', (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public')) AS f`;
const fingerprint = async (branch) => JSON.stringify((await branch.query('owner', SERVER_FINGERPRINT)).rows[0].f);

/** pullMirror of every run in order (a full pull, then deltas): throws unless each reads back to its stored checksum. */
async function readBack(branch) {
  const runs = (await branch.query('owner', 'SELECT run_id FROM brain.run ORDER BY run_id')).rows.map((r) => Number(r.run_id));
  const dir = mkdtempSync(join(tmpdir(), 'brain-faults-'));
  try {
    for (const run of runs) await pullMirror({ url: branch.readerUrl, dir: join(dir, 'm'), run, shapes: ['code', 'github'] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
 * step. Each scenario: fresh schema -> prepare -> arrange -> fault -> after (default: the suite's clean) -> the
 * normalized dump must equal the baseline. A scenario marked `unchanged` (a failure that must write nothing but its
 * attempt row) must also leave every other row exactly as arrange left it (exactDump: ids and volatile columns kept):
 * a partial write that the clean run would later make look right still fails.
 * @param {{ name: string, setup?: (ctx) => Promise<void>, prepare: (ctx) => Promise<void>, clean: (ctx) => Promise<void>,
 *   scenarios: { name: string, unchanged?: boolean, arrange?: (ctx) => Promise<void>, fault: (ctx) => Promise<void>,
 *     after?: (ctx) => Promise<void> }[] }} suite
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
      await s.arrange?.(ctx);
      const before = s.unchanged ? await exactDump(branch) : null;
      await s.fault(ctx);
      if (before !== null) {
        const d = dumpDiff(before, await exactDump(branch));
        if (d.gone || d.extra) throw new Error(`dump differs after the fault: ${d.gone} rows gone, ${d.extra} extra (it must write nothing)\n${d.sample.map((l) => `    ${l.slice(0, 240)}`).join('\n')}`);
      }
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


// ---------------------------------------------------------------------------------------------------------------------
// ci-publish suites (S2, design §7.2 F2–F15, §7.3 P22). Every run is `node src/pg/ci-publish.mjs` as a child process,
// as in the workflow: the source is a Phase 1 fixture repo with two commits (A, then B), GitHub is the Phase 1 replay
// corpus (no network), and a fetch stub answers the two GitHub API reads ci-publish makes itself (the repo id, this
// run's created_at). prepare = a first publish at A with a fresh Actions cache; clean = a normal run at B.

const CI = fileURLToPath(new URL('../../src/pg/ci-publish.mjs', import.meta.url));
const STUB = 'data:text/javascript,' + encodeURIComponent(`const id = Number(process.env.BRAIN_TEST_REPO_ID), real = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  const s = String(u);
  if (/^https:\\/\\/api\\.github\\.com\\/repos\\/[^/]+\\/[^/]+\\/actions\\/runs\\/\\d+$/.test(s)) return new Response(JSON.stringify({ id: 1, created_at: process.env.BRAIN_TEST_CREATED_AT || null }), { status: 200 });
  if (/^https:\\/\\/api\\.github\\.com\\/repos\\/[^/]+\\/[^/]+$/.test(s)) return new Response(JSON.stringify({ id }), { status: 200 });
  return real(u, o);
};`);
let ghaRun = 80_000;

function ciFixture() {
  const fx = setupRepo();
  const a = fx.head;
  writeFileSync(join(fx.repo, 'docs-step-b.md'), '# Step B\n\nRefunds wait for the ledger.\n');
  execFileSync('git', ['-C', fx.repo, 'add', '-A'], { stdio: 'ignore' });
  execFileSync('git', ['-C', fx.repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'step B'], { stdio: 'ignore' });
  const b = execFileSync('git', ['-C', fx.repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return { repo: fx.repo, a, b, replay: writeReplay(replayRoutes(githubSecretCorpus(canaries()))) };
}

/**
 * One ci-publish run. @returns {Promise<{ status: number|null, signal: string|null, out: string, ms: number }>}
 * onLine(line, child): called for every output line (to arm the proxy, stop or signal the child at a stage boundary).
 */
async function ciRun(ctx, { sha, fault = null, faultMs = null, env = {}, args = [], url = null, cache = null, onLine = null }) {
  const fx = ctx.suite.fx;
  execFileSync('git', ['-C', fx.repo, 'checkout', '-q', '--detach', sha], { stdio: 'ignore' });
  ghaRun += 1;
  const e = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? '/tmp', NO_COLOR: '1',
    BRAIN_WRITER_URL: url ?? ctx.branch.writerUrl, BRAIN_SOURCE_REPO: `${OWNER}/${REPO}`, BRAIN_SOURCE_TOKEN: ['test', 'source', 'token'].join('-'),
    GITHUB_TOKEN: ['test', 'actions', 'token'].join('-'), GHA_RUN_ID: String(ghaRun), GHA_RUN_ATTEMPT: '1', GITHUB_REPOSITORY: `${OWNER}/brain-ops`,
    GITHUB_WORKFLOW_REF: `${OWNER}/brain-ops/.github/workflows/brain-publish.yml@refs/heads/main`, BRAIN_REPLAY_DIR: fx.replay,
    BRAIN_TEST_REPO_ID: String(REPO_ID), ...(fault && { BRAIN_FAULT_ALLOW: '1', BRAIN_FAULT: fault }), ...(faultMs && { BRAIN_FAULT_LIMIT_MS: String(faultMs) }), ...env };
  const t0 = Date.now();
  const p = spawn(process.execPath, ['--no-warnings', `--import=${STUB}`, CI, '--source', fx.repo, '--mirror', cache ?? ctx.suite.cache,
    '--work', mkdtempSync(join(tmpdir(), 'brain-ci-work-')), ...args], { env: e, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = [];
  for (const s of [p.stdout, p.stderr]) createInterface({ input: s }).on('line', (l) => { lines.push(l); onLine?.(l, p); });
  const [status, signal] = await new Promise((r) => p.on('close', (c, sg) => r([c, sg])));
  const out = lines.join('\n');
  const password = new URL(ctx.branch.writerUrl).password;
  if (out.includes(ctx.branch.writerUrl) || out.includes(password)) throw new Error('ci-publish printed the writer URL');
  return { status, signal, out, ms: Date.now() - t0 };
}

const lastAttempt = async (ctx) => (await ctx.branch.query('owner', 'SELECT status, stage, error FROM brain.attempt ORDER BY attempt_id DESC LIMIT 1')).rows[0];
const runCount = async (ctx) => Number((await ctx.branch.query('owner', 'SELECT count(*) AS n FROM brain.run')).rows[0].n);
async function lockWaiters(ctx, n) {
  for (const until = Date.now() + 60_000; Date.now() < until; await sleep(100)) {
    const r = await ctx.branch.query('owner', "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted");
    if (r.rows[0].n >= n) return;
  }
  throw new Error(`${n} sessions never waited for the publish lock`);
}
const leftoverSleepers = () => execFileSync('ps', ['-axo', 'command'], { encoding: 'utf8' }).split('\n').filter((l) => l.includes(SLEEPER)).length;

function ciRuns() {
  return {
    setup: async (ctx) => { ctx.suite.fx ??= ciFixture(); },
    prepare: async (ctx) => {
      ctx.suite.cache = join(mkdtempSync(join(tmpdir(), 'brain-ci-cache-')), 'mirror');   // a fresh Actions cache
      const r = await ciRun(ctx, { sha: ctx.suite.fx.a });
      assert.equal(r.status, 0, `prepare: ${r.out.slice(-2000)}`);
    },
    clean: async (ctx) => {
      const r = await ciRun(ctx, { sha: ctx.suite.fx.b });
      assert.equal(r.status, 0, `clean: ${r.out.slice(-2000)}`);
    },
  };
}
const none = async () => {};                                       // the fault run itself is the clean run

/** A run at B with `fault` exits 1, records attempt (stage, error) and writes nothing else. */
const failsAt = (name, fault, stage, error, { faultMs = null, check = null } = {}) => ({
  name,
  unchanged: true,
  fault: async (ctx) => {
    const r = await ciRun(ctx, { sha: ctx.suite.fx.b, fault, faultMs });
    assert.equal(r.status, 1, r.out.slice(-2000));
    assert.deepEqual(await lastAttempt(ctx), { status: 'failed', stage, error }, r.out.slice(-2000));
    assert.match(r.out, new RegExp(`brain-stage ${stage} fail `));
    await check?.(r, ctx);
  },
});

const ci = ciRuns();
export const CI_FAULTS = {
  name: 'ci',
  ...ci,
  scenarios: [
    failsAt('F2-mirror-connect', 'mirror:connect', 'mirror', 'mirror:connect'),
    { name: 'F2-mirror-checksum', after: none, fault: async (ctx) => {   // a cached mirror that is not its run: pulled again in full
      const r = await ciRun(ctx, { sha: ctx.suite.fx.b, fault: 'mirror:checksum' });
      assert.equal(r.status, 0, r.out.slice(-2000));
      assert.match(r.out, /fault mirror:checksum: one node of the cached mirror changed/);
      assert.match(r.out, /mirror at run 1 is not that run .*; pulling the full run/);
      assert.match(r.out, /published run 2\b/);
    } },
    failsAt('F3-build-fail', 'build:fail', 'build', 'build:exit'),
    failsAt('F3-T3-build-sleep', 'build:sleep', 'build', 'build:timeout', { faultMs: 2000, check: (r) => {
      assert.match(r.out, /build: over the 2s limit: SIGTERM/);
      assert.match(r.out, /build: still running 10s later: SIGKILL/);   // the build exits on SIGTERM; what it started does not
      assert.ok(r.ms < 2000 + 10_000 + 15_000, `the supervisor ended the build in time (${r.ms} ms)`);
      assert.equal(leftoverSleepers(), 0, 'no build child is left');
    } }),
    failsAt('F4-sync-http500', 'sync:http500', 'sync', 'sync:http'),
    failsAt('F5-sync-rate-limit', 'sync:rate-limit', 'sync', 'sync:rate-limit', { check: (r) => assert.match(r.out, /over the 60s limit/) }),
    failsAt('F6-outbound-secret', 'outbound:secret', 'outbound', 'outbound:outbound'),
    failsAt('F7-after-nodes', 'publish:after-nodes', 'publish', 'publish:fault'),
    failsAt('F7-after-items', 'publish:after-items', 'publish', 'publish:fault'),
    failsAt('F7-after-sync-state', 'publish:after-sync-state', 'publish', 'publish:fault'),
    failsAt('F7-after-attempt-ok', 'publish:after-attempt-ok', 'publish', 'publish:fault'),
    { name: 'F8-kill-in-transaction', unchanged: true, fault: async (ctx) => {          // the server drops the transaction; nothing records it
      const r = await ciRun(ctx, { sha: ctx.suite.fx.b, fault: 'publish:kill' });
      assert.equal(r.signal, 'SIGKILL', r.out.slice(-2000));
      assert.deepEqual(await lastAttempt(ctx), { status: 'running', stage: null, error: null });   // shown as abandoned
      assert.equal(await runCount(ctx), 1);
    } },
    failsAt('F9-drop-before-commit', 'publish:drop-before-commit', 'publish', 'publish:connect'),
    { name: 'F10-commit-reply-lost', after: none, fault: async (ctx) => {   // committed; the reply never arrives: resolved as ok
      const proxy = await commitProxy(ctx.branch.writerUrl);
      try {
        const r = await ciRun(ctx, { sha: ctx.suite.fx.b, url: proxy.url, onLine: (l) => { if (/^brain-stage publish start/.test(l)) proxy.arm('drop-reply'); } });
        assert.equal(r.status, 0, r.out.slice(-2000));
        assert.equal(proxy.commits, 1, 'the COMMIT reply was dropped');
        assert.match(r.out, /published run 2\b/);
        assert.deepEqual(await lastAttempt(ctx), { status: 'ok', stage: null, error: null });
      } finally { await proxy.close(); }
    } },
    { name: 'F11-commit-held-recovery-waits', after: none, fault: async (ctx) => {   // a recovery during a slow COMMIT waits, sees ok
      const proxy = await commitProxy(ctx.branch.writerUrl);
      let hold = null;
      try {
        const run = ciRun(ctx, { sha: ctx.suite.fx.b, url: proxy.url, onLine: (l) => { if (/^brain-stage publish start/.test(l)) hold = proxy.arm('hold'); } });
        while (!hold) await sleep(20);
        await hold.seen;
        const id = Number((await ctx.branch.query('owner', "SELECT attempt_id FROM brain.attempt WHERE status = 'running'")).rows[0].attempt_id);
        const recovery = failAttempt({ url: ctx.branch.writerUrl, attemptId: id, stage: 'publish', error: 'publish:internal' });
        await lockWaiters(ctx, 1);
        await sleep(5000 - 1000);                                    // the COMMIT is held about 5 s in all
        hold.release();
        assert.deepEqual(await recovery, { updated: false }, 'the recovery never overwrites ok');
        const r = await run;
        assert.equal(r.status, 0, r.out.slice(-2000));
        assert.deepEqual(await lastAttempt(ctx), { status: 'ok', stage: null, error: null });
      } finally { hold?.release(); await proxy.close(); }
    } },
    failsAt('F12-transaction-timeout', 'publish:sleep', 'publish', 'publish:timeout', { faultMs: 3000 }),
    { name: 'F13-cancel-sigterm', unchanged: true, fault: async (ctx) => {             // the job is cancelled while build hangs
      const r = await ciRun(ctx, { sha: ctx.suite.fx.b, fault: 'build:sleep', faultMs: 600_000,
        onLine: (l, p) => { if (/^brain-stage build start/.test(l)) setTimeout(() => p.kill('SIGTERM'), 1000); } });
      assert.equal(r.status, 1, r.out.slice(-2000));
      assert.match(r.out, /ci-publish: SIGTERM in stage build: stopping/);
      assert.match(r.out, /ci-publish: failure recorded/);
      assert.deepEqual(await lastAttempt(ctx), { status: 'failed', stage: 'build', error: 'build:signal' });
      await sleep(500);
      assert.equal(leftoverSleepers(), 0, 'the build child was killed with the job');
    } },
    { name: 'F13b-cancel-in-verify', after: none, fault: async (ctx) => {   // cancelled after COMMIT: a verify failure, exit 3
      const r = await ciRun(ctx, { sha: ctx.suite.fx.b, onLine: (l, p) => {
        if (/^brain-stage verify start/.test(l)) { p.kill('SIGSTOP'); p.kill('SIGTERM'); p.kill('SIGCONT'); }   // before verify ends
      } });
      assert.equal(r.status, 3, r.out.slice(-2000));
      assert.match(r.out, /ci-publish: SIGTERM in stage verify: stopping/);
      assert.match(r.out, /ci-publish: run 2 is committed, but verify did not finish/);
      assert.doesNotMatch(r.out, /verified: the latest run/);
      assert.deepEqual(await lastAttempt(ctx), { status: 'ok', stage: null, error: null });
      assert.equal(await runCount(ctx), 2);
    } },
    { name: 'F14-kill-after-commit', after: none, fault: async (ctx) => {   // committed; verify never ran
      const r = await ciRun(ctx, { sha: ctx.suite.fx.b, fault: 'verify:kill' });
      assert.equal(r.signal, 'SIGKILL', r.out.slice(-2000));
      assert.match(r.out, /published run 2\b/);
      assert.deepEqual(await lastAttempt(ctx), { status: 'ok', stage: null, error: null });
    } },
    { name: 'F15-base-race', after: none, fault: async (ctx) => {     // another publish commits on my base first: mine is stale
      let stopped = null;
      const mine = ciRun(ctx, { sha: ctx.suite.fx.b, onLine: (l, p) => { if (!stopped && /^brain-stage sync start/.test(l)) { p.kill('SIGSTOP'); stopped = p; } } });
      while (!stopped) await sleep(20);
      try {
        const other = await ciRun(ctx, { sha: ctx.suite.fx.b, cache: join(mkdtempSync(join(tmpdir(), 'brain-ci-cache-')), 'mirror') });
        assert.equal(other.status, 0, other.out.slice(-2000));
      } finally { stopped.kill('SIGCONT'); }
      const r = await mine;
      assert.equal(r.status, 1, r.out.slice(-2000));
      assert.match(r.out, /FAILED publish:base-moved/);
      const rows = (await ctx.branch.query('owner', 'SELECT status, error FROM brain.attempt ORDER BY attempt_id')).rows;
      assert.deepEqual(rows.slice(-2).map((x) => x.status).sort(), ['failed', 'ok']);
      assert.equal(rows.find((x) => x.status === 'failed').error, 'publish:base-moved');
      assert.equal(await runCount(ctx), 2, 'only the run that committed first is kept');
    } },
  ],
};

/**
 * P22 (A5): a run at B on a server whose latest run is B skips only when all four hold. Each run here carries the
 * mirror:connect fault, so a run that does NOT skip fails at the mirror stage and writes nothing: the server stays as
 * it was either way, and the attempt row tells which way A5 went. T on the server is the replay's Date (NOW).
 */
const later = (iso, h) => new Date(Date.parse(iso) + h * 3600e3).toISOString().replace(/\.\d+Z$/, 'Z');
const a5 = (name, { env = {}, args = [], skip }) => ({
  name,
  unchanged: true,                                                   // a skip writes only its attempt row; so does a mirror failure
  fault: async (ctx) => {
    const r = await ciRun(ctx, { sha: ctx.suite.fx.b, fault: 'mirror:connect', args, env: { BRAIN_TEST_CREATED_AT: later(NOW, -1), ...env } });
    if (skip) {
      assert.equal(r.status, 0, r.out.slice(-2000));
      assert.match(r.out, /skipped \(A5\)/);
      assert.deepEqual(await lastAttempt(ctx), { status: 'skipped', stage: null, error: null });
    } else {
      assert.equal(r.status, 1, r.out.slice(-2000));
      assert.deepEqual(await lastAttempt(ctx), { status: 'failed', stage: 'mirror', error: 'mirror:connect' }, 'it did not skip');
    }
  },
});
const setTool = (tool) => async (ctx) => {
  await ctx.branch.query('owner', `ALTER TABLE brain.run DISABLE TRIGGER refuse;
    UPDATE brain.run SET tool_version = ${tool === null ? "split_part(tool_version, '#', 1)" : `tool_version || '#${tool}'`} WHERE run_id = (SELECT max(run_id) FROM brain.run);
    ALTER TABLE brain.run ENABLE TRIGGER refuse;`);
};
export const CI_A5 = {
  name: 'a5',
  setup: ci.setup,
  prepare: async (ctx) => { await ci.prepare(ctx); await ci.clean(ctx); },   // the latest run is B
  clean: none,
  scenarios: [
    a5('P22-all-four-hold', { skip: true }),
    a5('P22a-T-before-created-at', { skip: false, env: { BRAIN_TEST_CREATED_AT: later(NOW, 1) } }),
    a5('P22-created-at-unknown', { skip: false, env: { BRAIN_TEST_CREATED_AT: '' } }),
    a5('P22b-run-attempt-2', { skip: false, env: { GHA_RUN_ATTEMPT: '2' } }),
    { ...a5('P22c-tool-version', { skip: false }), arrange: setTool('other'), after: setTool(null) },
    a5('P22d-bootstrap', { skip: false, args: ['--mode', 'bootstrap'] }),
    a5('P22-full', { skip: false, args: ['--full'] }),
  ],
};

export const SUITES = [ROUNDTRIP, CI_FAULTS, CI_A5];

// ---------------------------------------------------------------------------------------------------------------------
// CLI

async function main(args) {
  const want = args.map((a) => a.split(':'));
  const suites = SUITES.filter((s) => !want.length || want.some(([n]) => n === s.name));
  const unknown = want.filter(([n, sc]) => !SUITES.some((s) => s.name === n && (!sc || s.scenarios.some((x) => x.name === sc))));
  if (unknown.length) {
    console.log(`faults: no such suite or scenario: ${unknown.map((w) => w.join(':')).join(' ')} (have ${SUITES.flatMap((s) => s.scenarios.map((x) => `${s.name}:${x.name}`)).join(' ')})`);
    return 2;
  }
  if (neonSkip()) { console.log(`faults: ${neonSkip()}`); return 0; }
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
