// ci-publish (Phase 3 S2, design §6.1–6.4, A1–A6): the publish job of brain-publish.yml and brain-bootstrap.yml.
//   brain ci-publish --source <checkout> --mirror <dir> [--work <dir>] [--full] [--mode normal|bootstrap]
//   (until S5 registers the command: node src/pg/ci-publish.mjs ...)
// env: BRAIN_WRITER_URL (only this process reads it), BRAIN_SOURCE_REPO (owner/name, fixed in the workflow file: R1),
//   BRAIN_SOURCE_TOKEN (source read token: the repo id here, and sync as GH_TOKEN), GITHUB_TOKEN (A5: this run's
//   created_at, nothing else), GHA_RUN_ID / GHA_RUN_ATTEMPT (else GITHUB_RUN_ID / GITHUB_RUN_ATTEMPT), GITHUB_REPOSITORY,
//   GITHUB_WORKFLOW_REF.
// Stages (contract CI_STAGES). Each prints `brain-stage <stage> <start|ok|fail> <ISO time>` (test/pg/slo.mjs reads them):
//   prepare   the source commit, the binding's repo id, this run's created_at      no attempt yet: nothing is recorded
//   record    beginAttempt (R1, R2). A5: shouldSkip -> the attempt ends 'skipped', exit 0
//   mirror    pullMirror of the base run (R3); a cached mirror that does not match its run is pulled again in full (F2)
//   build     child `brain build`  } CI_LIMITS per stage: SIGTERM to its process group at the limit, SIGKILL CI_KILL_GRACE_MS
//             later; a process the child started that outlives it gets the same.
//   sync      child `brain sync`   } sync gets --request-timeout and --max-rate-wait from CI_LIMITS and GH_TOKEN
//   outbound  snapshot, diff, the upload check (R16)
//   publish   one transaction (R9–R13) with the CI_LIMITS timeouts; a lost COMMIT is resolved under the lock (R12)
//   verify    a new connection: the latest run is this run, and the mirror moves to it (the Actions cache keeps it).
//             The data is already committed: a failure here exits 3 and leaves the attempt ok.
// In-process stages (record, mirror, verify) are bounded by a deadline; publish by the server's timeouts.
// Every failure after record is written as attempt.stage = the stage and attempt.error = `<stage>:<kind>` (contract
// ciError), never free text. Exit codes: contract CI_EXIT. Children see no credential (only sync gets the source token, as
// GH_TOKEN) and run with BRAIN_TYPESCRIPT=kit. SIGINT / SIGTERM: kill the child's group, destroy the publish socket (the
// server rolls back), try failAttempt within CI_SIGNAL_CLEANUP_MS, exit 1 (3 once COMMIT has returned, 4 while it is in
// flight). Every printed line is masked (R16).
// Fault injection (A6): BRAIN_FAULT=<stage>:<point> (contract FAULT_POINTS) with BRAIN_FAULT_ALLOW=1 fails the real code
// path at that point. BRAIN_FAULT_LIMIT_MS (read only when a fault is set) shortens the faulted stage's limit for tests.
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import * as C from './contract.mjs';
import { snapshot, diff, applyDelta, checkOutbound } from './snapshot.mjs';
import { beginAttempt, publish, failAttempt, skipAttempt } from './publish.mjs';
import { pullMirror, MIRROR_DB } from './mirror.mjs';
import { githubDbPath } from '../gh-schema.mjs';
import { redactValues, sanitizeLine, SANITIZE_VERSION } from '../sanitize.mjs';
import { BrainError } from '../errors.mjs';

