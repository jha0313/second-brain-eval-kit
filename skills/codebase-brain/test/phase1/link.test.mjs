// Lane D: extraction (pure) and relink against a real fixture build, a hand-made github.db and the fixture's git.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { extractRefs, fileRefs, relink } from '../../src/link.mjs';
import { withWriteLock } from '../../src/gh-schema.mjs';
import { fixtureRepo, makeGithubDb, lockState } from './helpers.mjs';

const pairs = (refs) => refs.map((r) => `${r.kind} ${r.target} ${r.origin}`).sort();

test('extractRefs: every row of the extraction table, nothing else', () => {
  const body = [
    'Touches src/lib/credits.ts and the services/billing/ folder, `charge.ts` too.',
    'InsufficientCredits is thrown; `reserve` runs first; short ones like FoBar are not symbols.',
    'Shipped in 6b820f87 (see https://github.com/o/r/commit/a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0); 12345678 and deadbeefcafe are not SHAs, nor is 123e4567-e89b-12d3-a456-426614174000.',
    'fixes #45, see #1149, O/R#12, other/repo#7 and https://github.com/o/r/pull/1121#discussion_r9 and https://github.com/x/y/issues/3',
    'Calls https://api.example.com/health, `/status`, POST /api/run and /v2/charge/{id}; not /single or /, not 2026/11/16.',
    'Queues: `jobs.reserve`, `credits:settle`, `JOB_RUN_QUEUE`, `run-now`; plain credits.refund is not a name.',
  ].join('\n');
  const refs = extractRefs({ ptr: 'pr:1121', kind: 'pr', title: 'Charge after run (#1121)', body }, { selfRepo: 'o/r' });
  assert.deepEqual(pairs(refs), [
    'commit 6b820f87 text', 'commit a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0 text',
    'dir services/billing text',
    'file charge.ts text', 'file src/lib/credits.ts text',
    'item #1149 text', 'item #12 text', 'item #45 text', 'item other/repo#7 text', 'item x/y#3 text',   // pr:1121 itself: no ref
    'name JOB_RUN_QUEUE text', 'name credits:settle text', 'name jobs.reserve text', 'name run-now text',
    'route /api/run text', 'route /health text', 'route /status text', 'route /v2/charge/{id} text',
    'symbol InsufficientCredits text', 'symbol JOB_RUN_QUEUE text', 'symbol reserve text',
  ].sort());
  assert.equal(new Set(refs.map((r) => `${r.kind} ${r.target}`)).size, refs.length);                // deduplicated
});

test('extractRefs: inline comment path, merge SHA only for a merged PR', () => {
  assert.deepEqual(extractRefs({ ptr: 'rc:7', kind: 'review_comment', body: 'nit', path: 'src/lib/credits.ts' }),
    [{ kind: 'file', target: 'src/lib/credits.ts', origin: 'inline' }]);
  const sha = 'a1b2c3d4'.repeat(5);
  assert.deepEqual(extractRefs({ ptr: 'pr:12', kind: 'pr', state: 'merged', merged_at: '2026-10-01T00:00:00Z', merge_sha: sha, title: 'x', body: '' }),
    [{ kind: 'commit', target: sha, origin: 'merge-sha' }]);
  assert.deepEqual(extractRefs({ ptr: 'pr:13', kind: 'pr', state: 'open', merge_sha: sha, title: 'x', body: '' }), []);
});

test('extractRefs: a redacted value, or a reference glued to one, gives no ref', () => {
  const refs = extractRefs({
    ptr: 'rc:8', kind: 'review_comment', path: '[REDACTED:github-token:ab12]/k.ts',
    body: 'see src/[REDACTED:github-token:ab12]/x.ts, `[REDACTED:api-key]`, `jobs.[REDACTED:assignment]` and docs/credits.md',
  }, { selfRepo: 'o/r' });
  assert.deepEqual(refs, [{ kind: 'file', target: 'docs/credits.md', origin: 'text' }]);
});

