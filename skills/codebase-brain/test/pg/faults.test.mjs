// S6: the fault runner (test/pg/faults.mjs). Offline: the multiset diff and the volatile-path drop. On one Neon branch:
// the round trip (raw ids change, the normalized dump does not) passes, and each wrong outcome fails (an extra run, a
// scenario that burns no id, a wrong stored checksum hash in the latest or an older run, a role or database setting left
// behind), so a passing F-scenario means something.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { neonSkip, createBranch } from './harness.mjs';
import { DUMP_VOLATILE_PATHS as VOLATILE_PATHS } from '../../src/pg/contract.mjs';
import { ROUNDTRIP, runSuite, dumpDiff, dropPath } from './faults.mjs';

let branch, pending = null;
const ready = () => (pending ??= createBranch('faults-test').then((b) => (branch = b)));   // Node 25: no root before()
after(async () => { await branch?.drop(); });

test('dumpDiff counts lines as a multiset', () => {
  assert.deepEqual(dumpDiff(['a', 'b', 'b'], ['b', 'a', 'b']), { gone: 0, extra: 0, sample: [] });
  assert.deepEqual(dumpDiff(['a', 'b', 'b'], ['a', 'b', 'c']), { gone: 1, extra: 1, sample: ['- b', '+ c'] });
});

test('volatile paths drop build stamps and keep the rest; refs.other keeps its keys', () => {
  const run = { run_id: 1, meta: { commit: 'x', built_at: 't', build_id: 'b', timings: { ts: 3 } },
    checksum: { node: { rows: 2, sha256: 'n' }, meta: { rows: 1, sha256: 'm' }, 'sync.github': { rows: 1, sha256: 's' } } };
  for (const p of VOLATILE_PATHS.run) dropPath(run, p);
  assert.deepEqual(run, { run_id: 1, meta: { commit: 'x' }, checksum: { node: { rows: 2, sha256: 'n' }, meta: { rows: 1 }, 'sync.github': { rows: 1 } } });
  const st = { state: { row: { cursor: 'T', run_pid: 9 }, refs: { build: 'b2', other: { k1: 'b1' } } } };
  for (const p of VOLATILE_PATHS.sync_state) dropPath(st, p);
  assert.deepEqual(st, { state: { row: { cursor: 'T' }, refs: { other: { k1: null } } } });
});

// the budget covers the harness's slot wait (up to 15 min) and then the two suites
test('the round trip passes; each wrong outcome fails: an extra run, no burned id, a bad stored hash, a leftover setting',
  { skip: neonSkip(), timeout: 1_500_000 }, async () => {
    await ready();
    const quiet = () => {};
    const [empty] = ROUNDTRIP.scenarios;
    const ok = await runSuite(ROUNDTRIP, { branch, log: quiet });
    assert.deepEqual(ok.map((r) => [r.name, r.ok]), [['empty', true]], ok[0]?.detail);
    const changed = { ...ROUNDTRIP, scenarios: [
      { name: 'extra-run', fault: async (ctx) => { await ROUNDTRIP.again(ctx); } },
      { name: 'no-burn', fault: async () => {}, after: empty.after },
      // the dump drops checksum hashes of build stamps; the read-back must still catch a stored hash that is wrong
      { name: 'bad-hash', fault: async () => {}, after: async (ctx) => {
        await ROUNDTRIP.clean(ctx);
        await ctx.branch.query('owner', `ALTER TABLE brain.run DISABLE TRIGGER refuse;
          UPDATE brain.run SET checksum = jsonb_set(checksum, '{meta,sha256}', '"0"') WHERE run_id = (SELECT max(run_id) FROM brain.run);
          ALTER TABLE brain.run ENABLE TRIGGER refuse;`);
      } },
      // an older run's stored hash is checked too: run 1 is broken, then a good run 2 is published on it
      { name: 'old-bad-hash', fault: async (ctx) => {
        await ctx.branch.query('owner', `ALTER TABLE brain.run DISABLE TRIGGER refuse;
          UPDATE brain.run SET checksum = jsonb_set(checksum, '{meta,sha256}', '"0"') WHERE run_id = (SELECT min(run_id) FROM brain.run);
          ALTER TABLE brain.run ENABLE TRIGGER refuse;`);
      } },
    ] };
    const bad = await runSuite(changed, { branch, log: quiet });
    assert.deepEqual(bad.map((r) => [r.name, r.ok]), [['extra-run', false], ['no-burn', false], ['bad-hash', false],
      ['old-bad-hash', false]], 'none may compare equal');
    assert.match(bad[0].detail, /dump differs: \d+ rows gone, \d+ extra/);
    assert.match(bad[1].detail, /the raw dump did not change: the scenario proves nothing/);
    assert.match(bad[2].detail, /checksum/i);
    assert.match(bad[3].detail, /checksum/i);
    // state outside the brain schemas survives resetSchema: a scenario that leaves it fails. One suite per leak, each
    // undone before the next, so neither passes on the other's leftover.
    for (const [name, set, reset] of [['leak', "ALTER ROLE brain_writer SET work_mem = '8MB'", 'ALTER ROLE brain_writer RESET work_mem'],
      ['leak-db', "ALTER DATABASE neondb SET work_mem = '8MB'", 'ALTER DATABASE neondb RESET work_mem']]) {
      try {
        const [r] = await runSuite({ ...ROUNDTRIP, scenarios: [{ name, fault: async (ctx) => { await ctx.branch.query('owner', set); } }] }, { branch, log: quiet });
        assert.equal(r.ok, false, name);
        assert.match(r.detail, /roles, grants or schemas outside brain changed/, name);
      } finally { await branch.query('owner', reset); }
    }
  });
