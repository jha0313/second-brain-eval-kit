// Fixture builds shared by lane B's tests (snapshot.test.mjs offline, publish.test.mjs on Neon). Build 1 is the golden
// fixture (test/pg/golden); later builds are later commits of the same checkout, each into its own code.db + github.db.
// No network. Git runs without user or system config.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, readFileSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import * as C from '../../src/pg/contract.mjs';
import { snapshot, factKeyOf } from '../../src/pg/snapshot.mjs';
import { githubDbPath } from '../../src/gh-schema.mjs';
import { runBrain } from '../phase1/helpers.mjs';
import { buildStores } from './golden/build-golden.mjs';
import { canaries, githubSecretCorpus, repoSecretCorpus, replayRoutes, writeReplay, setupRepo, sync } from '../security/lib.mjs';

Object.assign(process.env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });

export const FULL = Object.freeze({ map: 'full', docs: 'full', commits: 'append', github: 'full' });
export const INCR = Object.freeze({ ...FULL, github: 'incremental' });
export const OLD_COMMIT = 'commit:b070cb73666691f1bdd5fb238720ece1301fc069';   // the fixture commit (fixed dates, golden)
export const ROUTES = ['src/lib/routes.generated.ts', 'src/lib/routes.generated.ts#ROUTES@variable', 'src/lib/routes.generated.ts#displayName@variable'];
export const REFUND = ['src/lib/refund.ts', 'src/lib/refund.ts#refund@function'];

export const git = (repo, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, encoding: 'utf8' }).trim();
export function build(repo, db) {
  const r = runBrain(['build', '.', '--db', db], { cwd: repo, env: { BRAIN_DB: db } });
  assert.equal(r.status, 0, r.stderr);
}

/**
 * build 1 (golden) and build 2: routes.generated.ts deleted, refund.ts added, docs/credits.md edited, one new commit;
 * GitHub: issue 45 edited (s2), then ic:8 gone (s2full), then stamped by a full sync at sanitize_version 1 (s2v1).
 * more: also build 3 (packages/worker/main.ts renamed to start.ts), build 4 (routes.generated.ts back) and build 5 (a
 * commit on top of build 1 that is not an ancestor of build 4: main force-pushed).
 */