test('fileRefs: one ref per file, a rename adds the old path, duplicates dropped', () => {
  assert.deepEqual(fileRefs([{ filename: 'src/a.ts' }, { filename: 'src/b.ts', previous_filename: 'src/old-b.ts' }, { filename: 'src/a.ts' }]), [
    { kind: 'file', target: 'src/a.ts', origin: 'pr-files' },
    { kind: 'file', target: 'src/b.ts', origin: 'pr-files' },
    { kind: 'file', target: 'src/old-b.ts', origin: 'pr-files' },
  ]);
});

// ---------- relink: one fixture build shared by the tests below (they run in order, each with a fresh github.db) ----------

const extraFiles = {
  'src/jobs/queue.ts': "export const JOB_RUN_QUEUE = 'jobs.reserve';\n",
  'notes/odd.txt': '$(id) and -x-flag\n',
  ...Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`notes/settle-${String(i + 1).padStart(2, '0')}.txt`, 'credits:settle\n'])),
  // the token-search stress case (plan A31): 1,000 lines with one even token each, a name and a route in 15 files × 200
  // lines, and a token only inside a binary blob
  'notes/bulk.txt': Array.from({ length: 1000 }, (_, k) => `entry ${k + 1}: bulk-token-${String(2 * k).padStart(4, '0')}`).join('\n') + '\n',
  ...Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`notes/hot-${String(i + 1).padStart(2, '0')}.txt`,
    Array.from({ length: 200 }, (_, k) => `HotToken at /api/hot/path ${k}`).join('\n') + '\n'])),
  'notes/blob.bin': '\0BinaryOnlyToken\n',
};
const fx = fixtureRepo({ extraFiles });
const head = execFileSync('git', ['-C', fx.repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const buildId = () => {
  const db = new DatabaseSync(fx.codeDb, { readOnly: true });
  const id = JSON.parse(db.prepare("SELECT value FROM meta WHERE key = 'build_id'").get().value);
  db.close();
  return id;
};
const freshGh = (refs, items = [{ number: 1121 }, { kind: 'issue', number: 45 }]) => {
  rmSync(fx.ghDb, { force: true });
  makeGithubDb(fx.codeDb, { items, refs: refs.map((r) => ({ ptr: 'pr:1121', origin: 'text', ...r })) });
};
const rows = () => {
  const db = new DatabaseSync(fx.ghDb, { readOnly: true });
  const out = db.prepare('SELECT kind, target, origin, status, reason, resolved, resolved_build FROM refs ORDER BY rowid').all()
    .map((r) => ({ ...r, resolved: JSON.parse(r.resolved ?? 'null') }));
  db.close();
  return Object.fromEntries(out.map((r) => [`${r.kind} ${r.target} ${r.origin}`, r]));
};
const verdict = ({ status, reason, resolved }) => [status, reason, resolved];
const run = (opts = {}) => relink({ codeDbPath: fx.codeDb, repoDir: fx.repo, ...opts });

test('relink: no github.db -> null', async () => {
  rmSync(fx.ghDb, { force: true });
  assert.equal(await run(), null);
  assert.equal(existsSync(fx.ghDb), false);
});

test('relink: every kind against code.db, git and github.db', async () => {
  freshGh([
    { kind: 'file', target: 'src/lib/credits.ts', origin: 'pr-files' },
    { kind: 'file', target: 'src/lib/settle-later.ts', origin: 'pr-files' },
    { kind: 'file', target: 'src/lib/charge', origin: 'pr-files' },               // stored paths are exact: no extension tries
    { kind: 'file', target: '[REDACTED:github-token:ab12]/k.ts', origin: 'pr-files' },
    { kind: 'file', target: 'src/lib/credits.ts', origin: 'inline' },
    { kind: 'file', target: 'src/lib/credits' },
    { kind: 'file', target: 'charge.ts' },
    { kind: 'file', target: 'route.ts' },
    { kind: 'dir', target: 'src/ui' },
    { kind: 'symbol', target: 'reserve' },
    { kind: 'symbol', target: 'displayName' },
    { kind: 'symbol', target: 'NoSuchThing' },
    { kind: 'symbol', target: 'JOB_RUN_QUEUE' },
    { kind: 'commit', target: head.slice(0, 8) },
    { kind: 'commit', target: head, origin: 'merge-sha' },
    { kind: 'commit', target: 'deadbee0' },
    { kind: 'item', target: '#1121' },
    { kind: 'item', target: '#45' },
    { kind: 'item', target: '#999' },
    { kind: 'item', target: 'other/repo#7' },
    { kind: 'route', target: '/api/run' },
    { kind: 'route', target: '/dash' },
    { kind: 'route', target: '/api/app/status' },
    { kind: 'route', target: '/src/lib/credits.ts' },
    { kind: 'route', target: '/v9/nothing/here' },
    { kind: 'name', target: 'jobs.reserve' },
    { kind: 'name', target: 'credits:settle' },
    { kind: 'name', target: 'JOB_RUN_QUEUE' },
    { kind: 'name', target: 'tsconfig.json' },
    { kind: 'name', target: 'no.such-token' },
  ]);
  const res = await run();
  const r = rows();
  const expect = {
    'file src/lib/credits.ts pr-files': ['linked', null, ['src/lib/credits.ts']],
    'file src/lib/settle-later.ts pr-files': ['unlinked', 'not-in-index', []],
    'file src/lib/charge pr-files': ['unlinked', 'not-in-index', []],
    'file [REDACTED:github-token:ab12]/k.ts pr-files': ['unlinked', 'redacted', []],
    'file src/lib/credits.ts inline': ['linked', null, ['src/lib/credits.ts']],
    'file src/lib/credits text': ['linked', null, ['src/lib/credits.ts']],
    'file charge.ts text': ['linked', null, ['src/lib/charge.ts']],
    'file route.ts text': ['ambiguous', 'too-many', ['app/api/app/status/route.ts', 'app/api/run/route.ts']],
    'dir src/ui text': ['linked', null, ['src/ui']],
    'symbol reserve text': ['linked', null, ['src/lib/credits.ts#reserve']],
    'symbol displayName text': ['ambiguous', 'too-many', [
      'packages/worker/lib/job.ts#displayName', 'src/lib/routes.generated.ts#displayName', 'src/ui/Meter.tsx#displayName',
      'src/ui/billing/usage-meters/organization-settings/credit-balance-panels/CreditBalanceMeterWithLabel.tsx#displayName']],
    'symbol NoSuchThing text': ['unlinked', 'no-match', []],
    'symbol JOB_RUN_QUEUE text': ['linked', null, ['src/jobs/queue.ts#JOB_RUN_QUEUE']],
    [`commit ${head.slice(0, 8)} text`]: ['linked', null, [`commit:${head.slice(0, 8)}`]],
    [`commit ${head} merge-sha`]: ['linked', null, [`commit:${head}`]],
    'commit deadbee0 text': ['unlinked', 'not-local', []],
    'item #1121 text': ['linked', null, ['pr:1121']],
    'item #45 text': ['linked', null, ['issue:45']],
    'item #999 text': ['unlinked', 'not-synced', []],
    'item other/repo#7 text': ['unlinked', 'external-repo', []],
    'route /api/run text': ['linked', null, ['app/api/run/route.ts']],
    'route /dash text': ['linked', null, ['app/dash/page.tsx']],
    'route /api/app/status text': ['linked', null, ['app/api/app/status/route.ts']],
    'route /src/lib/credits.ts text': ['linked', null, ['src/lib/credits.ts']],
    'route /v9/nothing/here text': ['unlinked', 'no-match', []],
    'name jobs.reserve text': ['linked', null, ['src/jobs/queue.ts:1']],
    'name JOB_RUN_QUEUE text': ['linked', null, ['src/jobs/queue.ts#JOB_RUN_QUEUE']],   // the symbol already links it: no grep
    'name tsconfig.json text': ['linked', null, ['tsconfig.json']],                     // a tracked file, not a string
    'name no.such-token text': ['unlinked', 'no-match', []],
  };
  for (const [k, v] of Object.entries(expect)) assert.deepEqual(verdict(r[k]), v, k);
  const settle = r['name credits:settle text'];                                            // 11 files: too many, first 10 kept
  assert.deepEqual([settle.status, settle.reason, settle.resolved.length], ['ambiguous', 'too-many', 10]);
  assert.ok(settle.resolved.every((x) => /^notes\/settle-\d\d\.txt:1$/.test(x)));

  const build = buildId();
  assert.ok(Object.values(r).every((x) => x.resolved_build === build));
  const n = (s) => Object.values(r).filter((x) => x.status === s).length;
  assert.deepEqual(res, { linked: n('linked'), ambiguous: n('ambiguous'), unlinked: n('unlinked'), pending: 0, build });
  assert.equal(existsSync(`${fx.ghDb}-journal`), false);
});

test('relink: a stale resolved_build is resolved again, a current one is left alone', async () => {
  const build = buildId();
  freshGh([
    { kind: 'file', target: 'src/lib/credits.ts', status: 'linked', resolved: ['gone.ts'], resolved_build: 'oldbuild' },
    { kind: 'symbol', target: 'reserve', status: 'linked', resolved: ['gone.ts#reserve'] },                     // never resolved
    { kind: 'file', target: 'src/lib/charge.ts', status: 'unlinked', reason: 'not-in-index', resolved: [], resolved_build: build },
  ]);
  await run();
  const r = rows();
  assert.deepEqual(verdict(r['file src/lib/credits.ts text']), ['linked', null, ['src/lib/credits.ts']]);
  assert.equal(r['file src/lib/credits.ts text'].resolved_build, build);
  assert.deepEqual(verdict(r['symbol reserve text']), ['linked', null, ['src/lib/credits.ts#reserve']]);
  assert.deepEqual(verdict(r['file src/lib/charge.ts text']), ['unlinked', 'not-in-index', []]);           // current: not looked at
});

test('relink: a not-synced item ref links once a later sync stores the item, with no new build', async () => {
  freshGh([{ kind: 'item', target: '#46' }]);
  await run();
  assert.deepEqual(verdict(rows()['item #46 text']), ['unlinked', 'not-synced', []]);
  const db = new DatabaseSync(fx.ghDb);
  db.prepare("INSERT INTO items(ptr, kind, number) VALUES ('issue:46', 'issue', 46)").run();
  db.close();
  await run();
  assert.deepEqual(verdict(rows()['item #46 text']), ['linked', null, ['issue:46']]);
});

test('relink: over the grep budget -> pending/budget, retried by the next relink', async () => {
  freshGh([{ kind: 'name', target: 'jobs.reserve' }, { kind: 'file', target: 'src/lib/credits.ts' }]);
  const logs = [];
  const res = await run({ budget: { bytes: 1, ms: 20000 }, log: (s) => logs.push(s) });
  let r = rows();
  assert.deepEqual(verdict(r['name jobs.reserve text']), ['pending', 'budget', []]);
  assert.equal(r['name jobs.reserve text'].resolved_build, buildId());
  assert.deepEqual(verdict(r['file src/lib/credits.ts text']), ['linked', null, ['src/lib/credits.ts']]);     // index lookups still done
  assert.equal(res.pending, 1);
  assert.ok(logs.some((s) => s.includes('budget')));
  await run();
  r = rows();
  assert.deepEqual(verdict(r['name jobs.reserve text']), ['linked', null, ['src/jobs/queue.ts:1']]);
});

test('relink: 2,000 tokens, a name and a route with thousands of hits, all decided in one relink, none pending (plan A31)', async () => {
  const bulk = Array.from({ length: 2000 }, (_, i) => `bulk-token-${String(i).padStart(4, '0')}`);
  freshGh([...bulk.map((target) => ({ kind: 'name', target })), { kind: 'name', target: 'HotToken' },
    { kind: 'route', target: '/api/hot/path' }, { kind: 'name', target: 'BinaryOnlyToken' }]);
  const res = await run();
  const r = rows();
  assert.equal(res.pending, 0);
  for (const [i, t] of bulk.entries()) {
    assert.deepEqual(verdict(r[`name ${t} text`]), i % 2 ? ['unlinked', 'no-match', []] : ['linked', null, [`notes/bulk.txt:${i / 2 + 1}`]], t);
  }
  for (const key of ['name HotToken text', 'route /api/hot/path text']) {
    const v = r[key];
    assert.deepEqual([v.status, v.reason, v.resolved.length], ['ambiguous', 'too-many', 10], key);   // decided, never pending
    assert.ok(v.resolved.every((x) => /^notes\/hot-\d\d\.txt:1$/.test(x)), key);             // first line per file
  }
  assert.deepEqual(verdict(r['name BinaryOnlyToken text']), ['unlinked', 'no-match', []]);    // binary blobs are skipped (-I)
});

test('relink: targets shaped like options or shell never reach a command line', async () => {
  const marker = join(mkdtempSync(join(tmpdir(), 'brain-link-')), 'pwned');
  freshGh([
    { kind: 'name', target: '-x' },
    { kind: 'name', target: '--' },
    { kind: 'name', target: '$(id)' },
    { kind: 'name', target: '-x-flag' },
    { kind: 'name', target: `--open-files-in-pager=touch ${marker}` },
    { kind: 'name', target: `-Otouch ${marker}` },
    { kind: 'route', target: `/$(touch ${marker})/x` },
  ]);
  const res = await run();
  const r = rows();
  assert.deepEqual(verdict(r['name -x text']), ['unlinked', 'no-match', []]);                // too short to be a grep pattern
  assert.deepEqual(verdict(r['name -- text']), ['unlinked', 'no-match', []]);
  assert.deepEqual(verdict(r['name $(id) text']), ['linked', null, ['notes/odd.txt:1']]);     // matched as a fixed string
  assert.deepEqual(verdict(r['name -x-flag text']), ['linked', null, ['notes/odd.txt:1']]);
  assert.deepEqual(verdict(r[`name --open-files-in-pager=touch ${marker} text`]), ['unlinked', 'no-match', []]);
  assert.deepEqual(verdict(r[`name -Otouch ${marker} text`]), ['unlinked', 'no-match', []]);
  assert.deepEqual(verdict(r[`route /$(touch ${marker})/x text`]), ['unlinked', 'no-match', []]);
  assert.equal(existsSync(marker), false);
  assert.equal(res.pending, 0);                                                               // git grep did not fail
});

test('relink runs inside the caller\'s write lock and never takes it itself', async () => {
  freshGh([{ kind: 'file', target: 'src/lib/credits.ts' }]);
  const { value } = await withWriteLock(fx.codeDb, () => run());
  assert.equal(value.linked, 1);                                             // a nested withWriteLock would have thrown lock-busy
  assert.equal(lockState(fx.codeDb), 'clean');
});

test('brain build relinks an existing github.db against the new build', async () => {
  freshGh([{ kind: 'file', target: 'src/lib/credits.ts', status: 'linked', resolved: ['src/lib/credits.ts'], resolved_build: buildId() }]);
  const before = buildId();
  const out = fx.brain(['build', '.', '--db', fx.codeDb, '--json']);
  assert.equal(out.status, 0, out.stderr);
  const after = buildId();
  assert.notEqual(after, before);
  assert.deepEqual(JSON.parse(out.stdout).relink, { linked: 1, ambiguous: 0, unlinked: 0, pending: 0, build: after });
  assert.equal(rows()['file src/lib/credits.ts text'].resolved_build, after);
});

// last: it moves the shared fixture's checkout past the indexed commit
test('relink resolves paths against the indexed commit, not the checkout as it is now', async () => {
  const sh = (...args) => execFileSync('git', ['-C', fx.repo, ...args], { encoding: 'utf8' });
  writeFileSync(join(fx.repo, 'src/lib/added-later.ts'), 'export const later = 1;\n');
  sh('rm', '-q', 'src/lib/charge.ts');
  sh('add', '-A');
  sh('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'after the build');
  freshGh([
    { kind: 'file', target: 'src/lib/charge.ts', origin: 'pr-files' },
    { kind: 'file', target: 'src/lib/added-later.ts', origin: 'pr-files' },
  ]);
  await run();
  const r = rows();
  assert.deepEqual(verdict(r['file src/lib/charge.ts pr-files']), ['linked', null, ['src/lib/charge.ts']]);
  assert.deepEqual(verdict(r['file src/lib/added-later.ts pr-files']), ['unlinked', 'not-in-index', []]);
});
