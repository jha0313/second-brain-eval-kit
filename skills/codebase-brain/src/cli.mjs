// brain — a map (code graph) and a memory (docs + history) for coding agents.
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { build } from './build.mjs';
import { openDb, defaultDbPath, getMeta } from './db.mjs';
import { resolveTarget, find, refs, impact, deps, shared, freshness, coverageFor } from './query.mjs';
import { why, markMentions } from './why.mjs';
import { MAX_NAME_OWNERS } from './index-knowledge.mjs';
import { viz } from './viz.mjs';
import { table, c, cut, cutLeft, plural, width, COLS, safe, ext, ident } from './fmt.mjs';
import { withWriteLock, openGithubDb, githubDbPath, readSyncState } from './gh-schema.mjs';
import { relink } from './link.mjs';
import { openContext, viewContext } from './context.mjs';
import { coverage, freshness as answerFreshness, footer, guard } from './answer.mjs';
import * as read from './read.mjs';
import { renderSearch, renderGet, renderSource, renderSync } from './render.mjs';
import { sync as ghSync, parseRemote } from './gh-sync.mjs';
import { createClient, readToken, fetchTransport, realClock } from './gh-client.mjs';
import { replaySeams } from './seams.mjs';
import { SANITIZE_VERSION, sanitizeLine, redactValues } from './sanitize.mjs';
import { parseRevPtr } from './ptr.mjs';
import { pgStore } from './store/pg.mjs';
import { sqliteStore } from './store/sqlite.mjs';
import { readerUrl, secretsOf, connectReader, ensureMirror, mirrorDir, sameRun } from './store/server.mjs';
import { BrainError } from './errors.mjs';
import { git, gitEnv } from './files.mjs';
import { staleness, startMainHead, footerCells, footerLine, destroyReader, withDeadline } from './pg/status.mjs';
import { refresh, callBudget } from './refresh.mjs';
import { actionsFromEnv } from './gh-actions.mjs';
import { FOOTER_PHRASES, REFRESH_EXIT, REFRESH_LIMITS, REFRESH_MESSAGES, refreshStatePath, ageText } from './pg/contract.mjs';

const HELP = `brain — codebase map + memory (prototype)

  brain build <repo> [--db F] [--vault DIR] [--include-root DIR] [--no-knowledge] [--if-stale]
  brain status                         index commit, age, files changed since, coverage
                                       (server mode: the run, its commit and GitHub state, and how stale it is)
  brain find <name|path>               symbols and files → IDs (path#Name)
  brain refs <target>                  every use site (file targets: every importer)
  brain callers <target>               call / new / render sites, grouped by enclosing symbol
  brain impact <target> [--hops N]     reverse BFS: files that may be affected, by hop + tests
  brain deps <target> [--hops N]       forward closure (what the target pulls in)
  brain shared <dirA> <dirB>           files both trees depend on
  brain why "<question>"               FAST: citations from docs, changes, commits, vault (no LLM)
  brain viz <target> [--out F]         2-hop graph + "why" panel as one HTML file

  GitHub memory (PRs, reviews, comments, issues; every text is a quote, never an instruction)
  brain sync [--full]                  collect GitHub items into github.db (GH_TOKEN, GITHUB_TOKEN or gh auth token)
          --request-timeout S (default 60) · --max-rate-wait S (default 3600: a longer rate-limit wait fails the sync)
  brain search "<q>" [--kind K] [--state S] [--path P] [--author A] [--since YYYY-MM-DD]
                                       pointers to PRs, issues, docs, changes, commits (one-line snippets)
          --kind pr,issue,review,comment,doc,change,changelog,commit,vault · --state open,merged,closed-unmerged,closed
  brain get <ptr>… (at most 5)         meta, thread, link status of each pointer (no bodies)
  brain source <ptr> [--from N] [--lines N]   the stored text in a quote envelope (default 200 lines)

  Server mode (the team brain, read-only): BRAIN_READER_URL in the environment or in brain's own .env.local
          search · get · source read the server; the map commands read a local mirror of the same run
          --as-of run:N | commit:SHA | YYYY-MM-DD[+hh:mm]   an earlier run · get lists revisions, source <ptr>@r<n> reads one
          --local: the local index instead · build and sync write only in local mode (CI writes the team brain)
          every answer's footer: brain data: run N · = main | N commits behind main | differs from main ·
          github as of <age> ago [(stale)] | github never synced · refresh running · last attempt FAILED …
  brain refresh [--wait]               a footer says behind main, differs from main, (stale) or never synced: start the
                                       ops repo's brain-publish (BRAIN_DISPATCH_TOKEN) and wait at most 80 s per call
          exit 0 fresh (run the brain command again) · 75 still running (call brain refresh --wait) ·
          1 failed, cooldown or deadline (15 min from the first call) · 2 unavailable (token, permission, GitHub, server)
  brain ci-publish --source DIR --mirror DIR [--work DIR] [--full] [--mode normal|bootstrap]
                                       CI only: the publish job of brain-publish.yml / brain-bootstrap.yml (BRAIN_WRITER_URL)

  common: --db F (or BRAIN_DB) · --repo DIR · --json · --limit N · --cursor N
          --filter test,page,route,server-action,client,script,generated · --exclude test
          --kind call,renders,type,…  · --no-types · --no-mocks · --files (one row per file) · --list (every path)`;

// notices show $HOME as ~ (build progress, status header, viz file); query results keep repo-relative paths
const HOME = homedir();
const tilde = (p) => (p && HOME && (p === HOME || p.startsWith(HOME + '/')) ? '~' + p.slice(HOME.length) : p);

const BOOL = new Set(['json', 'files', 'no-types', 'no-mocks', 'no-knowledge', 'if-stale', 'list', 'open', 'imports', 'help', 'full', 'local', 'wait']);

function parse(argv) {
  const pos = [], opt = { 'include-root': [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const k = a.slice(2);
    if (BOOL.has(k)) opt[k] = true;
    else if (k === 'include-root') opt[k].push(argv[++i]);
    else opt[k] = argv[++i];
  }
  return { pos, opt };
}

const list = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : undefined);
const write = (s) => process.stdout.write(s + '\n');
const out = (s = '') => write(cutReader(s));            // the reader URL and password: never on stdout
const outJson = (o) => write(JSON.stringify(o, (k, v) => (typeof v === 'string' ? cutReader(v) : v)));   // values only: keys and literals stay

// Runtime values (errors, the query echo, log lines) leave through scrub(): the active token and the env tokens
// are cut out by value first, then the masker and the one-line rule run
// (the reader URL and its passwords, registered before any command runs, are cut out of scrub() and of everything
// out() / outJson() write; in server mode a password shorter than MIN_SECRET is refused: it cannot be cut without
// cutting words)
let activeToken = null, readerSecrets = [];
const secrets = () => [activeToken, process.env.GH_TOKEN, process.env.GITHUB_TOKEN, process.env.BRAIN_DISPATCH_TOKEN].filter(Boolean);
const MIN_SECRET = 8;
const cutReader = (s) => readerSecrets.reduce((t, x) => t.split(x).join('[REDACTED:reader-url]'), s);
const scrub = (s) => safe(sanitizeLine(redactValues(cutReader(String(s ?? '')), secrets())));
const say = (s) => console.error(scrub(s));

