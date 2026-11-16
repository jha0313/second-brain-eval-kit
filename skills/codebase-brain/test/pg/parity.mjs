// Map parity harness (Phase 2 design §7.2, success criterion 2). It runs the same queries through bin/brain --json on
// two code-shaped SQLite files (a local build's code.db and a mirror's brain.db) and compares the outputs. Query-only: it
// never builds or changes either file (Phase 0's test/run.mjs builds and edits its fixture, so it is not used here).
//   node test/pg/parity.mjs --a <code.db> --b <brain.db> --repo <checkout> --queries <file.json> [--out <file.json>] [--jobs N]
//   queries: a JSON array of argv arrays after `brain`, e.g. [["refs", "src/x.ts#y"], ["why", "a question"]]. Only the
//   read commands below; a query may not carry --db, --repo, --local or --json: the harness puts them first, so no option
//   of the query can take one of them as its value.
//   --help and --as-of are refused too: --help answers before either file is opened, and a map command with --as-of
//   reads the server's mirror, not --db.
//   Each command also reads <db>.github.db when it is there (the sanitizer guard): give both sides the same sidecar, or
//   none. A query that fails on both sides is `same` when the errors match; the summary line counts them (failedBoth).
//   The child's environment is PATH, HOME, TMPDIR, LANG and LC_ALL only: no reader URL, no BRAIN_DB, and no GitHub token
//   (the CLI cuts every token it is given out of its output, which could make two outputs equal). Git runs with
//   GIT_NO_LAZY_FETCH=1 and GIT_OPTIONAL_LOCKS=0 (the freshness checks never fetch or rewrite .git/index), no global or
//   system git config, and core.fsmonitor off. The checkout's own .git/config still applies (filters, for example): use
//   a checkout you would run `brain build` in.
//   --out may not name an input file.
//   The kit's own .env.local is read by the CLI even with --local (its reader secrets are cut out the same way), so the
//   harness refuses to run while that file names a reader URL.
// Normalization (§7.2): the keys `ms` and `freshness` are dropped at every depth; key order is ignored. Each query is:
//   same     equal after normalization, list order included
//   order    equal only when every list is compared as a multiset (a list whose order is not defined)
//   differs  different content or exit code; `diffs` lists what is only in a or only in b, by JSON path
// Error output is compared as text with each side's --db path replaced by <db>.
// Commit chunks: §7.2 compares only those inside Phase 0's window (the newest 5,000 commits). The harness does not filter
// them; a caller whose repo has more than 5,000 commits must leave such queries out or read their diffs with that rule.
// Exit 0 when no query differs, 1 when one does, 2 on usage. The output file holds the queries: keep it where they may be.
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, chmodSync, realpathSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const BRAIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'brain');
export const COMMANDS = new Set(['find', 'refs', 'callers', 'impact', 'deps', 'shared', 'why']);   // they read code.db only
const OWN = ['--db', '--repo', '--local', '--json', '--help', '--as-of'];
const ENV_KEEP = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'];
const DROP = new Set(['ms', 'freshness']);
const canon = (v) => JSON.stringify(v);
const byCanon = (x, y) => { const a = canon(x), b = canon(y); return a < b ? -1 : a > b ? 1 : 0; };

/** keys sorted, `ms` and `freshness` dropped, at every depth */
export function normalize(v) {
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).filter((k) => !DROP.has(k)).sort().map((k) => [k, normalize(v[k])]));
  return v;
}

/** every list as a multiset: its elements (made unordered first) sorted by their JSON */
export function unordered(v) {
  if (Array.isArray(v)) return v.map(unordered).sort(byCanon);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unordered(x)]));
  return v;
}