const KIT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BRAIN = join(KIT, 'bin', 'brain');
const SHAPES = ['code', 'github'];
const API = 'https://api.github.com';
// what a child process (and git) never sees
const SECRET = /^(BRAIN_WRITER_URL|BRAIN_READER_URL|BRAIN_SOURCE_TOKEN|BRAIN_DISPATCH_TOKEN|GH_TOKEN|GITHUB_TOKEN|DATABASE_URL.*|ACTIONS_.*)$/;
// build:sleep (T3): a build that hangs and exits on SIGTERM, but leaves a process that ignores it, its pipes closed
export const SLEEPER = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);';
const HANG = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(SLEEPER)}], { stdio: "ignore" }); setInterval(() => {}, 1000);`;
const CONNECT_ERRORS = new Set(['econnrefused', 'econnreset', 'etimedout', 'ehostunreach', 'enetunreach', 'enotfound', 'eai_again', 'epipe']);

/** The stage event line (test/pg/slo.mjs parses it). */
export const stageLine = (stage, event, at = new Date()) => `brain-stage ${stage} ${event} ${at.toISOString()}`;

class StageFail extends Error {
  constructor(stage, kind, message) { super(message); this.stage = stage; this.kind = kind; }
}

const durationMs = (d) => { const [, n, u] = /^(\d+)(ms|s|min)$/.exec(d); return Number(n) * { ms: 1, s: 1000, min: 60_000 }[u]; };

/** The contract kind of an error from a library call (publish, pullMirror, beginAttempt) or a plain error. */
export function kindOf(e) {
  if (e instanceof StageFail) return e.kind;
  if (e?.code === 'fault') return 'fault';
  if (e?.code === 'outbound-secret' || e?.stage === 'outbound') return 'outbound';
  if (e?.code === 'binding-mismatch') return 'binding';
  if (e?.code === 'mirror-checksum') return 'checksum';
  switch (e?.stage) {                                              // publish's own stages (Phase 2 R10–R12)
    case 'stale-base': return e.kind === 'base-moved' || e.kind === 'not-descendant' ? e.kind : 'stale-base';
    case 'sanitize': return 'not-resanitized';
    case 'row-count': return 'checksum';
    case 'input': return 'internal';
    case 'connect': return 'connect';
    case 'commit': return 'connect';                               // the COMMIT got no reply and did not happen (F9)
    default: break;
  }
  const code = String(e?.sqlstate ?? e?.kind ?? e?.code ?? '').toLowerCase();
  if (['57014', '25p04', '55p03'].includes(code) || /transaction timeout/i.test(e?.message ?? '')) return 'timeout';
  if (CONNECT_ERRORS.has(code) || /^08/.test(code) || /connection terminated/i.test(e?.message ?? '')) return 'connect';
  if (/^[0-9a-z]{5}$/.test(code) && code !== 'error') return 'sql';   // 'error': publish.mjs's fallback, not a SQLSTATE
  return 'internal';
}

/** sync's failure kind from its output: a rate limit, another GitHub failure, or just a non-zero exit. */
const syncKind = (lines) => (lines.some((l) => /rate limited/i.test(l)) ? 'rate-limit'
  : lines.some((l) => /GitHub [^:]+: (HTTP \d{3}|network error)|FAILED .*GitHub/.test(l)) ? 'http' : 'exit');

async function withLimit(stage, ms, fn) {
  if (!ms) return fn();
  let t;
  const late = new Promise((_, no) => { t = setTimeout(() => no(new StageFail(stage, 'timeout', `${stage} ran over its ${ms / 1000}s limit`)), ms); });
  try { return await Promise.race([fn(), late]); } finally { clearTimeout(t); }
}

/** A GitHub API GET with a deadline. @returns {Promise<object>} */
async function getJson(path, token, ms) {
  const res = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(ms),
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28', 'user-agent': 'codebase-brain' } });
  if (!res.ok) throw new StageFail('prepare', 'http', `GET ${path.replace(/\/\d+$/, '/<id>')}: HTTP ${res.status}`);
  return res.json();
}

/**
 * @param {{ source: string, mirror: string, work?: string|null, full?: boolean, mode?: 'normal'|'bootstrap',
 *   env?: NodeJS.ProcessEnv, log?: (s: string) => void }} opts
 * @returns {Promise<number>} a contract CI_EXIT code
 */
export async function ciPublish({ source, mirror: mirrorDir, work = null, full = false, mode = 'normal', env = process.env, log = console.log }) {
  const url = env.BRAIN_WRITER_URL, token = env.BRAIN_SOURCE_TOKEN;
  const hidden = [url, token, env.GITHUB_TOKEN];
  try { hidden.push(decodeURIComponent(new URL(url).password)); } catch { /* checked below */ }
  const say = (s) => log(redactValues(sanitizeLine(String(s)), hidden.filter((x) => typeof x === 'string' && x.length >= 4)));
  const childEnv = Object.fromEntries(Object.entries(env).filter(([k]) => !SECRET.test(k)));

  // ---- usage (exit 2, before anything starts) ----
  const runId = Number(env.GHA_RUN_ID ?? env.GITHUB_RUN_ID), runAttempt = Number(env.GHA_RUN_ATTEMPT ?? env.GITHUB_RUN_ATTEMPT);
  const need = { BRAIN_WRITER_URL: url, BRAIN_SOURCE_REPO: env.BRAIN_SOURCE_REPO, BRAIN_SOURCE_TOKEN: token, GITHUB_REPOSITORY: env.GITHUB_REPOSITORY,
    GITHUB_WORKFLOW_REF: env.GITHUB_WORKFLOW_REF, '--source': source, '--mirror': mirrorDir };
  const missing = Object.entries(need).filter(([, v]) => !v).map(([k]) => k);
  if (!Number.isSafeInteger(runId) || runId <= 0) missing.push('GHA_RUN_ID');
  if (!Number.isSafeInteger(runAttempt) || runAttempt <= 0) missing.push('GHA_RUN_ATTEMPT');
  if (mode !== 'normal' && mode !== 'bootstrap') missing.push('--mode normal|bootstrap');
  let fault = null;
  try { fault = C.parseFault(env); } catch { missing.push('BRAIN_FAULT (a contract FAULT_POINTS name)'); }
  if (missing.length) { say(`ci-publish: usage: missing or bad ${missing.join(', ')}`); return C.CI_EXIT.usage; }
  const limits = C.CI_LIMITS[mode];
  const faultMs = fault && Number(env.BRAIN_FAULT_LIMIT_MS) > 0 ? Number(env.BRAIN_FAULT_LIMIT_MS) : null;
  const limitOf = (st) => (faultMs && fault.stage === st ? faultMs : limits[st]);
  const is = (point) => fault !== null && `${fault.stage}:${fault.point}` === point;
  if (fault) say(`ci-publish: fault injection ${fault.stage}:${fault.point}${faultMs ? ` (limit ${faultMs} ms)` : ''}`);

  // ---- signals: kill the child, drop the publish socket, record within CI_SIGNAL_CLEANUP_MS, exit ----
  // phase (publish's stage hook): 'committing' from the attempt-ok UPDATE, 'committed' once COMMIT has returned (or a
  // lost COMMIT resolved as ok), back to 'writing' once a lost COMMIT resolved as not committed or publish failed
  const abort = new AbortController();
  let current = 'prepare', attemptId = null, group = null, stopping = null, phase = 'writing', run = null;
  const killChild = (sig) => { if (group) { try { process.kill(-group, sig); } catch { /* gone */ } } };
  const onSignal = (sig) => {
    stopping ??= (async () => {
      say(`ci-publish: ${sig} in stage ${current}: stopping`);
      say(stageLine(current, 'fail'));
      abort.abort();
      killChild('SIGTERM');
      if (phase === 'committed') say(`ci-publish: ${run ? `run ${run}` : 'this run'} is committed, but verify did not finish: the next refresh checks the server`);
      else if (attemptId !== null) {
        const r = await Promise.race([
          failAttempt({ url, attemptId, stage: current, error: C.ciError(current, 'signal') }).then((x) => {
            if (!x.updated) return 'the attempt was no longer running';
            phase = 'writing';                                         // running until now: no COMMIT took effect
            return 'recorded';
          }, () => 'not recorded'),
          sleep(C.CI_SIGNAL_CLEANUP_MS).then(() => 'not recorded in time')]);
        say(`ci-publish: failure ${r}`);
      }
      killChild('SIGKILL');
      // after COMMIT the data is in (as a verify failure); during COMMIT the outcome is unknown (R12)
      process.exit(phase === 'committed' ? C.CI_EXIT.verifyFailed : phase === 'committing' ? C.CI_EXIT.outcomeUnknown : C.CI_EXIT.failed);
    })();
  };
  process.on('SIGINT', onSignal).on('SIGTERM', onSignal);
  const end = (code) => (stopping ? new Promise(() => {}) : code);  // after a signal its handler exits, with its own code

  // a stage: its events, its name for failure records and signals
  const stage = async (name, fn) => {
    current = name;
    say(stageLine(name, 'start'));
    try { const v = await fn(); say(stageLine(name, 'ok')); return v; } catch (e) { say(stageLine(name, 'fail')); throw e; }
  };
  const git = async (args) => (await promisify(execFile)('git', args, { env: childEnv, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', signal: abort.signal })).stdout.trim();
  const runChild = (name, cmd, args, { cwd, extra = {}, limitMs, classify = () => 'exit' }) => new Promise((done, failed) => {
    const p = spawn(cmd, args, { cwd, env: { ...childEnv, BRAIN_TYPESCRIPT: 'kit', ...extra }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    group = p.pid;                                                   // detached: the child leads its own process group
    const lines = [];
    for (const out of [p.stdout, p.stderr]) createInterface({ input: out }).on('line', (l) => { lines.push(l); say(`  ${name}: ${l}`); });
    const left = () => { try { process.kill(-p.pid, 0); return true; } catch { return false; } };   // any process of the group
    let timedOut = false, termAt = null, kill = null;
    const term = () => {                                             // SIGTERM to the group, SIGKILL to what is left after the grace
      if (termAt !== null) return;
      termAt = Date.now();
      killChild('SIGTERM');
      kill = setTimeout(() => { if (left()) { say(`${name}: still running ${C.CI_KILL_GRACE_MS / 1000}s later: SIGKILL`); killChild('SIGKILL'); } }, C.CI_KILL_GRACE_MS);
    };
    const limit = limitMs ? setTimeout(() => { timedOut = true; say(`${name}: over the ${limitMs / 1000}s limit: SIGTERM`); term(); }, limitMs) : null;
    p.on('error', (e) => { clearTimeout(limit); clearTimeout(kill); group = null; failed(new StageFail(name, 'exit', `${name} could not start (${e.code ?? 'error'})`)); });
    p.on('close', async (code, signal) => {
      clearTimeout(limit);
      // the child is gone; a process it started may not be (one that ignores SIGTERM and closed its pipes): end the group
      if (left()) {
        if (termAt === null) say(`${name}: ended, but processes it started still run: SIGTERM`);
        term();
        while (left() && Date.now() - termAt < C.CI_KILL_GRACE_MS + 5000) await sleep(100);
      }
      clearTimeout(kill);
      group = null;
      if (timedOut) failed(new StageFail(name, 'timeout', `${name} ran over its ${limitMs / 1000}s limit`));
      else if (code === 0) done(lines);
      else if (signal) failed(new StageFail(name, 'signal', `${name} ended by ${signal}`));
      else failed(new StageFail(name, classify(lines), `brain ${args[0]} exited with ${code}`));
    });
  });
  const record = async (st, kind) => {
    const r = await failAttempt({ url, attemptId, stage: st, error: C.ciError(st, kind) }).catch(() => null);
    if (!r) say('ci-publish: the failure could not be recorded: the attempt stays running (shown as abandoned)');
  };

  try {
    // ---- prepare ----
    const src = resolve(source), cache = resolve(mirrorDir);
    const prep = await stage('prepare', async () => {
      let sourceSha;
      try { sourceSha = await git(['-C', src, 'rev-parse', 'HEAD']); } catch { throw new StageFail('prepare', 'internal', 'the source checkout has no HEAD'); }
      // owner/repo/.github/workflows/brain-publish.yml@refs/heads/main -> .github/workflows/brain-publish.yml
      const workflow = env.GITHUB_WORKFLOW_REF.slice(env.GITHUB_REPOSITORY.length + 1).replace(/@.*$/, '');
      const toolVersion = `codebase-brain@${JSON.parse(readFileSync(join(KIT, 'package.json'), 'utf8')).version}`;
      const repoId = (await getJson(`/repos/${env.BRAIN_SOURCE_REPO}`, token, limits.requestMs)).id;   // R1: the numeric id
      // A5 needs this run's created_at (GitHub's clock). Unknown -> no skip: the run publishes as usual.
      let createdAt = null;
      if (mode === 'normal' && !full && runAttempt === 1 && env.GITHUB_TOKEN) {
        try { createdAt = (await getJson(`/repos/${env.GITHUB_REPOSITORY}/actions/runs/${runId}`, env.GITHUB_TOKEN, limits.requestMs)).created_at ?? null; }
        catch (e) { say(`A5: this run's created_at is unknown (${e.message}): no skip`); }
      }
      return { sourceSha, workflow, toolVersion, repoId, createdAt };
    });

    // ---- record ----
    const { attemptId: id, base } = await stage('record', async () => {
      try {
        return await withLimit('record', limitOf('record'), () => beginAttempt({ url, sourceSha: prep.sourceSha, gha: { runId, attempt: runAttempt },
          binding: { sourceRepoId: prep.repoId, sourceRepo: env.BRAIN_SOURCE_REPO, opsRepo: env.GITHUB_REPOSITORY, workflow: prep.workflow } }));
      } catch (e) { throw e instanceof StageFail ? e : new StageFail('record', kindOf(e), e.code === 'binding-mismatch' ? e.message : `could not start the attempt (${kindOf(e)})`); }
    });
    attemptId = id;
    say(`attempt ${attemptId}: source ${prep.sourceSha.slice(0, 12)}, mode ${mode}, base run ${base?.run ?? 'none (first publish)'}`);
    if (base && C.shouldSkip({ firstAttempt: runAttempt === 1, mode, full, latestCommit: base.commit, sourceCommit: prep.sourceSha, latestT: base.githubT,
      runCreatedAt: prep.createdAt, latestTool: base.tool, tool: prep.toolVersion, latestSanitize: base.sanitize, sanitize: SANITIZE_VERSION })) {
      await skipAttempt({ url, attemptId });
      say(`attempt ${attemptId} skipped (A5): run ${base.run} already has this commit, this tool, and GitHub as of ${base.githubT}, after this run was created`);
      return end(C.CI_EXIT.ok);
    }

    // ---- mirror: the base state (R3) ----
    const FULL = { map: 'full', docs: 'full', commits: 'append', github: 'full' };
    const pulled = !base ? null : await stage('mirror', async () => {
      if (is('mirror:checksum')) tamperMirror(cache, say);
      let pullUrl = url;
      if (is('mirror:connect')) { const u = new URL(url); u.hostname = '127.0.0.1'; u.port = '9'; u.password = ''; pullUrl = u.href; }
      let m;
      try { m = await withLimit('mirror', limitOf('mirror'), () => pullMirror({ url: pullUrl, dir: cache, run: base.run, shapes: SHAPES, log: say })); }
      catch (e) { throw e instanceof StageFail ? e : new StageFail('mirror', kindOf(e), `the mirror of run ${base.run} could not be pulled (${kindOf(e)})`); }
      const state = snapshot({ codeDb: m.codeDb, githubDb: m.githubDb, manifest: C.validateManifest(FULL) });
      if (state.run !== base.run || C.canonicalJson(C.checksum(state)) !== C.canonicalJson(base.checksum)) {
        throw new StageFail('mirror', 'checksum', `the mirror does not match the checksum of run ${base.run}`);
      }
      say(`mirror: run ${base.run}, checksum matches`);
      return { state, githubDb: m.githubDb };
    });

    // ---- build ----
    const dir = await stage('build', async () => {
      const root = work ? resolve(work) : env.RUNNER_TEMP || tmpdir();
      mkdirSync(root, { recursive: true });
      const d = mkdtempSync(join(root, 'brain-ci-'));
      const codeDb = join(d, 'code.db');
      if (is('build:sleep')) {                                       // a build that hangs; a process it started ignores SIGTERM (T3)
        await runChild('build', process.execPath, ['-e', HANG], { cwd: src, limitMs: limitOf('build') });
      }
      await runChild('build', BRAIN, ['build', is('build:fail') ? join(d, 'no-such-checkout') : '.', '--db', codeDb], { cwd: src, limitMs: limitOf('build') });
      return { d, codeDb };
    });

    // ---- sync: GitHub, from the mirror's github.db (R3) ----
    await stage('sync', async () => {
      if (pulled?.githubDb) copyFileSync(pulled.githubDb, githubDbPath(dir.codeDb));
      const extra = { GH_TOKEN: token };
      if (is('sync:http500') || is('sync:rate-limit')) extra.BRAIN_REPLAY_DIR = faultReplay(dir.d, env.BRAIN_SOURCE_REPO, fault.point);
      const args = ['sync', '--db', dir.codeDb, ...(full ? ['--full'] : []), '--request-timeout', String(limits.requestMs / 1000),
        ...(limits.rateWaitMs === null ? [] : ['--max-rate-wait', String(limits.rateWaitMs / 1000)])];
      await runChild('sync', BRAIN, args, { cwd: src, extra, limitMs: limitOf('sync'), classify: syncKind });
    });

    // ---- outbound: snapshot, diff, the upload check (R16) ----
    const up = await stage('outbound', async () => {
      const manifest = C.validateManifest({ ...FULL, github: full ? 'full' : 'incremental' });
      let delta, checksum;
      try {
        const gh = githubDbPath(dir.codeDb);
        const next = snapshot({ codeDb: dir.codeDb, githubDb: existsSync(gh) ? gh : null, manifest });
        delta = diff(pulled?.state ?? null, next);
        checksum = C.checksum(applyDelta(pulled?.state ?? null, delta));
      } catch (e) { throw new StageFail('outbound', 'internal', `the delta could not be made (${e.code ?? 'error'})`); }
      if (is('outbound:secret')) delta.unresolved.put.push({ fact_key: 'fault', target: ['gh', 'p_'].join('') + 'Zx9'.repeat(12) });
      try { checkOutbound(delta); } catch (e) { throw new StageFail('outbound', 'outbound', e.message); }
      say(`delta: ${['nodes', 'items', 'edge', 'unresolved', 'link', 'ref_link'].map((t) => `${t} +${delta[t].put.length} -${delta[t].close.length}`).join(', ')}`);
      return { delta, checksum };
    });

    // ---- publish: one transaction ----
    const txLimits = { txTimeout: is('publish:sleep') && faultMs ? `${faultMs}ms` : limits.txTimeout, statementTimeout: limits.statementTimeout, lockTimeout: limits.lockTimeout };
    const hook = fault?.stage === 'publish' ? publishFault(fault.point, txLimits) : null;
    try {
      ({ run } = await stage('publish', () => publish({ url, attemptId, base: base?.run ?? null, delta: up.delta, checksum: up.checksum, mode,
        commit: prep.sourceSha, toolVersion: prep.toolVersion, repoDir: src, limits: txLimits, recordFailure: false, signal: abort.signal,
        onStage: async (name, ctx) => {
          if (name === 'committed') phase = 'committed';               // set before any await: a signal may come next
          if (name === 'rolled-back') phase = 'writing';
          if (hook) await hook(name, ctx);
          if (name === 'ok') phase = 'committing';                     // after the hook: a fault there commits nothing
        } })));
    } catch (e) {
      if (e.code === 'outcome-unknown') {                            // R12: never written over
        say(`ci-publish: OUTCOME UNKNOWN (publish:${e.stage}): the COMMIT reply was lost; do not publish again until the next run resolves it`);
        return end(C.CI_EXIT.outcomeUnknown);
      }
      if (!(e.code === 'aborted' && e.kind === 'outcome-unknown')) phase = 'writing';   // nothing was committed
      throw e instanceof StageFail ? e : new StageFail('publish', kindOf(e), e.message);
    }
    phase = 'committed';
    say(`published run ${run}`);
    if (is('verify:kill')) process.kill(process.pid, 'SIGKILL');    // F14: after COMMIT, before verify

    // ---- verify: a new connection; the cache moves to the new run ----
    try {
      await stage('verify', async () => {
        const m = await withLimit('verify', limitOf('verify'), () => pullMirror({ url, dir: cache, shapes: SHAPES, log: say }));
        if (m.run !== run) throw new StageFail('verify', 'stale-base', `the latest run is ${m.run}, not ${run}`);
      });
    } catch (e) {
      if (stopping) return end(C.CI_EXIT.verifyFailed);
      say(`ci-publish: run ${run} is committed, but verify failed (${kindOf(e)}): the next refresh checks the server`);
      return end(C.CI_EXIT.verifyFailed);
    }
    say(`verified: the latest run is ${run}; the mirror is at run ${run}`);
    return end(C.CI_EXIT.ok);
  } catch (e) {
    if (stopping) return end(C.CI_EXIT.failed);
    const st = e instanceof StageFail ? e.stage : current, kind = kindOf(e);
    say(`ci-publish: FAILED ${st}:${kind}: ${e.message}`);
    if (attemptId !== null) await record(st, kind);
    return end(C.CI_EXIT.failed);
  } finally {
    if (!stopping) process.off('SIGINT', onSignal).off('SIGTERM', onSignal);   // a second signal during cleanup is ignored
  }
}

