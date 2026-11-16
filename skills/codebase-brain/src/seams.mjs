// Test seams for subprocess tests (P0, implemented). Black-box tests (lane S, lane I) run bin/brain and steer it
// only through these environment variables; nothing else in the code reads test-only state.
//
//   BRAIN_REPLAY_DIR=<dir>   `brain sync` uses replayTransport(<dir>) + virtualClock(manifest.now) and the token
//                            GH_TOKEN || GITHUB_TOKEN || "replay-token" from the environment, so black-box tests see the
//                            active token travel the real paths; readToken() and gh are never called, no network request
//                            is made. Every request goes to <dir>/requests.log as "METHOD URL" (never headers)
//   BRAIN_FAIL_AT=<name>     failpoint(<name>) throws BrainError('injected') (a normal failure: finally blocks run)
//   BRAIN_CRASH_AT=<name>    failpoint(<name>) kills the process with SIGKILL (a crash: no finally, lock left behind)
//
// Failpoint names (lane G calls them in gh-sync.mjs, in this order of a run):
//   sync:after-repo        after getRepo() and the repo-id check, before any write
//   sync:page:<n>          right after the n-th page transaction COMMITs (n counts every page of the run, from 1)
//   sync:files:<n>         right after the n-th PR's file list is stored
//   sync:final:before      before the final transaction BEGINs
//   sync:final:inside      inside the final transaction, after the cursor UPDATE, before COMMIT (must roll back)
//   sync:full:before-swap  --full: the temp store is complete and closed, before the rename
//   sync:relink            relink() fails (the sync result must still be ok)
import { BrainError } from './errors.mjs';
import { replayTransport, virtualClock } from './replay.mjs';

/** @returns {{ transport: Function, clock: object, token: string, replay: true } | null} */
export function replaySeams(env = process.env) {
  const dir = env.BRAIN_REPLAY_DIR;
  if (!dir) return null;
  const transport = replayTransport(dir);
  const token = env.GH_TOKEN || env.GITHUB_TOKEN || 'replay-token';
  return { transport, clock: virtualClock(transport.now), token, replay: true };
}

/** @param {string} name @param {NodeJS.ProcessEnv} [env] */
export function failpoint(name, env = process.env) {
  if (env.BRAIN_CRASH_AT === name) process.kill(process.pid, 'SIGKILL');
  if (env.BRAIN_FAIL_AT === name) throw new BrainError('injected', `injected failure at ${name}`);
}
