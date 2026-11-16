// Token leak, black-box (design §6.3, §6.4 "토큰 자체", plan §3.4, §3.8 error exit). Every sync runs with GH_TOKEN /
// GITHUB_TOKEN set to canaries; in replay mode the active token is the seam's "replay-token", a canary as well.
// Error responses (401, 500, rate limits), every failpoint (BRAIN_FAIL_AT) and a foreign Link header must leave no
// token and no secret from an error body or header in stdout, stderr or the store bytes.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NOW, BASE, PULLS_Q, FAILPOINTS, STREAMS, ACTIVE_TOKEN, canaries, secret, rnd, addTokenCanaries, githubSecretCorpus, replayRoutes, override, writeReplay, ok, pr,
  setupRepo, sync, parseJson, brief, resetGithub, storeLeaks, outputLeaks,
} from './lib.mjs';

const reg = addTokenCanaries(canaries());
const gh = githubSecretCorpus(reg);
let fx;

before(() => { fx = setupRepo(); });

const date = new Date(NOW).toUTCString();
const SCENARIOS = [
  { name: '401 Bad credentials at getRepo', expect: 'failed',
    mutate: (r) => override(r, '', {}, [{ status: 401, headers: { date }, body: { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest', status: '401' } }]) },
  { name: '401 whose message echoes the active token (redactValues, not the masker, must catch it)', expect: 'failed',
    mutate: (r) => override(r, '', {}, [{ status: 401, headers: { date }, body: { message: `Bad credentials: ${ACTIVE_TOKEN}` } }]) },
  { name: '500 on pulls page 2 until the retries run out, a secret in the body and in a header', expect: 'failed',
    mutate: (r) => override(r, '/pulls', { ...PULLS_Q, page: '2' }, [{ status: 500, headers: { date, 'x-debug-echo': secret(reg, 'error-header@500', 'bearer') },
      body: { message: `Server Error near ${secret(reg, 'error-body@500', 'github-token')}` } }]) },
  { name: 'primary rate limit on the issues stream, then success', expect: 'ok',
    mutate: (r) => override(r, '/issues', STREAMS[0][2], (old) => [{ status: 403, headers: { date, 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(Date.parse(NOW) / 1000 + 300) }, body: { message: 'API rate limit exceeded for user ID 1.' } }, ...old]) },
  { name: 'secondary rate limit with retry-after on reviews until the retries run out', expect: 'failed',
    mutate: (r) => override(r, '/pulls/101/reviews', { per_page: '100' }, [{ status: 403, headers: { date, 'retry-after': '60' },
      body: { message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' } }]) },
  { name: '429 without retry-after on issue comments until the retries run out, a secret in the body', expect: 'failed',
    mutate: (r) => override(r, '/issues/comments', STREAMS[1][2], [{ status: 429, headers: { date }, body: { message: `slow down ${secret(reg, 'error-body@429', 'slack')}` } }]) },
];

// A run's verdict: the canaries first (that is the security property), then that the run really happened.
function verdict(runs, expect) {
  assert.deepEqual([...outputLeaks(reg, runs), ...storeLeaks(reg, fx.codeDb)], []);
  const last = runs.at(-1);
  const res = parseJson(last);
  assert.equal(res?.status, expect, `sync --json: ${brief(reg, last)}`);
  assert.equal(last.status, expect === 'ok' ? 0 : 1, 'exit code: 0 ok, 1 failed');
  if (expect === 'failed') assert.ok(typeof res.error === 'string' && res.error.length > 0, 'a failed run says why');
}

for (const s of SCENARIOS) {
  test(`token: ${s.name}: no token or secret in stdout, stderr or the stores`, () => {
    resetGithub(fx);
    const dir = writeReplay(s.mutate(replayRoutes(gh)));
    verdict([sync(fx, dir), sync(fx, dir, ['--json'])], s.expect);
  });
}

for (const name of FAILPOINTS) {
  test(`token: BRAIN_FAIL_AT=${name}: no token or secret in stdout, stderr or the stores`, () => {
    resetGithub(fx);
    const dir = writeReplay(replayRoutes(gh));
    const full = name === 'sync:full:before-swap';
    const env = { BRAIN_FAIL_AT: name };
    // a resumed run skips the PR file lists the failed run already stored, so it would not reach sync:files:N again:
    // check the first run's output and stores, then start the second from an empty github.db
    const runs = full ? [sync(fx, dir), sync(fx, dir, ['--full'], env), sync(fx, dir, ['--full', '--json'], env)]
      : [sync(fx, dir, [], env)];
    if (!full) {
      assert.deepEqual([...outputLeaks(reg, runs), ...storeLeaks(reg, fx.codeDb)], [], 'the first run');
      resetGithub(fx);
      runs.push(sync(fx, dir, ['--json'], env));
    }
    verdict(runs, name === 'sync:relink' ? 'ok' : 'failed');
  });
}

// Black-box, only a stored page is visible: a client that sends the request and then fails before storing it passes
// here. Seeing the request itself needs a request log from the replay seam (reported as a contract request).
test('token: a Link rel="next" to another host is never followed (the token would go with it)', () => {
  resetGithub(fx);
  const marker = canaries();
  const title = `exfil ${rnd('foreign-link', 24)}`;
  marker.set('foreign-link/title', title);
  const routes = replayRoutes(gh);
  routes.find((x) => x.path === `${BASE}/pulls` && !x.query.page).responses[0].headers.link = '<https://evil.example/exfil?page=2>; rel="next"';
  routes.push({ path: '/exfil', query: { page: '2' }, responses: [ok([pr({ number: 999, state: 'open', title, body: 'x', head: 'x', updated: '2026-09-01T10:00:00Z' })])] });
  const run = sync(fx, writeReplay(routes), ['--json']);
  assert.ok(['ok', 'failed'].includes(parseJson(run)?.status), `sync --json: ${brief(reg, run)}`);
  assert.deepEqual(storeLeaks(marker, fx.codeDb), [], 'the page behind the foreign link was fetched and stored');
  assert.deepEqual([...outputLeaks(reg, [run]), ...storeLeaks(reg, fx.codeDb)], []);
});
