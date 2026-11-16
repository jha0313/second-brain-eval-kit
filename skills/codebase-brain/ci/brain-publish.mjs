#!/usr/bin/env node
// Phase 2 publish driver for ci/brain-publish.yml (design §6.3). Phase 3 S2 replaces it with `brain ci-publish`.
//   node ci/brain-publish.mjs --source <source checkout> --mirror <mirror dir> --work <scratch dir> [--full]
// env: BRAIN_WRITER_URL (only this process reads it), BRAIN_SOURCE_REPO (owner/name, written in the workflow file: R1),
//      BRAIN_SOURCE_TOKEN (read token for the source repo); GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_REPOSITORY and
//      GITHUB_WORKFLOW_REF come from Actions.
// Order (only this; stage limits, signals and the rest are Phase 3): attempt (R1, R2) -> the mirror of the base run,
// checked against run.checksum (R3) -> build and sync as child processes -> snapshot, diff, upload check (R16) -> publish
// (R9–R13; it resolves a lost COMMIT itself, R12). The Actions cache keeps the mirror of the base run; the next run moves
// it forward. No child process gets the writer URL. Only sync gets the source (read) token, as GH_TOKEN, and its git calls
// inherit it (Phase 1 code). Build and sync run with BRAIN_TYPESCRIPT=kit: the source repo's own typescript (its code)
// is never loaded. Every failure after
// the attempt starts is recorded with failAttempt (R11) unless publish recorded it or the COMMIT outcome is unknown.
// Child output and every log line are masked (R16) before printing.
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { copyFileSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as C from '../src/pg/contract.mjs';
import { snapshot, diff, applyDelta, checkOutbound } from '../src/pg/snapshot.mjs';
import { beginAttempt, publish, failAttempt } from '../src/pg/publish.mjs';
import { pullMirror } from '../src/pg/mirror.mjs';
import { githubDbPath } from '../src/gh-schema.mjs';
import { redactValues, sanitizeLine } from '../src/sanitize.mjs';

const KIT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BRAIN = join(KIT, 'bin', 'brain');
const FULL = Object.freeze({ map: 'full', docs: 'full', commits: 'append', github: 'full' });

const env = process.env;
const { values: opt } = parseArgs({ options: { source: { type: 'string' }, mirror: { type: 'string' }, work: { type: 'string' },
  full: { type: 'boolean', default: false } } });
const url = env.BRAIN_WRITER_URL, token = env.BRAIN_SOURCE_TOKEN;
const hidden = [url, token];
try { hidden.push(decodeURIComponent(new URL(url).password)); } catch { /* checked in main */ }
const say = (s) => console.log(redactValues(sanitizeLine(String(s)), hidden));

class StageError extends Error {
  constructor(stage, message) { super(message); this.code = `${stage}-failed`; this.stage = stage; this.recorded = false; }
}

// what every child process (and git) sees: the job's environment without any credential
const SECRET = /^(BRAIN_WRITER_URL|BRAIN_READER_URL|BRAIN_SOURCE_TOKEN|GH_TOKEN|GITHUB_TOKEN|DATABASE_URL.*|ACTIONS_.*)$/;
const childEnv = Object.fromEntries(Object.entries(env).filter(([k]) => !SECRET.test(k)));
const git = (args) => execFileSync('git', args, { env: childEnv, encoding: 'utf8' }).trim();

function child(stage, args, { cwd, extra = {} }) {               // streams its output (a first sync takes many minutes)
  const p = spawn(BRAIN, args, { cwd, env: { ...childEnv, BRAIN_TYPESCRIPT: 'kit', ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const out of [p.stdout, p.stderr]) createInterface({ input: out }).on('line', (line) => say(`  ${stage}: ${line}`));
  return new Promise((done, failed) => p.on('error', failed).on('close', (code, signal) =>
    (code === 0 ? done() : failed(new StageError(stage, `brain ${args[0]} exited with ${code ?? signal}`)))));
}

async function sourceRepoId(repo) {                // R1: the binding holds the numeric id (a renamed repo keeps it)
  const res = await fetch(`https://api.github.com/repos/${repo}`, { signal: AbortSignal.timeout(30_000),
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' } });
  if (!res.ok) throw new StageError('begin', `GET /repos/${repo}: HTTP ${res.status}`);
  return (await res.json()).id;
}

async function main() {
  const need = { BRAIN_WRITER_URL: url, BRAIN_SOURCE_REPO: env.BRAIN_SOURCE_REPO, BRAIN_SOURCE_TOKEN: token, GITHUB_RUN_ID: env.GITHUB_RUN_ID,
    GITHUB_RUN_ATTEMPT: env.GITHUB_RUN_ATTEMPT, GITHUB_REPOSITORY: env.GITHUB_REPOSITORY, GITHUB_WORKFLOW_REF: env.GITHUB_WORKFLOW_REF,
    '--source': opt.source, '--mirror': opt.mirror, '--work': opt.work };
  for (const [k, v] of Object.entries(need)) if (!v) throw new StageError('begin', `${k} is not set`);
  const src = resolve(opt.source), mirrorDir = resolve(opt.mirror), work = resolve(opt.work);
  const sourceSha = git(['-C', src, 'rev-parse', 'HEAD']);                 // the source commit, not github.sha (the ops repo)
  // owner/repo/.github/workflows/brain-publish.yml@refs/heads/main -> .github/workflows/brain-publish.yml
  const workflow = env.GITHUB_WORKFLOW_REF.slice(env.GITHUB_REPOSITORY.length + 1).replace(/@.*$/, '');
  const toolVersion = `codebase-brain@${JSON.parse(readFileSync(join(KIT, 'package.json'), 'utf8')).version}`;
  const { attemptId, base } = await beginAttempt({ url, sourceSha,
    gha: { runId: Number(env.GITHUB_RUN_ID), attempt: Number(env.GITHUB_RUN_ATTEMPT) },
    binding: { sourceRepoId: await sourceRepoId(env.BRAIN_SOURCE_REPO), sourceRepo: env.BRAIN_SOURCE_REPO, opsRepo: env.GITHUB_REPOSITORY, workflow } });
  say(`attempt ${attemptId}: source ${sourceSha.slice(0, 12)}, base run ${base?.run ?? 'none (first publish)'}`);
  let at = 'mirror';                                                    // the stage a plain error (ENOSPC, ...) is recorded under
  try {
    // R3: the base state is the mirror of run B, and it must match run[B].checksum
    let baseState = null, mirror = null;
    if (base) {
      try { mirror = await pullMirror({ url, dir: mirrorDir, run: base.run, shapes: ['code', 'github'] }); }
      catch (e) { throw new StageError('mirror', `the mirror of run ${base.run} could not be pulled (${e.code ?? 'error'})`); }
      baseState = snapshot({ codeDb: mirror.codeDb, githubDb: mirror.githubDb, manifest: C.validateManifest(FULL) });
      if (baseState.run !== base.run || C.canonicalJson(C.checksum(baseState)) !== C.canonicalJson(base.checksum)) {
        throw new StageError('mirror', `the mirror does not match the checksum of run ${base.run}`);
      }
      say(`mirror: run ${base.run}, checksum matches`);
    }
    // R4: the map and the repo memory are rebuilt from the checkout; sync continues from the mirror's github.db (R3)
    at = 'build';
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    const codeDb = join(work, 'code.db');
    await child('build', ['build', '.', '--db', codeDb], { cwd: src });
    at = 'sync';
    if (mirror?.githubDb) copyFileSync(mirror.githubDb, githubDbPath(codeDb));
    await child('sync', ['sync', '--db', codeDb, ...(opt.full ? ['--full'] : [])], { cwd: src, extra: { GH_TOKEN: token } });
    at = 'snapshot';
    const manifest = C.validateManifest({ ...FULL, github: opt.full ? 'full' : 'incremental' });
    let delta, checksum;
    try {
      const next = snapshot({ codeDb, githubDb: existsSync(githubDbPath(codeDb)) ? githubDbPath(codeDb) : null, manifest });
      delta = diff(baseState, next);
      checksum = C.checksum(applyDelta(baseState, delta));
    } catch (e) { throw new StageError('snapshot', `${e.code ?? 'error'}: ${e.message}`); }
    try { checkOutbound(delta); } catch (e) { throw Object.assign(e, { stage: 'outbound', recorded: false }); }
    at = 'publish';
    say(`delta: ${['nodes', 'items', 'edge', 'unresolved', 'link', 'ref_link'].map((t) => `${t} +${delta[t].put.length} -${delta[t].close.length}`).join(', ')}`);
    const { run } = await publish({ url, attemptId, base: base?.run ?? null, delta, checksum, mode: 'normal', commit: sourceSha, toolVersion, repoDir: src });
    say(`published run ${run}`);
  } catch (e) {
    if (e.recorded !== true && e.code !== 'outcome-unknown') {         // R12: an unknown outcome is never written over
      const kind = String(e.code ?? 'error').toLowerCase();               // failAttempt stores unknown kinds as 'other'
      const r = await failAttempt({ url, attemptId, stage: e.stage ?? at, error: kind }).catch(() => null);
      if (!r) say('the failure could not be recorded: the attempt stays running (shown as abandoned)');
    }
    throw e;
  }
}

main().catch((e) => {
  say(`brain-publish failed: ${e.code ?? 'error'}${e.stage ? ` (stage ${e.stage})` : ''}: ${e.message}`);
  process.exit(e.code === 'outcome-unknown' ? 2 : 1);
});