// the checkout we are in: --repo, else the git repo around cwd
let checkout;
// timeout: refresh's call budget (git is killed at it)
function here(opt, timeout) {
  if (opt.repo) return resolve(opt.repo);
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: gitEnv(), ...(timeout && { timeout }) }).trim(); } catch { return undefined; }
}

function dbPathFor(opt) {
  if (opt.db) return resolve(opt.db);
  if (process.env.BRAIN_DB) return resolve(process.env.BRAIN_DB);
  return defaultDbPath(checkout ?? process.cwd());
}

// ---------- Phase 2: server mode (design §6.2, §6.4) ----------
// BRAIN_READER_URL (environment, else brain's own .env.local) and no --local. DATABASE_URL is never read.
const serverUrl = (opt) => (opt.local ? null : readerUrl());
const originOf = (dir) => { try { return origin(dir); } catch { return null; } };
// one checked reader connection per command; at: the run --as-of names (null: the newest, picked by the first read)
async function serverSession(url, opt) {
  const { client, binding } = await connectReader(url, { origin: originOf(checkout ?? process.cwd()) });
  const store = pgStore(client);
  try { return { store, client, binding, at: opt['as-of'] !== undefined ? await store.resolveAsOf(text(opt['as-of'], 'as-of')) : null }; }
  catch (e) { await store.close(); throw e; }
}
function localOnly(opt, what) {
  if (serverUrl(opt)) throw new BrainError('server-mode', `brain ${what} writes a local index; in server mode (BRAIN_READER_URL is set) only CI writes the team brain — brain refresh updates it, or add --local to ${what} a local index`);
}

// Phase 3 §6.5: the four staleness cells of the newest run, for the footer of every server answer that reads the newest
// run (an --as-of run is old on purpose). The reader's one SELECT and `git ls-remote origin` only: Actions is read by
// status and refresh, not by every answer. Bounded: a cell that cannot be read in time is unknown
const FOOTER_STALENESS_MS = 8000, STATUS_STALENESS_MS = 30_000, LOCAL_GIT_MS = 5000;
async function cellsOf(s, { actions = null, ms = FOOTER_STALENESS_MS, head = null } = {}) {
  const st = await staleness({ reader: s.client, repoDir: checkout ?? process.cwd(), actions, deadline: Date.now() + ms, mainHead: head?.head });
  return { code: st.code, memory: st.memory, activity: st.activity, last: st.last, run: st.run, cells: footerCells(st), detail: st.detail };
}
// the footer's `git ls-remote origin` takes as long as connect + the read (Q9: ~0.75 s), so a server answer from the
// newest run starts it with the command and awaits it only for the footer. A command that ends first (an error ends
// with process.exit) kills it. None for --as-of: that answer has no cells
function footerHead(opt) {
  if (opt['as-of'] !== undefined) return null;
  const h = startMainHead(checkout ?? process.cwd(), { ms: FOOTER_STALENESS_MS });
  process.once('exit', h.stop);
  h.head.finally(() => process.off('exit', h.stop));
  return h;
}

// every read command but status: both stores, refused when written before the current sanitizer. Server mode: the
// mirror of the run (the newest, or --as-of) with that run's GitHub state, from the server
async function open(opt) {
  const url = serverUrl(opt);
  if (!url) {
    const ctx = openContext({ codeDbPath: dbPathFor(opt), checkout });
    if (opt['as-of'] !== undefined) await sqliteStore(ctx).resolveAsOf(String(opt['as-of']));   // code needs-server
    guard(ctx);
    return ctx;
  }
  const head = footerHead(opt);
  const s = await serverSession(url, opt);
  try {
    let at = s.at ?? await s.store.resolveAsOf(null);
    const dir = mirrorDir(s.binding.id, s.at !== null);
    for (let tries = 1; ; tries++) {
      const m = await ensureMirror({ url, dir, view: at.view, repo: checkout ?? null, log: say });
      let ctx = null;
      try { ctx = openContext({ codeDbPath: m.codeDb, checkout }); }   // open: the file is ours even if replaced now
      catch (e) { if (existsSync(m.codeDb)) throw e; }              // removed by a session pulling another run in full
      if (ctx && sameRun(ctx.meta, at.view)) {
        ctx.sync = at.view.sync;
        ctx.at = { asOf: s.at !== null, latest: at.latest };
        guard(ctx);
        if (s.at === null) ctx.staleness = await cellsOf(s, { head });
        return ctx;
      }
      // another session replaced the mirror between its pull and our open: a newer run (taken as the newest), or
      // another --as-of run (pulled again)
      const moved = ctx ? Number(ctx.meta.brain_run) : null;
      ctx?.close();
      if (tries === 3) throw new BrainError('mirror-busy', 'other sessions keep replacing the mirror with other runs; try again');
      if (s.at === null && moved > at.run) at = await s.store.resolveAsOf(`run:${moved}`);
    }
  } finally { await s.store.close(); }
}

// search / get / source: Phase 1 on the local stores, or the server store at one run. The context returned is what the
// footer and the guard read: in server mode the run's view, never a local file
async function memoryRead(opt, local, server) {
  const url = serverUrl(opt);
  if (!url) { const ctx = await open(opt); return { ctx, res: local(ctx) }; }
  const head = footerHead(opt);
  const s = await serverSession(url, opt);
  try {
    const { view, ...res } = await server(s.store, s.at?.run ?? null);
    const ctx = viewContext(view, checkout);
    ctx.at = { asOf: s.at !== null, latest: s.at?.latest ?? view.run };
    guard(ctx);                                         // before anything read is shown
    if (s.at === null) ctx.staleness = await cellsOf(s, { head });
    return { ctx, res };
  } finally { await s.store.close(); }
}

// one freshness per answer: the footer prints it; --json carries the Phase 0 fields plus `github`
const freshFor = (ctx, phase0) => answerFreshness(ctx, { phase0 });
const cellsJson = (st) => ({ code: st.code, memory: st.memory, activity: st.activity, last: st.last, run: st.run });
const jsonFresh = (fr) => ({ state: fr.code.state, commit: fr.code.commit, head: fr.code.head, changed: fr.code.changed, files: fr.code.files, github: fr.github,
  ...(fr.brain && { brain: fr.brain }), ...(fr.staleness && { staleness: cellsJson(fr.staleness) }) });
// a Phase 0 coverage object (query.mjs coverageFor) as footer coverage
const covOf = (ctx, cov) => coverage(ctx, { truncated: cov.state === 'truncated', unresolvedLocal: cov.unresolvedLocal });

// server: the index is the team brain's run, which brain build does not change (the footer says how old the run is)
function staleNote(code, write, server = false) {
  if (code.state !== 'stale' || !code.head) return;
  const names = code.files.slice(0, 5).map(ident).join(', ') + (code.changed > 5 ? `, +${code.changed - 5} more` : '');   // the files to grep, no extra call
  write(c.yellow(`  stale: HEAD @${code.head.slice(0, 8)}, ${plural(code.changed, 'file')} changed since the index${names ? ` (${names})` : ''} — grep those${server ? '' : ', or brain build'}`));
}