/** F2: change one node of the cached mirror so it no longer matches its run (pullMirror must pull it again in full). */
function tamperMirror(dir, say) {
  const p = join(dir, MIRROR_DB);
  if (!existsSync(p)) { say('fault mirror:checksum: no cached mirror to change'); return; }
  const db = new DatabaseSync(p);
  try { db.exec("UPDATE nodes SET name = name || '-fault' WHERE id = (SELECT min(id) FROM nodes)"); } finally { db.close(); }
  say('fault mirror:checksum: one node of the cached mirror changed');
}

/** F4 / F5: a replay manifest (Phase 1 seam BRAIN_REPLAY_DIR) whose first request gets HTTP 500, or a rate limit 5 min long. */
function faultReplay(dir, repo, point) {
  const d = join(dir, 'fault-replay');
  mkdirSync(d, { recursive: true });
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const res = point === 'http500' ? { status: 500, body: { message: 'injected' } }
    : { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.parse(now) / 1000) + 300) }, body: { message: 'API rate limit exceeded' } };
  writeFileSync(join(d, 'manifest.json'), JSON.stringify({ now, routes: [{ path: `/repos/${repo}`, responses: [res] }] }));
  return d;
}

/** F7–F9, F12: publish's onStage hook for a publish fault point. */
function publishFault(point, limits) {
  const at = { 'after-nodes': 'nodes', 'after-items': 'items', 'after-sync-state': 'facts', 'after-attempt-ok': 'ok', kill: 'items',
    'drop-before-commit': 'ok', sleep: 'items' }[point];
  return async (name, { client }) => {
    if (name !== at) return;
    if (point === 'kill') process.kill(process.pid, 'SIGKILL');
    if (point === 'drop-before-commit') { client.connection.stream.destroy(); return; }
    if (point === 'sleep') {                                         // short statements until transaction_timeout ends it
      const each = Math.max(0.2, Math.min(durationMs(limits.statementTimeout) / 2, durationMs(limits.txTimeout) / 3) / 1000);
      for (;;) await client.query('SELECT pg_sleep($1)', [each]);
    }
    throw new BrainError('fault', `injected fault publish:${point}`, { stage: 'publish', kind: 'fault' });
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let o;
  try {
    ({ values: o } = parseArgs({ options: { source: { type: 'string' }, mirror: { type: 'string' }, work: { type: 'string' },
      full: { type: 'boolean', default: false }, mode: { type: 'string', default: 'normal' } } }));
  } catch (e) {
    console.log(`ci-publish: usage: ${e.code ?? 'bad arguments'}: --source DIR --mirror DIR [--work DIR] [--full] [--mode normal|bootstrap]`);
    process.exit(C.CI_EXIT.usage);
  }
  ciPublish({ source: o.source, mirror: o.mirror, work: o.work ?? null, full: o.full, mode: o.mode }).then((code) => process.exit(code));
}
