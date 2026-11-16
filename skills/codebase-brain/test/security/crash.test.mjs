// Crash safety, black-box (plan §5.2 S3, S7; design §6.3). BRAIN_CRASH_AT kills `brain sync` with SIGKILL at each
// failpoint: no finally block runs, the lock and maybe a hot journal or a --full temp store stay behind. Neither
// those leftovers nor the stores after the next sync may hold a canary, and the next sync must succeed.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import {
  FAILPOINTS, canaries, addTokenCanaries, githubSecretCorpus, replayRoutes, writeReplay, setupRepo, sync, parseJson, brief, resetGithub,
  storeFiles, storeLeaks, outputLeaks,
} from './lib.mjs';

const reg = addTokenCanaries(canaries());
const gh = githubSecretCorpus(reg);
let fx;

before(() => { fx = setupRepo(); });

for (const name of FAILPOINTS) {
  test(`crash: BRAIN_CRASH_AT=${name}: the leftovers and, after the next sync, the stores hold no canary`, () => {
    resetGithub(fx);
    const dir = writeReplay(replayRoutes(gh));
    const full = name === 'sync:full:before-swap';
    const args = full ? ['--full'] : [];
    if (full) {
      const first = sync(fx, dir);
      assert.equal(first.status, 0, `the first sync: ${brief(reg, first)}`);
    }
    const crash = sync(fx, dir, args, { BRAIN_CRASH_AT: name });
    assert.equal(crash.signal, 'SIGKILL', `killed at ${name}: ${brief(reg, crash)}`);
    assert.deepEqual(storeLeaks(reg, fx.codeDb), [], 'the lock, journal and temp store left by the crash');
    const next = sync(fx, dir, [...args, '--json']);
    const res = parseJson(next);
    assert.equal(res?.status, 'ok', `the next sync: ${brief(reg, next)}`);
    assert.equal(res.staleLock, true, 'the next sync cleared the dead lock');
    assert.deepEqual([...outputLeaks(reg, [crash, next]), ...storeLeaks(reg, fx.codeDb)], []);
    const leftovers = storeFiles(fx.codeDb).map((f) => basename(f)).filter((n) => /-journal$|\.full-tmp|\.lock/.test(n));
    assert.deepEqual(leftovers, [], 'no journal, temp store or lock after a successful sync');
  });
}