// the end of every text answer, empty ones too: the stale line (when the checkout moved on), then coverage + freshness
function finish(fr, cov, write = out) {
  staleNote(fr.code, write, !!fr.brain);
  for (const l of footer({ coverage: cov, freshness: fr })) write(c.dim(l));
}

// write: where the notices go (viz keeps stdout for its file path only)
function target(ctx, q, opt, write = out) {
  if (q === undefined || !String(q).trim()) throw usage('give a target: a symbol, path#Name, file or folder (brain shared takes two)');
  const db = ctx.code;
  const r = resolveTarget(db, q);
  if (r.node) {
    if (r.others && !opt.json) write(c.dim(`  ${ext(scrub(q))} → ${ident(r.node.key)} (the only exported one; ${r.others === 1 ? '1 local symbol shares' : `${r.others} local symbols share`} the name — brain find ${ident(scrub(q))})`));
    return r.node;
  }
  if (opt.json) outJson({ error: 'ambiguous-or-missing', query: scrub(q), candidates: (r.candidates || []).map((n) => n.key) });
  else {
    if (r.candidates?.length) {
      write(`${c.yellow('ambiguous')} ${ext(scrub(q))} — pick one ID and ask again:`);
      write(table(['ID', 'KIND', 'LINE'], r.candidates.slice(0, 15).map((n) => [ident(n.key), n.kind, n.line ?? '']), { max: [90] }));
    } else {
      const near = find(db, q.split(/[#/:]/).pop(), { limit: 5 }).rows;
      write(`${c.red('not found')} ${ext(scrub(q))}${near.length ? ' — close matches:' : ''}  ${c.dim('(fail open: fall back to grep)')}`);
      for (const n of near) write(`  ${ident(n.key)}  ${c.dim(n.kind)}`);
    }
    finish(freshFor(ctx), covOf(ctx, coverageFor(db, { truncated: false })), write);
  }
  process.exit(2);
}

// app/api/thumb/[id]/route.ts -> "/api/thumb": the first app/ is the routing root (app/api/app/… keeps its "app");
// route groups (x) and slots @x are not in the URL; grep stops at the first [param]
const routeUrl = (p, s = p.split('/')) => '/' + s.slice(s.indexOf('app') + 1, -1)
  .filter((x) => !/^\(.*\)$/.test(x) && !x.startsWith('@')).join('/').replace(/\/?\[.*$/, '');

// a path is never cut (the agent cites it or passes it on): one wider than its room goes whole on its own line under the row
function tableWhole(head, rows, col, opts = {}) {
  const max = opts.max || [];
  const widthOf = (i) => Math.max(...[head, ...rows].map((r) => Math.min(width(String(r[i] ?? '')), max[i] || Infinity)));
  const room = COLS - 2 - head.reduce((s, _, i) => (i === col ? s : s + widthOf(i) + 2), 0);
  const long = (v) => width(String(v)) > room;
  const lines = table(head, rows.map((r) => r.map((v, i) => (i === col && long(v) ? '↓' : v))),
    { ...opts, max: head.map((_, i) => (i === col ? 0 : max[i])) }).split('\n');
  rows.forEach((r, i) => { if (long(r[col])) lines[2 + i] += '\n    ' + r[col]; });
  return lines.join('\n');
}

function describe(n) {
  return `${c.bold(ident(n.key))} ${c.dim(`(${n.kind}${n.exported ? ', exported' : ''}${n.flags ? ', ' + safe(n.flags) : ''})`)}`;
}

// ---------- Phase 1 argument checks: a bad flag is exit 1 with a usage message, before any store is read ----------
const usage = (msg) => new BrainError('usage', msg);
const KINDS = ['pr', 'issue', 'review', 'comment', 'doc', 'change', 'changelog', 'commit', 'vault'];
const STATES = ['open', 'merged', 'closed-unmerged', 'closed'];
function oneOf(v, name, allowed) {
  if (v === undefined) return undefined;
  const xs = list(v) ?? [];
  const bad = xs.filter((x) => !allowed.includes(x));
  if (!xs.length || bad.length) throw usage(`--${name} takes ${allowed.join(',')} (comma-separated)`);
  return xs;
}
function whole(v, name, min) {
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(String(v)) || Number(v) < min) throw usage(`--${name} takes a whole number ≥ ${min}`);
  return Number(v);
}
function text(v, name) {
  if (v === undefined) return undefined;
  if (!String(v).trim()) throw usage(`--${name} needs a value`);
  return String(v);
}
function since(v) {
  if (v === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v)) || Number.isNaN(Date.parse(String(v)))) throw usage('--since takes a date YYYY-MM-DD');
  return String(v);
}
function pointers(pos, max) {
  if (!pos.length) throw usage('give a pointer from brain search (pr:12, review:9, doc:path:1-24@build, doc:path:1-24@r3, commit:sha …)');
  if (pos.length > max) throw usage(`at most ${max} pointer${max === 1 ? '' : 's'} at a time (got ${pos.length})`);
  for (const p of pos) parseRevPtr(p);
  return pos;
}

// owner/name of the origin remote; the URL itself is never printed (it can hold credentials)
function origin(dir) {
  let url = '';
  try { url = git(dir, ['remote', 'get-url', 'origin']).trim(); } catch { /* no origin */ }
  const r = parseRemote(url);
  if (!r) throw new BrainError('no-github-remote', 'brain sync reads owner/name from the origin remote, and origin here is missing or not on github.com');
  return r;
}

// after a sync: github.db always, code.db when there is an index (sync does not need one)
function afterSync(codeDbPath) {
  if (existsSync(codeDbPath)) return openContext({ codeDbPath, checkout });
  const gh = openGithubDb(githubDbPath(codeDbPath), { readOnly: true });
  return { code: null, gh, meta: {}, sync: gh ? readSyncState(gh) : null, checkout, codeDbPath, close() { try { gh?.close(); } catch {} } };
}

// brain status in server mode (Phase 2 §6.4, Phase 3 §6.5): the store's view of the run (the newest, or --as-of) — its
// commit and GitHub state — and the four staleness cells of the newest run, with Actions when BRAIN_DISPATCH_TOKEN is
// set. Nothing local is read and no mirror is pulled.
async function serverStatus(url, opt) {
  const s = await serverSession(url, opt);
  try {
    let at = s.at;
    if (!at) {
      try { at = await s.store.resolveAsOf(null); }
      catch (e) { if (e.code !== 'not-found') throw e; }    // no published run yet
    }
    const st = await cellsOf(s, { actions: actionsFromEnv(process.env), ms: STATUS_STALENESS_MS });
    const P = FOOTER_PHRASES, d = st.detail, v = at?.view ?? null, sy = v?.sync ?? null;
    const ctx = v ? viewContext(v, checkout) : null;
    if (ctx) { ctx.at = { asOf: s.at !== null, latest: at.latest }; if (s.at === null) ctx.staleness = st; }
    const fr = ctx && freshFor(ctx), cov = ctx && coverage(ctx, {});
    const actionsNote = d.actions.ok ? 'read' : d.actions.error === 'no-token' ? 'not read (no BRAIN_DISPATCH_TOKEN): activity and last are the server\'s record only'
      : d.actions.error === 'no-binding' ? 'not read (the server brain has no binding)' : `not read (${safe(d.actions.error)}): activity and last are the server's record only`;
    if (opt.json) {
      ctx?.close();
      return outJson({ mode: 'server', repo: s.binding.repo, run: v && { run: v.run, commit: v.runCommit, publishedAt: v.publishedAt, asOf: s.at !== null, latest: at.latest },
        sync: sy && { cursor: sy.cursor ?? null, lastOkAt: sy.last_ok_at ?? null, lastFullAt: sy.last_full_at ?? null },
        staleness: cellsJson(st), checks: { db: d.db.ok ? 'ok' : d.db.error, git: d.git.ok ? 'ok' : d.git.error, actions: d.actions.ok ? 'ok' : d.actions.error },
        ...(ctx && { coverage: cov, freshness: jsonFresh(fr) }) });
    }
    const ago = (ms) => `${ageText(ms ?? 0)} ago`;
    const when = (iso) => (iso ? `${safe(iso.slice(0, 16).replace('T', ' '))}Z` : 'never');
    const gitWhy = { 'ls-remote': 'failed', timeout: 'timed out', 'no-main': 'has no main' };
    const code = st.code.state === 'behind' ? P.code.behind(st.code.behind) : st.code.state === 'unknown'
      ? `unknown (${d.db.ok ? `git ls-remote origin ${gitWhy[d.git.error] ?? safe(d.git.error)}` : 'server not read'})` : P.code[st.code.state];
    const memory = st.memory.state === 'fresh' || st.memory.state === 'old' ? P.memory[st.memory.state](ageText(st.memory.ageMs ?? 0))
      : st.memory.state === 'unknown' ? `unknown${d.db.ok ? ' (the GitHub time is not a date)' : ' (server not read)'}` : P.memory.never;
    const activity = st.activity.state === 'idle' ? 'idle' : `${st.activity.state === 'queued' ? P.activity.queued : P.activity.running(st.activity.stage)}`
      + `${st.activity.runId ? ` · actions run ${st.activity.runId}` : ''}${st.activity.sinceMs != null ? ` · ${ago(st.activity.sinceMs)}` : ''}`;
    const last = !st.last ? 'none' : `${st.last.state}${st.last.stage ? ` (${safe(st.last.stage)})` : ''} ${ago(st.last.agoMs)}`;
    out(`${c.bold('brain status')}  server · ${safe(s.binding.repo)} (the team brain, read-only)`);
    out(table(['', ''], [
      ['run', v ? `${v.run} @${String(v.runCommit).slice(0, 8)} · published ${v.publishedAt ? `${when(v.publishedAt)} (${ago(Date.now() - Date.parse(v.publishedAt))})` : '?'}`
        + (s.at !== null ? ` · as-of · latest run ${at.latest}` : '') : `${P.noRun} — ask an admin to run the bootstrap (brain-bootstrap.yml)`],
      ['github', sy ? `data as of ${when(sy.cursor)} · last ok ${when(sy.last_ok_at)} · full ${when(sy.last_full_at)}` : 'never synced'],
      ['code', `${code}${st.code.mainHead ? ` (main @${st.code.mainHead.slice(0, 8)})` : ''}`],
      ['memory', memory],
      ['activity', activity],
      ['last', last],
      ['actions', actionsNote],
    ]));
    if (!ctx) return out(c.dim(`  freshness: ${footerLine(st)}`));
    for (const l of footer({ coverage: cov, freshness: fr })) out(c.dim(l));
    ctx.close();
  } finally { await s.store.close(); }
}

const cmds = {
  async build({ pos, opt }) {
    localOnly(opt, 'build');
    const repo = resolve(pos[0] || opt.repo || '.');
    const dbPath = opt.db ? resolve(opt.db) : process.env.BRAIN_DB ? resolve(process.env.BRAIN_DB) : defaultDbPath(repo);
    const options = { includeRoots: opt['include-root'], noKnowledge: !!opt['no-knowledge'] };
    const report = (fields) => {
      const ctx = openContext({ codeDbPath: dbPath, checkout: repo });
      const fr = freshFor(ctx), cov = coverage(ctx, { unresolvedLocal: ctx.meta.coverage?.unresolvedLocal });
      ctx.close();
      if (opt.json) outJson({ db: dbPath, ...fields, coverage: cov, freshness: jsonFresh(fr) });
      else finish(fr, cov, say);                         // build's text goes to stderr, so its footer does too
    };
    // --if-stale: keep an index, built with the same options and the current sanitizer, that still matches THIS
    // checkout (f.repo: freshness was checked here, not at the path the index was built in). An index copied into
    // another clone at the same commit is kept too: rebuilding it would only re-read the same commit. A vault always
    // rebuilds: its notes are outside git, so nothing tells us they did not change
    if (opt['if-stale'] && existsSync(dbPath) && !opt.vault) {
      const db = openDb(dbPath), f = freshness(db, repo);
      db.close();
      // a copy from another checkout only when that build read a clean tree: then the index is exactly the commit's
      // files (meta.worktree hashes say nothing about which files were tracked, e.g. after `git rm --cached`)
      const copied = f.meta.repo !== undefined && f.meta.repo !== f.repo;
      if (f.state === 'fresh' && Number(f.meta.sanitize_version ?? -1) >= SANITIZE_VERSION && f.repo === repo && !f.meta.vault
        && !(copied && Object.keys(f.meta.worktree ?? {}).length)
        && JSON.stringify(f.meta.options) === JSON.stringify(options)) {
        say(`brain build: index @${f.commit.slice(0, 8)} is fresh — skipped (drop --if-stale to rebuild)`);
        return report({ skipped: true });
      }
    }
    // one write lifecycle: nobody reads a half-deleted code.db for relinking, no sync writes refs meanwhile
    const { value: r } = await withWriteLock(dbPath, async () => {
      const built = build({ repo, dbPath, vault: opt.vault, ...options, tilde, log: say });
      // a relink failure is recorded, never a failed build (plan §3.1)
      try { return { ...built, relink: await relink({ codeDbPath: dbPath, repoDir: repo, log: say }) }; }
      catch (e) {
        const error = scrub(e?.message ?? e);
        say(`brain build: relink failed (${error}) — the index is built; GitHub refs relink on the next build or sync`);
        return { ...built, relink: { error } };
      }
    });
    report({ skipped: false, ...r });
  },

  async status({ opt }) {
    const url = serverUrl(opt);
    if (url) return serverStatus(url, opt);
    const ctx = openContext({ codeDbPath: dbPathFor(opt), checkout }), db = ctx.code;
    const f = freshness(db, checkout), m = f.meta, s = m.stats;
    const fr = freshFor(ctx, f), cov = coverage(ctx, { unresolvedLocal: m.coverage?.unresolvedLocal });
    const counts = Object.fromEntries(db.prepare(`SELECT CASE WHEN lang = 'md' THEN 'doc' ELSE kind END AS kind, count(*) n FROM nodes GROUP BY 1`).all().map((r) => [r.kind, r.n]));
    const edges = db.prepare('SELECT count(*) n FROM edges').get().n;
    const chunks = Object.fromEntries(db.prepare('SELECT source, count(*) n FROM chunks GROUP BY source').all().map((r) => [r.source, r.n]));
    const ageMin = Math.round((Date.now() - Date.parse(m.built_at)) / 60000);
    if (opt.json) return outJson({ ...f, repo: f.repo == null ? f.repo : scrub(f.repo), counts, edges, chunks, ageMin, meta: undefined, stats: s, timings: m.timings, coverage: cov, freshness: jsonFresh(fr) });
    out(`${c.bold('brain status')}  ${cutLeft(scrub(tilde(f.repo)), COLS - 16)}`);
    out(table(['', ''], [
      ['index', `@${m.commit?.slice(0, 8)} (${m.commit_date}) · built ${ageMin} min ago in ${m.timings.total}s`],
      ['head', f.head ? `@${f.head.slice(0, 8)} · ${plural(f.changed.length, 'file')} changed since the index` : 'unknown (not a git repo?)'],
      ['map', `${plural(counts.file || 0, 'code file')} · ${plural(Object.entries(counts).filter(([k]) => !['file', 'dir', 'doc'].includes(k)).reduce((a, [, n]) => a + n, 0), 'symbol')} · ${plural(edges, 'edge')}`],
      ['programs', s.ts ? `${plural(s.ts.programs, 'TS program')} · ${s.ts.configs.map((x) => `${safe(x.config)} ${x.files.toLocaleString('en-US')} files`).join(' · ')} · ${s.ts.orphans} in no tsconfig (nearest config's options; list: --json orphanFiles) · typescript ${s.ts.version}` : '—'],
      ['memory', `${plural(counts.doc || 0, 'markdown file')} → ${Object.entries(chunks).map(([k, n]) => `${k} ${n}`).join(' · ')} chunks`
        + (s.knowledge?.unlinkedNames?.count ? ` · ${plural(s.knowledge.unlinkedNames.count, 'name')} with ${MAX_NAME_OWNERS + 1}+ exported owners not linked (${s.knowledge.unlinkedNames.examples.map(safe).join(', ')}${s.knowledge.unlinkedNames.count > 5 ? ', …' : ''})` : '')],
      ['coverage', `${plural(m.coverage.unresolvedLocal, 'unresolved local import')}${s.ts ? ` · ${s.ts.unresolvedBuildOutput ?? 0} into build output (ignored) · ${s.ts.assetImports} asset imports (css/svg, not tracked) · ${s.ts.externalImports} package imports` : ''}`],
    ]));
    if (f.changed.length) out(c.yellow(`\n  ${plural(f.changed.length, 'file')} changed since the index: ${f.changed.slice(0, 8).map(ident).join(', ')}${f.changed.length > 8 ? ', …' : ''}`));
    for (const l of footer({ coverage: cov, freshness: fr })) out(c.dim(l));
  },

  async find({ pos, opt }) {
    const ctx = await open(opt), db = ctx.code;
    const r = find(db, pos[0], { limit: +(opt.limit || 20), kind: opt.kind });
    const fr = freshFor(ctx), cov = coverage(ctx, { truncated: r.truncated });
    if (opt.json) return outJson({ ...r, freshness: jsonFresh(fr), coverage: cov, rows: r.rows.map((n) => ({ id: n.key, kind: n.kind, line: n.line, exported: !!n.exported, uses: n.uses })) });
    // an ID is never cut (it is the next command's argument): one wider than the room goes on its own line under the row
    const head = ['ID', 'KIND', 'USES', 'LINE'];
    const rows = r.rows.map((n) => [ident(n.key), n.kind + (n.exported || ['file', 'dir'].includes(n.kind) ? '' : ' (local)'), n.uses, n.line ?? '']);
    const room = COLS - [1, 2, 3].reduce((s, i) => s + 2 + Math.max(...[head, ...rows].map((x) => width(String(x[i])))), 2);
    const long = (id) => width(id) > room;
    const lines = table(head, rows.map((x) => (long(x[0]) ? ['↓', ...x.slice(1)] : x)), { align: ['l', 'l', 'r', 'r'] }).split('\n');
    rows.forEach((x, i) => { if (long(x[0])) lines[2 + i] += '\n  ' + x[0]; });
    out(lines.join('\n'));
    if (r.truncated) out(c.yellow(`  more matches — narrow the name or add --kind`));
    finish(fr, cov);
  },

  async refs({ pos, opt }, mode = 'refs') {
    const ctx = await open(opt), db = ctx.code;
    const node = target(ctx, pos[0], opt);
    const kinds = mode === 'callers' ? ['call', 'new', 'renders'] : list(opt.kind);
    const r = refs(db, node, { kinds, filter: list(opt.filter), exclude: list(opt.exclude), includeImports: opt.imports,
      limit: opt.files ? 1e9 : +(opt.limit || 50), cursor: +(opt.cursor || 0) });
    // Phase 0 fields as they were; the state follows partial > truncated > complete, as the footer does (plan §3.8)
    const p0 = coverageFor(db, { truncated: r.next !== null }), shownCov = covOf(ctx, p0), cov = { ...p0, state: shownCov.state }, fr = freshFor(ctx);
    const site =(x) => ({ kind: x.kind, site: `${x.path}:${x.line}:${x.col}`, in: x.in_kind === 'file' ? null : x.in_name, flags: x.flags || '' });
    // --files: one row per file (its first site, the site count, every kind), not one per site
    const perFile = () => [...Map.groupBy(r.rows, (x) => x.path).values()]
      .map((xs) => ({ ...site(xs[0]), kind: [...new Set(xs.map((x) => x.kind))].join(' '), sites: xs.length }));
    if (opt.json) return outJson({ target: node.key, kind: node.kind, total: r.total, files: r.files, next: r.next, coverage: cov, freshness: jsonFresh(fr),
      sites: opt.files ? perFile() : r.rows.map(site) });
    const where = node.path && node.kind !== 'file' ? c.dim(`defined ${ident(node.path)}:${node.line}`) : '';
    const head = `${mode} ${describe(node)}`;
    out(where && width(head) + width(where) + 2 > COLS ? `${head}\n  ${where}` : `${head}${where ? '  ' + where : ''}`);
    if (opt.files || mode === 'callers') {
      const by = new Map();
      for (const x of r.rows) {
        const k = mode === 'callers' ? `${x.path}\0${x.in_kind === 'file' ? '(top level)' : x.in_name}` : x.path;
        const g = by.get(k) || { path: x.path, in: x.in_kind === 'file' ? '(top level)' : safe(x.in_name), n: 0, kinds: new Map(), flags: x.flags, lines: [] };
        g.n++; g.kinds.set(x.kind, (g.kinds.get(x.kind) || 0) + 1); g.lines.push(x.line); by.set(k, g);
      }
      const rows = [...by.values()].map((g) => [ident(g.path) + c.dim(`:${g.lines.slice(0, 3).join(',')}`), ...(mode === 'callers' ? [g.in] : []), g.n,
        [...g.kinds].map(([k, n]) => (n > 1 ? `${k}×${n}` : k)).join(' '), g.flags || '']);
      out(tableWhole(['FILE', ...(mode === 'callers' ? ['CALLER'] : []), 'SITES', 'KINDS', 'ROLE'], rows, 0,
        { align: mode === 'callers' ? ['l', 'l', 'r'] : ['l', 'r'], max: [0, 34] }));
    } else {
      out(tableWhole(['KIND', 'SITE', 'IN', 'ROLE'], r.rows.map((x) => [x.kind, `${ident(x.path)}:${x.line}`, x.in_kind === 'file' ? c.dim('(top level)') : safe(x.in_name), x.flags || '']), 1, { max: [0, 0, 32] }));
    }
    out(c.dim(`  ${plural(r.total, 'site')} in ${plural(r.files, 'file')}`) + (r.next !== null ? c.yellow(` · showing ${+(opt.cursor || 0) + 1}–${r.next} · next: --cursor ${r.next}`) : ''));
    finish(fr, shownCov);
  },

  callers(args) { return cmds.refs(args, 'callers'); },

  async impact({ pos, opt }) {
    const ctx = await open(opt), db = ctx.code;
    const node = target(ctx, pos[0], opt);
    const r = impact(db, node, { hops: +(opt.hops || 99), noTypes: opt['no-types'], noMocks: opt['no-mocks'] });
    const filter = list(opt.filter), exclude = list(opt.exclude);
    const keep = (p) => { const f = (r.flagsOf.get(p) || '').split(' '); return (!filter || filter.some((x) => f.includes(x))) && (!exclude || !exclude.some((x) => f.includes(x))); };
    const hops = r.hops.map((h) => ({ ...h, paths: h.paths.filter(keep) })).map((h) => ({ ...h, files: h.paths.length, tests: h.paths.filter((p) => r.flagsOf.get(p).includes('test')).length })).filter((h) => h.files);
    const total = hops.reduce((a, h) => a + h.files, 0), tests = hops.reduce((a, h) => a + h.tests, 0);
    const cov = coverageFor(db, { truncated: false }), fr = freshFor(ctx);
    // a route handler is reached by its URL, not by an import: with no importers, say what to grep instead
    const hint = total === 0 && node.kind === 'file' && node.flags.split(' ').includes('route')
      ? `reached by URL, not imports — grep "${routeUrl(node.path)}" (fetch calls, links, config)` : undefined;
    if (opt.json) return outJson({ target: node.key, kind: node.kind, total, tests, coverage: cov, freshness: jsonFresh(fr), hint,
      hops: hops.map((h) => ({ hop: h.hop, files: h.files, tests: h.tests, paths: h.paths })) });
    const level = node.kind === 'file' || node.kind === 'dir' ? 'file level · import edges' : 'symbol level · use edges';
    out(`impact ${describe(node)}  ${c.dim(level)}${filter ? c.dim(` · only ${safe(filter.join(','))}`) : ''}${exclude ? c.dim(` · without ${safe(exclude.join(','))}`) : ''}`);
    let cum = 0;
    out(table(['HOP', 'FILES', 'TESTS', 'CUMULATIVE', 'EXAMPLES'], hops.map((h) => {
      cum += h.files;
      return [h.hop === 1 ? '1 (direct)' : h.hop, h.files, h.tests, cum, h.paths.filter((p) => !r.flagsOf.get(p).includes('test')).slice(0, 2).map((p) => safe(p.split('/').slice(-2).join('/'))).join(', ')];
    }), { align: ['l', 'r', 'r', 'r'], max: [0, 0, 0, 0, 60] }));
    // the deepest hop, not the row count: --filter drops hops with no match (hop 8 empty, hop 9 kept = 9 hops)
    out(c.bold(`  total: ${plural(total, 'file')} may be affected (${tests} tests)`) + c.dim(` · ${hops.at(-1)?.hop ?? 0} hops`));
    if (hint) out(c.yellow(`  ${safe(hint)}`));
    if (opt.list) for (const h of hops) for (const p of h.paths) out(`  ${h.hop}\t${safe(p)}`);
    finish(fr, covOf(ctx, cov));
  },

  async deps({ pos, opt }) {
    const ctx = await open(opt), db = ctx.code;
    const node = target(ctx, pos[0], opt);
    const r = deps(db, node, { hops: +(opt.hops || 99), noTypes: opt['no-types'] });
    const rows = [...r.hopOf].filter(([, h]) => h > 0).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
    const cov = coverageFor(db, { truncated: false }), fr = freshFor(ctx);
    if (opt.json) return outJson({ target: node.key, from: node.path, total: rows.length, coverage: cov, freshness: jsonFresh(fr), files: rows.map(([p, h]) => ({ path: p, hop: h })) });
    out(`deps ${describe(node)}: ${plural(rows.length, 'file')} pulled in`);
    if (!['file', 'dir'].includes(node.kind)) out(c.dim(`  file level: what ${ident(node.path)} (where ${safe(node.name)} is defined) pulls in`));
    if (opt.list) for (const [p, h] of rows) out(`  ${h}\t${safe(p)}`);
    else out(table(['HOP', 'FILES'], Object.entries(rows.reduce((a, [, h]) => ({ ...a, [h]: (a[h] || 0) + 1 }), {})), { align: ['l', 'r'] }));
    finish(fr, covOf(ctx, cov));
  },

  async shared({ pos, opt }) {
    const ctx = await open(opt), db = ctx.code;
    const a = target(ctx, pos[0], opt), b = target(ctx, pos[1], opt);
    const r = shared(db, a, b, { noTypes: opt['no-types'] });
    const byTop = r.both.reduce((m, p) => m.set(p.split('/').slice(0, 2).join('/'), (m.get(p.split('/').slice(0, 2).join('/')) || 0) + 1), new Map());
    const cov = coverageFor(db, { truncated: false }), fr = freshFor(ctx);
    if (opt.json) return outJson({ a: a.key, b: b.key, total: r.both.length, coverage: cov, freshness: jsonFresh(fr), files: r.both });
    out(`shared ${describe(a)} ∩ ${describe(b)}`);
    out(c.dim(`  ${ident(a.path)} pulls in ${r.a} files · ${ident(b.path)} pulls in ${r.b} · both: `) + c.bold(r.both.length));
    out(table(['AREA', 'FILES'], [...byTop].sort((x, y) => y[1] - x[1]).slice(0, opt.list ? 1e9 : 12).map(([k, n]) => [ident(k), n]), { align: ['l', 'r'] }));
    if (opt.list) for (const p of r.both) out(`  ${ident(p)}`);
    finish(fr, covOf(ctx, cov));
  },

  async why({ pos, opt }) {
    const ctx = await open(opt), db = ctx.code;
    const t0 = performance.now();
    const r = why(db, pos.join(' '), { limit: +(opt.limit || 8) });
    const ms = Math.round(performance.now() - t0);
    const f = freshness(db, checkout);
    markMentions(f.repo, r);
    const fr = freshFor(ctx, f), cov = coverage(ctx, {});
    if (opt.json) return outJson({ ...r, ms, freshness: jsonFresh(fr), coverage: cov });
    out(`why ${c.bold(ext(scrub(r.question), COLS - 36))}  ${c.dim(`FAST · no LLM · ${ms} ms`)}`);
    if (r.seeds.length) out(c.dim(`  names → code: ${r.seeds.map(ident).join(', ')}`));
    if (r.gap) {
      out(c.yellow(`  no doc, change note or commit mentions ${r.terms.names.map(safe).join(', ') || 'these terms'} — a knowledge gap.`));
      out(c.dim('  read the code itself (the header / the definition), and consider writing the doc'));
      return finish(fr, cov);
    }
    // a cite is never cut. Under 120 columns SOURCE and DATE go (the cite's shape says commit / changes/ / doc).
    // A cite wider than 40% of the screen goes on its own line under the row, so TITLE keeps its room.
    // Titles and snippets are people's text: quoted (ext), never at the start of a line
    const wide = COLS >= 120;
    const cols = wide ? ['#', 'SOURCE', 'CITE', 'DATE', 'PR', 'TITLE'] : ['#', 'CITE', 'PR', 'TITLE'];
    const citeOf = (x) => ident(x.cite);
    const long = (x) => width(citeOf(x)) > Math.floor(COLS * 0.4);
    const cell = (x, i) => ({ '#': i + 1, SOURCE: x.source, CITE: long(x) ? '↓' : citeOf(x), DATE: safe(x.date || ''), PR: safe(x.prs.split(' ').slice(0, wide ? 2 : 1).join(' ')), TITLE: x.title ? ext(x.title) : '' });
    const lines = table(cols, r.citations.map((x, i) => cols.map((k) => cell(x, i)[k])), { align: ['r'] }).split('\n');
    const at = 2 + String(r.citations.length).length + 2 + (wide ? Math.max(6, ...r.citations.map((x) => width(x.source))) + 2 : 0);
    r.citations.forEach((x, i) => { if (long(x)) lines[2 + i] += '\n' + ' '.repeat(at) + citeOf(x); });
    out(lines.join('\n'));
    for (const [i, x] of r.citations.slice(0, 3).entries()) out(c.dim(`  ${i + 1}. `) + (x.snippet ? ext(x.snippet, COLS - 6) : ''));
    // a citation's text can name a build ID or a file that is gone: say so, so neither is cited as evidence
    for (const [i, x] of r.citations.entries()) {
      if (x.inTree === false) out(c.yellow(`  #${i + 1} ${citeOf(x)}: the cited file is not in the tree now — cite the commit that removed it`));
      const bad = [...x.notCommits.map((s) => `${safe(s)} (not a commit)`), ...x.notInTree.map((p) => `${safe(p)} (not in the tree)`)];
      if (bad.length) out(c.yellow(`  #${i + 1} mentions ${bad.slice(0, 4).join(', ')}${bad.length > 4 ? `, +${bad.length - 4} more` : ''} — do not cite these`));
    }
    if (r.related.length) out(cut(c.dim('  related code (1 hop): ') + r.related.slice(0, 6).map((x) => `${ident(x.path)} ×${x.citations}`).join(' · '), COLS));
    for (const h of r.history.filter((h) => h.commits.length)) out(c.dim(`  history of ${ident(h.seed)}: `) + h.commits.map((x) => `${x.sha.slice(0, 8)} ${safe(x.prs.split(' ')[0] || '')}`.trim()).join(' · '));
    out(c.dim('  read the cited lines before you answer; cite path:line or SHA'));
    finish(fr, cov);
  },

  async viz({ pos, opt }) {
    const ctx = await open(opt), db = ctx.code;
    const node = target(ctx, pos[0], opt, say);
    const file = viz(db, node, { out: opt.out, hops: +(opt.hops || 2), question: opt.why == null ? opt.why : scrub(opt.why), max: +(opt.max || 260) });
    out(safe(tilde(file)));                              // stdout is the file path only; the footer goes to stderr
    if (opt.open) execFileSync('open', [file]);
    finish(freshFor(ctx), covOf(ctx, coverageFor(db, { truncated: false })), say);
  },

  // ---------- Phase 3: the team brain's refresh, and the CI publish job ----------

  // §6.6: one line on stdout (--json: { exit, message, runId }), exit REFRESH_EXIT. Server mode only.
  async refresh({ opt }) {
    const start = Date.now(), end = start + callBudget(process.env);
    const left = (cap) => Math.max(1, Math.min(cap, end - Date.now()));
    const done = (r) => { if (opt.json) outJson(r); else out(r.message); process.exit(r.exit); };
    const failed = (msg) => done({ exit: REFRESH_EXIT.failed, message: REFRESH_MESSAGES.failed(msg), runId: null });
    const unavailable = (message) => done({ exit: REFRESH_EXIT.unavailable, message, runId: null });
    const url = serverUrl(opt);
    if (!url) return unavailable('refresh unavailable: local mode (no BRAIN_READER_URL) — brain build and brain sync update a local index');
    // F8: all of it inside the call budget. The local git reads (the checkout, its origin) are killed at their timeout;
    // connect + the reader check run under the client-side timer (a connection that stalls past it ends with this
    // process). Every outcome keeps refresh's one-line form: a refusal (not-reader, wrong-repo) is exit 2
    checkout = here(opt, left(LOCAL_GIT_MS));
    let origin = null;
    try { origin = parseRemote(git(checkout ?? process.cwd(), ['remote', 'get-url', 'origin'], { timeout: left(LOCAL_GIT_MS) })); } catch { /* no origin */ }
    let conn;
    try {
      conn = await withDeadline(connectReader(url, { origin }), left(REFRESH_LIMITS.httpMaxMs));
    } catch (e) {
      const msg = scrub(e?.message ?? e);
      if (['server', 'timeout'].includes(e?.code)) return unavailable(REFRESH_MESSAGES.noServer);
      if (['not-reader', 'wrong-repo'].includes(e?.code)) return unavailable(`refresh unavailable: ${msg}`);
      return failed(e?.code === 'no-brain' ? `${msg} — ask an admin to run the bootstrap (brain-bootstrap.yml)` : msg);
    }
    let r;
    try {
      r = await refresh({ wait: !!opt.wait, start, statePath: refreshStatePath(homedir(), conn.binding.id), reader: conn.client,
        actions: actionsFromEnv(process.env), repoDir: checkout ?? process.cwd(), env: process.env });
    } catch (e) { r = { exit: REFRESH_EXIT.failed, message: REFRESH_MESSAGES.failed(scrub(e?.message ?? e)), runId: null }; }
    finally { destroyReader(conn.client); }
    done(r);
  },

  // S2: the publish job (ci/brain-publish.yml, ci/brain-bootstrap.yml). Its env passes through whole (BRAIN_WRITER_URL,
  // BRAIN_PUBLISH_WORKFLOW, …): ci-publish itself decides what its children see. Exit: contract CI_EXIT
  async 'ci-publish'({ opt }) {
    const { ciPublish } = await import('./pg/ci-publish.mjs');
    process.exit(await ciPublish({ source: opt.source, mirror: opt.mirror, work: opt.work ?? null, full: !!opt.full,
      mode: 'mode' in opt ? opt.mode ?? '' : 'normal', env: process.env }));
  },

  // ---------- Phase 1: GitHub memory ----------

  async sync({ opt }) {
    localOnly(opt, 'sync');
    const codeDbPath = dbPathFor(opt), repoDir = checkout ?? process.cwd();
    const { owner, repo } = origin(repoDir);              // before the token: no credential is read for a repo we cannot sync
    const timeout = whole(opt['request-timeout'], 'request-timeout', 1), rateWait = whole(opt['max-rate-wait'], 'max-rate-wait', 0);
    const seam = replaySeams();
    const token = seam ? seam.token : readToken(process.env, { allowGh: true });
    activeToken = token;
    if (!token) say('brain sync: no GitHub token (GH_TOKEN, GITHUB_TOKEN or gh auth token) — unauthenticated requests, 60 per hour');
    const clock = seam ? seam.clock : realClock;
    const client = createClient({ owner, repo, token, transport: seam ? seam.transport : fetchTransport, clock, log: say,
      ...(timeout !== undefined && { requestTimeoutMs: timeout * 1000 }), ...(rateWait !== undefined && { maxRateWaitMs: rateWait * 1000 }) });
    let r;
    try { r = await ghSync({ codeDbPath, repoDir, client, full: !!opt.full, log: say, clock, token }); }
    catch (e) {
      if (e.code !== 'lock-busy') throw e;
      r = { status: 'busy', cursor: null, counts: null, error: e.message, staleLock: false, relink: null };
    }
    r = { ...r, error: r.error == null ? null : scrub(r.error) };
    const ctx = afterSync(codeDbPath);
    const fr = freshFor(ctx), cov = coverage(ctx, { githubPresent: !!ctx.gh });
    ctx.close();
    if (opt.json) outJson({ ...r, coverage: cov, freshness: jsonFresh(fr) });
    else { out(renderSync(r)); finish(fr, cov); }
    if (r.status !== 'ok') process.exit(r.status === 'busy' ? 3 : 1);
  },

  async search({ pos, opt }) {
    const q = pos.join(' ');
    const opts = { kind: oneOf(opt.kind, 'kind', KINDS), state: oneOf(opt.state, 'state', STATES), path: text(opt.path, 'path'),
      author: text(opt.author, 'author'), since: since(opt.since), limit: whole(opt.limit, 'limit', 1), cursor: whole(opt.cursor, 'cursor', 0) };
    if (!q.trim() && !opts.path) throw usage('brain search "<question>" [--path P] — give a question, a --path, or both');
    const { ctx, res } = await memoryRead(opt, (c) => read.search(c, q, opts), (store, asOf) => read.searchIn(store, q, { ...opts, asOf }));
    const shown = { ...res, query: scrub(res.query) };   // the query echo is a runtime value
    const cov = coverage(ctx, { ...res.facts, truncated: res.next != null }), fr = freshFor(ctx);
    if (opt.json) return outJson({ ...shown, coverage: cov, freshness: jsonFresh(fr) });
    out(renderSearch(shown, { coverage: cov, freshness: fr }, { cursor: opts.cursor ?? 0 }).join('\n'));
  },

  async get({ pos, opt }) {
    const ptrs = pointers(pos, 5);
    const { ctx, res } = await memoryRead(opt, (c) => read.get(c, ptrs), (store, asOf) => read.getIn(store, ptrs, { asOf }));
    const cov = coverage(ctx, res.facts), fr = freshFor(ctx);
    if (opt.json) return outJson({ ...res, coverage: cov, freshness: jsonFresh(fr) });
    out(renderGet(res, { coverage: cov, freshness: fr }).join('\n'));
  },

  async source({ pos, opt }) {
    const [ptr] = pointers(pos, 1);
    const from = whole(opt.from, 'from', 1) ?? 1, maxLines = whole(opt.lines, 'lines', 1) ?? 200;
    const { ctx, res: src } = await memoryRead(opt, (c) => read.source(c, ptr, { from, maxLines }),
      (store, asOf) => read.sourceIn(store, ptr, { from, maxLines, asOf }));
    // a GitHub quote is as complete as the last sync: a failed or missing one makes it partial
    const cov = coverage(ctx, { lines: { from: src.from, to: src.to, total: src.total }, ...(src.origin === 'github' ? { githubPresent: !!(ctx.gh || ctx.sync) } : {}) });
    const fr = freshFor(ctx);
    if (opt.json) return outJson({ ...src, coverage: cov, freshness: jsonFresh(fr) });
    out(renderSource(src, { coverage: cov, freshness: fr }, read.envelope).join('\n'));
  },
};

process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e; });   // `brain … | head`
const { pos, opt } = parse(process.argv.slice(2));
const cmd = pos.shift();
if (!cmd || opt.help || !cmds[cmd]) { out(HELP); process.exit(cmd && !opt.help ? 1 : 0); }
// ci-publish runs in the ops repo's CI: it reads no checkout around cwd and never the reader URL. refresh reads the
// checkout itself, inside its call budget
if (!['build', 'ci-publish', 'refresh'].includes(cmd)) checkout = here(opt);
try {
  if (cmd !== 'ci-publish') {
    const reader = secretsOf(readerUrl() ?? '');            // before anything can echo input; also as a JSON string holds them
    if (!opt.local && reader.some((x) => x.length < MIN_SECRET)) {
      throw new BrainError('not-reader', `the password in BRAIN_READER_URL is shorter than ${MIN_SECRET} characters, too short to keep out of output: use the reader password migrate set`);
    }
    readerSecrets = [...new Set(reader.filter((x) => x.length >= MIN_SECRET).flatMap((x) => [x, JSON.stringify(x).slice(1, -1)]))].sort((a, b) => b.length - a.length);
  }
  await cmds[cmd]({ pos, opt });
}
catch (e) {
  // an error is not an answer: its code and a masked one-line message, no stack, no token; fail open
  const code = typeof e?.code === 'string' && e.code ? e.code : 'error';
  // a server with no brain yet: only the admin's first publish makes one (never a local build or sync)
  const msg = scrub(e?.message ?? e) + (code === 'no-brain' ? ' — ask an admin to run the bootstrap (brain-bootstrap.yml)' : '');
  if (opt.json) outJson({ error: msg, code });
  else out(`${c.red('brain error')} (${safe(code)}): ${msg}\n  fail open: continue with grep / your normal tools`);
  process.exit(code === 'lock-busy' ? 3 : ['not-reader', 'wrong-repo'].includes(code) ? 2 : 1);   // 2: a server brain refused (§6.2)
}