export function fixtureBuilds({ more = false } = {}) {
  const one = buildStores();
  const repo = one.codeDb.replace(/\.db$/, '');                         // fixtureRepo puts <repo>.db next to <repo>
  const out = { repo, one, sha1: git(repo, 'rev-parse', 'HEAD'), s1: snapshot({ codeDb: one.codeDb, githubDb: one.ghDb, manifest: INCR }) };
  const routes = readFileSync(join(repo, 'src/lib/routes.generated.ts'), 'utf8');
  const commitAndBuild = (n, message, ghFrom) => {
    git(repo, 'add', '-A', '-f');
    git(repo, 'commit', '-q', '-m', message);
    const codeDb = `${repo}-${n}.db`;
    build(repo, codeDb);
    copyFileSync(ghFrom, githubDbPath(codeDb));
    return { sha: git(repo, 'rev-parse', 'HEAD'), codeDb, ghDb: githubDbPath(codeDb) };
  };
  rmSync(join(repo, 'src/lib/routes.generated.ts'));
  writeFileSync(join(repo, 'src/lib/refund.ts'), 'export function refund(n: number) { return n; }\n');
  writeFileSync(join(repo, 'docs/credits.md'), `${readFileSync(join(repo, 'docs/credits.md'), 'utf8')}\nRefunds go through src/lib/refund.ts.\n`);
  const two = commitAndBuild(2, 'refund: give credits back', one.ghDb);
  out.sha2 = two.sha;
  out.newCommit = `commit:${two.sha}`;
  const gh = new DatabaseSync(two.ghDb);
  gh.exec("UPDATE items SET body = 'Failed runs keep their credits now. See src/lib/credits.ts', updated_at = '2026-11-14T00:00:00Z' WHERE ptr = 'issue:45'");
  out.s2 = snapshot({ codeDb: two.codeDb, githubDb: two.ghDb, manifest: INCR });
  const ghIssue = `${two.ghDb}.issue`;
  copyFileSync(two.ghDb, ghIssue);                                       // later builds keep ic:8 (incremental syncs)
  gh.exec("DELETE FROM items WHERE ptr = 'ic:8'; DELETE FROM refs WHERE ptr = 'ic:8'");
  out.s2full = snapshot({ codeDb: two.codeDb, githubDb: two.ghDb, manifest: FULL });
  gh.exec('UPDATE sync_state SET sanitize_version = 1');                 // what `brain sync --full` stamps (R15)
  gh.close();
  out.s2v1 = snapshot({ codeDb: two.codeDb, githubDb: two.ghDb, manifest: FULL });
  if (!more) return out;

  renameSync(join(repo, 'packages/worker/main.ts'), join(repo, 'packages/worker/start.ts'));
  const three = commitAndBuild(3, 'worker: rename main to start', ghIssue);
  out.sha3 = three.sha;
  out.s3 = snapshot({ codeDb: three.codeDb, githubDb: three.ghDb, manifest: INCR });
  writeFileSync(join(repo, 'src/lib/routes.generated.ts'), routes);
  const four = commitAndBuild(4, 'routes: generate again', ghIssue);
  out.sha4 = four.sha;
  out.s4 = snapshot({ codeDb: four.codeDb, githubDb: four.ghDb, manifest: INCR });
  git(repo, 'checkout', '-q', '-b', 'forced', out.sha1);                 // main rewritten from build 1
  writeFileSync(join(repo, 'docs/credits.md'), `${readFileSync(join(repo, 'docs/credits.md'), 'utf8')}\nRewritten history.\n`);
  const five = commitAndBuild(5, 'docs: rewritten', ghIssue);
  out.sha5 = five.sha;
  out.s5 = snapshot({ codeDb: five.codeDb, githubDb: five.ghDb, manifest: INCR });
  return out;
}

/** s as a build whose commit window no longer holds the fixture commit (Phase 0 keeps the newest 5,000 only) */
export const withoutOldCommit = (s) => ({ ...s, items: new Map([...s.items].filter(([p]) => p !== OLD_COMMIT)),
  link: new Map([...s.link].filter(([, l]) => l.ptr !== OLD_COMMIT)) });

/**
 * s as an older kit (sanitize_version 0) would have made it: repo items at version 0, their links following the new
 * hashes. leak: text appended to the fixture commit's body (a secret the old rules missed).
 */
export function atVersion0(s, leak = '') {
  const old = structuredClone(s);
  old.meta.sanitize_version = 0;
  for (const i of old.items.values()) {
    if (i.origin !== 'repo') continue;
    if (i.ptr === OLD_COMMIT && leak) i.chunks[0].body += `\n${leak}`;
    i.rev = C.repoItemRev(0);
    const was = C.hex(i.hash);
    i.hash = Buffer.from(C.itemHash(i.rev, i.chunks, []));
    old.link = new Map([...old.link].map(([k, l]) => {
      if (l.ptr !== i.ptr || l.revHash !== was) return [k, l];
      const moved = { ...l, revHash: C.hex(i.hash) };
      return [factKeyOf('link', moved), moved];
    }));
  }
  for (const n of old.nodes.values()) n.hash = Buffer.from(n.hash);   // structuredClone turns Buffers into Uint8Arrays
  for (const i of old.items.values()) i.hash = Buffer.from(i.hash);
  return old;
}

/** The Phase 1 T7 secret corpus, built and synced (replay, no network). @returns {{ reg: Map, state: object, repo: string, sha: string }} */
export function corpusState() {
  const reg = canaries();
  const gh = githubSecretCorpus(reg);
  const fx = setupRepo(repoSecretCorpus(reg));
  assert.equal(fx.build.status, 0, 'corpus build');
  assert.equal(sync(fx, writeReplay(replayRoutes(gh))).status, 0, 'corpus sync');
  return { reg, repo: fx.repo, sha: fx.head, state: snapshot({ codeDb: fx.codeDb, githubDb: fx.ghDb, manifest: FULL }) };
}