/** what differs between two unordered values: lists as multisets (elements only in a / only in b), objects by key */
export function diffs(a, b, path = '$', out = []) {
  if (canon(a) === canon(b)) return out;
  if (Array.isArray(a) && Array.isArray(b)) {
    const left = new Map();
    for (const x of a) left.set(canon(x), (left.get(canon(x)) ?? 0) + 1);
    const onlyB = [];
    for (const x of b) { const k = canon(x), n = left.get(k) ?? 0; if (n) left.set(k, n - 1); else onlyB.push(x); }
    const onlyA = a.filter((x) => { const k = canon(x), n = left.get(k) ?? 0; if (n) { left.set(k, n - 1); return true; } return false; });
    out.push({ path, onlyA, onlyB });
    return out;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      if (!Object.hasOwn(b, k)) out.push({ path: `${path}.${k}`, onlyA: [a[k]], onlyB: [] });
      else if (!Object.hasOwn(a, k)) out.push({ path: `${path}.${k}`, onlyA: [], onlyB: [b[k]] });
      else diffs(a[k], b[k], `${path}.${k}`, out);
    }
    return out;
  }
  out.push({ path, onlyA: [a], onlyB: [b] });
  return out;
}

/** @param {{exit, json, text}} ra @param {{exit, json, text}} rb → { class: 'same'|'order'|'differs', diffs? } */
export function compare(ra, rb) {
  if (ra.exit !== rb.exit) return { class: 'differs', diffs: [{ path: 'exit', onlyA: [ra.exit], onlyB: [rb.exit] }] };
  if ((ra.json === null) !== (rb.json === null)) return { class: 'differs', diffs: [{ path: 'output', onlyA: [ra.json ?? ra.text], onlyB: [rb.json ?? rb.text] }] };
  if (ra.json === null) return ra.text === rb.text ? { class: 'same' } : { class: 'differs', diffs: [{ path: 'text', onlyA: [ra.text], onlyB: [rb.text] }] };
  const a = normalize(ra.json), b = normalize(rb.json);
  if (canon(a) === canon(b)) return { class: 'same' };
  const ua = unordered(a), ub = unordered(b);
  if (canon(ua) === canon(ub)) return { class: 'order' };
  return { class: 'differs', diffs: diffs(ua, ub) };
}

const childEnv = () => ({ ...Object.fromEntries(ENV_KEEP.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])),
  NO_COLOR: '1', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'false' });

/** why the kit's CLI would alter what it prints (null: it would not): its .env.local names a reader URL */
export async function envFileProblem() {
  const { readerUrl, ENV_FILE } = await import('../../src/store/server.mjs');
  return readerUrl({}, ENV_FILE) ? `${ENV_FILE} names a BRAIN_READER_URL: the CLI would cut its secrets out of the outputs compared; move it away first` : null;
}

/** why a query may not run (null: it may): a read command, none of the harness's own flags */
export function badQuery(q) {
  if (!Array.isArray(q) || !q.length || !q.every((x) => typeof x === 'string')) return 'not an array of strings';
  if (!COMMANDS.has(q[0])) return `${JSON.stringify(q[0])} is not one of ${[...COMMANDS].join(', ')}`;
  const own = q.find((x) => OWN.some((f) => x === f || x.startsWith(`${f}=`)));
  return own ? `${own} is set by the harness` : null;
}
/** the child's argv: the harness's flags first, so the query's options cannot swallow them */
export const argvFor = (db, repo, q) => ['--db', db, '--repo', repo, '--local', '--json', ...q];

/** one query on one file → { exit, json, text }; text (stdout + stderr, db path replaced) only when stdout is not JSON */
export function runQuery(db, repo, argv) {
  return new Promise((done) => {
    execFile(BRAIN, argvFor(db, repo, argv), { env: childEnv(), maxBuffer: 1 << 30, timeout: 300_000 },
      (err, stdout, stderr) => {
        const exit = err ? (typeof err.code === 'number' ? err.code : String(err.signal ?? err.code)) : 0;
        let json = null;
        try { json = JSON.parse(stdout); } catch { /* not JSON: compared as text */ }
        done({ exit, json, text: json === null ? `${stdout}${stderr}`.split(db).join('<db>').trim() : null });
      });
  });
}

