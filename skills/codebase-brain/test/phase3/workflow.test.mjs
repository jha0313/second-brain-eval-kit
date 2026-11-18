// Phase 3 S7 finding 2: the source checkout of ci/brain-publish.yml and ci/brain-bootstrap.yml fetches main only.
// fetch-depth 0 fetched every branch and tag of the source repo and printed their names in the job log (a secret in a
// branch name, in clear). The checkout now asks for refs/heads/main at git's infinite depth. Offline: the workflow
// files are read for the two inputs, and actions/checkout's fetch for a positive depth is replayed against a temp
// upstream with other branches and tags, to show that publish still gets the history it needs (the commit memory and
// the ancestry check, R9) and nothing else.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const CI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'ci');
const WORKFLOWS = ['brain-publish.yml', 'brain-bootstrap.yml'];
const ENV = { PATH: process.env.PATH, HOME: tmpdir(), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** the `with:` inputs of the step named "check out the source repo main" */
function sourceCheckout(file) {
  const text = readFileSync(join(CI, file), 'utf8');
  const at = text.indexOf('- name: check out the source repo main');
  assert.ok(at >= 0, `${file}: no source checkout step`);
  const step = text.slice(at, text.indexOf('\n      - ', at + 1));
  return Object.fromEntries([...step.matchAll(/^\s{10}([\w-]+):\s*(.+)$/gm)].map((m) => [m[1], m[2].trim()]));
}

/** an upstream whose main has a merge, plus a branch named like a token, a branch main-other, and tags */
function upstream() {
  const dir = mkdtempSync(join(tmpdir(), 'brain-wf-up-'));
  const c = (msg) => git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', msg);
  git(dir, 'init', '-q', '-b', 'main');
  for (let i = 1; i <= 4; i++) c(`main ${i}`);
  git(dir, 'switch', '-q', '-c', 'feature');
  c('feature 1');
  git(dir, 'switch', '-q', 'main');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'merge', '-q', '--no-ff', '-m', 'merge feature', 'feature');
  c('main 5');
  const tokenName = `rotate/${['gh', 'p_'].join('')}${'A1b2C3d4'.repeat(4)}`;   // fake, built at runtime
  git(dir, 'switch', '-q', '-c', tokenName, 'main~2');
  c('only on the token branch');
  const offMain = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'switch', '-q', 'main');
  git(dir, 'branch', 'main-other', 'main~1');
  git(dir, 'tag', 'v-secret-tag', 'main~3');
  git(dir, 'tag', 'main-tag', 'main~1');
  return { dir, tokenName, offMain, mainLog: git(dir, 'log', '--format=%H', 'main').split('\n') };
}

/** actions/checkout v7 for a positive fetch-depth: init, one refspec for the ref, --depth, no tags, then -B main */
function checkout(up, { ref, depth }) {
  const dst = mkdtempSync(join(tmpdir(), 'brain-wf-src-'));
  git(dst, 'init', '-q');
  git(dst, 'remote', 'add', 'origin', `file://${up.dir}`);
  const refspec = ref.startsWith('refs/heads/') ? `+${ref}:refs/remotes/origin/${ref.slice('refs/heads/'.length)}`
    : `+refs/heads/${ref}*:refs/remotes/origin/${ref}*`;   // checkout's pattern for an unqualified name (no tag part needed here)
  const f = spawnSync('git', ['-c', 'protocol.version=2', 'fetch', '--no-tags', '--prune', '--no-recurse-submodules', `--depth=${depth}`, 'origin', refspec],
    { cwd: dst, env: ENV, encoding: 'utf8' });
  assert.equal(f.status, 0, f.stderr);
  git(dst, 'checkout', '-q', '--force', '-B', 'main', 'refs/remotes/origin/main');
  return { dir: dst, log: f.stdout + f.stderr };
}

describe('S7 finding 2: the source checkout fetches main only', () => {
  for (const file of WORKFLOWS) {
    test(`${file}: ref refs/heads/main at git's infinite depth (no fetch-depth 0)`, () => {
      const w = sourceCheckout(file);
      assert.equal(w.ref, 'refs/heads/main');
      assert.equal(w['fetch-depth'], '2147483647');
      assert.equal(w['persist-credentials'], 'false');
    });
  }

  test('replayed checkout: the complete main history (merge included), not shallow, and no other ref', () => {
    const up = upstream();
    const w = sourceCheckout('brain-publish.yml');
    const src = checkout(up, { ref: w.ref, depth: w['fetch-depth'] });
    assert.equal(git(src.dir, 'rev-parse', '--is-shallow-repository'), 'false');
    // the commit memory reads `git log … HEAD`; the build and the diff read main's commits
    assert.deepEqual(git(src.dir, 'log', '--format=%H', 'HEAD').split('\n'), up.mainLog);
    assert.deepEqual(git(src.dir, 'for-each-ref', '--format=%(refname)').split('\n').sort(), ['refs/heads/main', 'refs/remotes/origin/main']);
    assert.equal(git(src.dir, 'tag', '--list'), '');
    for (const name of [up.tokenName, 'main-other', 'v-secret-tag', 'main-tag', 'feature']) {
      assert.ok(!src.log.includes(name), `the fetch output names ${name}`);
    }
    // R9 (publish.mjs descends): an older main commit is an ancestor of HEAD; a commit that is not on main (a rewritten
    // main's old tip) is not in the checkout at all, so the check fails as before (not-descendant, nothing written)
    const root = up.mainLog.at(-1);
    assert.equal(spawnSync('git', ['merge-base', '--is-ancestor', root, 'HEAD'], { cwd: src.dir, env: ENV }).status, 0);
    assert.notEqual(spawnSync('git', ['merge-base', '--is-ancestor', up.offMain, 'HEAD'], { cwd: src.dir, env: ENV }).status, 0);
  });

  test('control: the old inputs would have fetched and printed the other refs', () => {
    const up = upstream();
    const dst = mkdtempSync(join(tmpdir(), 'brain-wf-old-'));
    git(dst, 'init', '-q');
    git(dst, 'remote', 'add', 'origin', `file://${up.dir}`);
    // fetch-depth 0: checkout's refspec for all history
    const f = spawnSync('git', ['fetch', '--prune', '--no-recurse-submodules', 'origin', '+refs/heads/*:refs/remotes/origin/*', '+refs/tags/*:refs/tags/*'],
      { cwd: dst, env: ENV, encoding: 'utf8' });
    assert.equal(f.status, 0, f.stderr);
    assert.ok((f.stdout + f.stderr).includes(up.tokenName), 'the old refspec printed the token-named branch');
    // ref: main (unqualified) with a positive depth: the pattern main* also takes main-other
    const g = checkout(up, { ref: 'main', depth: '2147483647' });
    assert.ok(git(g.dir, 'for-each-ref', '--format=%(refname)').includes('refs/remotes/origin/main-other'));
  });
});