/** @returns {Promise<{ summary: {same, order, differs}, results: object[] }>} results in query order */
export async function parity({ a, b, repo, queries, jobs = 4 }) {
  const bad = queries.map(badQuery).findIndex(Boolean);
  if (bad >= 0) throw new Error(`query #${bad}: ${badQuery(queries[bad])}`);
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 64) throw new Error(`jobs must be 1..64, not ${jobs}`);
  const env = await envFileProblem();
  if (env) throw new Error(env);
  const results = new Array(queries.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < queries.length; i = next++) {
      const [ra, rb] = await Promise.all([runQuery(a, repo, queries[i]), runQuery(b, repo, queries[i])]);
      results[i] = { query: queries[i], exit: ra.exit, ...compare(ra, rb) };
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));
  const summary = { same: 0, order: 0, differs: 0 };
  for (const r of results) summary[r.class]++;
  return { summary, failedBoth: results.filter((r) => r.exit !== 0).length, results };
}

async function main() {
  let opt;
  try {
    opt = parseArgs({ options: { a: { type: 'string' }, b: { type: 'string' }, repo: { type: 'string' }, queries: { type: 'string' },
      out: { type: 'string' }, jobs: { type: 'string' } } }).values;
    for (const k of ['a', 'b', 'repo', 'queries']) if (!opt[k]) throw new Error(`--${k} is required`);
    for (const k of ['a', 'b', 'repo', 'queries']) if (!existsSync(opt[k])) throw new Error(`--${k}: no such file`);
    if (opt.jobs !== undefined && !/^[1-9]\d?$/.test(opt.jobs)) throw new Error('--jobs must be 1..64');
    const real = (f) => (existsSync(f) ? realpathSync(f) : resolve(f));
    if (opt.out && ['a', 'b', 'queries'].some((k) => real(opt.out) === real(opt[k]))) throw new Error('--out names an input file');
    const env = await envFileProblem();
    if (env) throw new Error(env);
  } catch (e) {
    console.error(`parity: ${e.message}\nusage: node test/pg/parity.mjs --a <code.db> --b <brain.db> --repo <checkout> --queries <file.json> [--out <file.json>] [--jobs N]`);
    process.exit(2);
  }
  let queries = null;
  try { queries = JSON.parse(readFileSync(opt.queries, 'utf8')); } catch { /* reported below */ }
  const bad = Array.isArray(queries) ? queries.map(badQuery).findIndex(Boolean) : -1;
  if (!Array.isArray(queries) || bad >= 0) {
    console.error(`parity: --queries must be a JSON array of queries${bad >= 0 ? `; #${bad}: ${badQuery(queries[bad])}` : ''}`); process.exit(2);
  }
  if (Number(opt.jobs ?? 4) > 64) { console.error('parity: --jobs must be 1..64'); process.exit(2); }
  const a = resolve(opt.a), b = resolve(opt.b), repo = resolve(opt.repo);
  const t0 = Date.now();
  const r = await parity({ a, b, repo, queries, jobs: Number(opt.jobs ?? 4) });
  if (opt.out) {
    writeFileSync(opt.out, JSON.stringify({ a, b, repo, at: new Date().toISOString(), ms: Date.now() - t0, ...r }, null, 1), { mode: 0o600 });
    chmodSync(opt.out, 0o600);                                             // an existing file keeps its mode otherwise
  }
  console.log(`parity: ${queries.length} queries: ${r.summary.same} same, ${r.summary.order} order only, ${r.summary.differs} differ; ${r.failedBoth} failed on both sides`);
  r.results.forEach((x, i) => { if (x.class !== 'same') console.log(`  #${i} ${x.class}${x.diffs ? ` at ${x.diffs.map((d) => d.path).join(', ')}` : ''}`); });
  process.exit(r.summary.differs ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
