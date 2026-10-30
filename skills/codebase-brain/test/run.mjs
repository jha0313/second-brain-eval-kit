// Fixture test: the cases a real repo throws at the TS adapter, in 19 files.
// two tsconfigs with different `paths` · alias imports · a barrel with a renamed re-export · `const X` + `type X`
// · dynamic import() destructuring · a file in no tsconfig · a generated file · vi.mock · node_modules committed to git · a path over 100 chars
import { cpSync, mkdtempSync, existsSync, appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { markMentions } from '../src/why.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const brain = join(here, '..', 'bin', 'brain');
const repo = mkdtempSync(join(tmpdir(), 'brain-fixture-'));
cpSync(join(here, 'fixture'), repo, { recursive: true });
const sh = (cmd, args, env = {}) => execFileSync(cmd, args, { cwd: repo, encoding: 'utf8', env: { ...process.env, ...env } });
sh('git', ['init', '-q']);
sh('git', ['add', '-A', '-f']);
sh('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'fixture: reserve credits first (#12)']);
const db = join(repo, '..', `${repo.split('/').pop()}.db`);
sh(brain, ['build', '.', '--db', db]);
const q = (...args) => JSON.parse(sh(brain, [...args, '--json', '--limit', '1000'], { BRAIN_DB: db }));
const files = (r) => [...new Set(r.sites.map((s) => s.site.split(':')[0]))].sort();
const impacted = (r) => r.hops.flatMap((h) => h.paths).sort();

let n = 0;
const check = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const st = q('status');
check('two programs: the worker tsconfig has its own paths', () => assert.equal(st.stats.ts.programs, 2));
check('scripts/gen.mjs is in no tsconfig and still indexed', () => assert.equal(st.stats.ts.orphans, 1));
check('no unresolved local imports (aliases @/ and @w/ resolve)', () => assert.equal(st.stats.ts.unresolvedLocal, 0));
check('node_modules is not indexed even when committed', () => assert.equal(q('find', 'fake').rows.filter((r) => r.id.includes('node_modules')).length, 0));

check('refs reserve: direct, barrel, dynamic import() destructuring', () =>
  assert.deepEqual(files(q('refs', 'src/lib/credits.ts#reserve')), ['app/api/run/route.ts', 'app/dash/page.tsx', 'src/lib/charge.ts']));
check('the renamed re-export resolves to the original function', () =>
  assert.ok(files(q('refs', 'src/lib/charge.ts#charge')).includes('src/lib/routes.generated.ts')));
check('callers --filter server-action finds the use-server route', () =>
  assert.deepEqual(files(q('callers', 'src/lib/credits.ts#reserve', '--filter', 'server-action')), ['app/api/run/route.ts']));
check('instanceof through a destructured dynamic import counts as a use', () =>
  assert.ok(files(q('refs', 'src/lib/credits.ts#InsufficientCredits')).includes('app/api/run/route.ts')));
check('JSX render edge, filtered to pages', () =>
  assert.deepEqual(files(q('refs', 'src/ui/Meter.tsx#Meter', '--kind', 'renders', '--filter', 'page')), ['app/dash/page.tsx']));
check('`const Plan` and `type Plan` are two nodes', () =>
  assert.equal(q('find', 'Plan').rows.filter((r) => r.id.startsWith('src/lib/credits.ts#Plan')).length, 2));

const imp = q('impact', 'src/lib/credits.ts');
check('impact crosses programs: worker main.ts via a relative import, then @w/ alias', () => assert.ok(impacted(imp).includes('packages/worker/main.ts')));
check('impact reaches the generated file and the orphan script', () =>
  assert.ok(['src/lib/routes.generated.ts', 'scripts/gen.mjs'].every((p) => impacted(imp).includes(p))));
check('vi.mock is an edge; --no-mocks keeps the test only through its real import chain', () => {
  assert.ok(impacted(imp).includes('__tests__/charge.test.ts'));
  assert.equal(q('impact', 'src/lib/credits.ts', '--no-mocks').hops[0].paths.includes('__tests__/charge.test.ts'), false);
});

check('a route file nothing imports: impact 0 says it is reached by URL and what to grep', () => {
  const r = q('impact', 'app/api/run/route.ts');
  assert.equal(r.total, 0);
  assert.match(r.hint, /grep "\/api\/run"/);
  assert.match(sh(brain, ['impact', 'app/api/run/route.ts'], { BRAIN_DB: db, NO_COLOR: '1' }), /reached by URL.*grep "\/api\/run"/);
  assert.equal(q('impact', 'scripts/gen.mjs').hint, undefined);        // 0 importers, but not a route
});

const LONG = 'src/ui/billing/usage-meters/organization-settings/credit-balance-panels/CreditBalanceMeterWithLabel.tsx';
const narrow = (...args) => sh(brain, args, { BRAIN_DB: db, NO_COLOR: '1', COLUMNS: '100' });
check('refs never cuts a path: a long one goes whole on its own line (file table and site table)', () => {
  assert.ok(narrow('refs', 'src/ui/Meter.tsx', '--files').includes(LONG));
  assert.ok(narrow('refs', 'src/ui/Meter.tsx#Meter').includes(`${LONG}:5`));
});
check('refs --files --json gives one row per file, with the site count', () => {
  const r = q('refs', 'src/ui/Meter.tsx#Meter', '--files');
  assert.deepEqual(r.sites.map((s) => s.site.split(':')[0]), ['app/dash/page.tsx', LONG]);
  assert.equal(r.sites.find((s) => s.site.startsWith(LONG)).sites, 2);
});
check('deps of a symbol is the closure of its file, not a silent 0', () => {
  const r = q('deps', 'src/lib/charge.ts#charge');
  assert.ok(r.total > 0);
  assert.deepEqual(r.files, q('deps', 'src/lib/charge.ts').files);
  assert.equal(r.from, 'src/lib/charge.ts');
});

const w = q('why', 'why does reserve throw InsufficientCredits instead of returning false?');
check('why cites the doc and the change note, with the PR number', () => {
  const cites = w.citations.map((c) => c.cite).join(' ');
  assert.match(cites, /docs\/credits\.md:\d+-\d+/);
  assert.match(cites, /changes\/20261001-reserve-first\.md/);
  assert.ok(w.citations.some((c) => c.prs.includes('#12')));
});
const text = (...args) => sh(brain, args, { BRAIN_DB: db, NO_COLOR: '1' });
check('why marks a SHA-shaped build ID and a file that is not in the tree (display only)', () => {
  const ch = w.citations.find((c) => c.source === 'change');
  assert.deepEqual(ch.notCommits, ['4e5f6a7b']);
  assert.deepEqual(ch.notInTree, ['src/lib/legacy-credits.ts', 'app/api/run/[id]/route.ts']);   // whole, [param] included
  assert.deepEqual(w.citations.find((c) => c.source === 'doc').notInTree, []);       // src/lib/credits.ts exists
  const t = text('why', 'why does reserve throw InsufficientCredits instead of returning false?');
  assert.match(t, /4e5f6a7b \(not a commit\)/);
  assert.match(t, /src\/lib\/legacy-credits\.ts \(not in the tree\)/);
});
check('a name with 4+ exported owners links to none of them, and status counts it', () => {
  assert.deepEqual(st.stats.knowledge.unlinkedNames, { count: 1, examples: ['displayName'] });
  assert.ok(st.stats.knowledge.links['mentions-symbol'] > 0);                    // InsufficientCredits: one owner, linked
  assert.match(text('status'), /1 name with 4\+ exported owners not linked/);
});
check('a real commit SHA and a bare file name that exists are not marked', () => {
  const head = sh('git', ['rev-parse', 'HEAD']).trim().slice(0, 8);
  const r = { citations: [{ mentions: { shas: [head, '4e5f6a7b'], files: ['charge.ts', 'lib/credits.ts', 'gone.ts'] } }] };
  markMentions(repo, r);
  assert.deepEqual([r.citations[0].notCommits, r.citations[0].notInTree], [['4e5f6a7b'], ['gone.ts']]);
});
check('SKILL.md: description fits 1,024 chars, routes Korean questions, and names only flags brain has', () => {
  const skill = readFileSync(join(here, '..', 'SKILL.md'), 'utf8');
  const desc = skill.match(/^description: (.*)$/m)[1];
  assert.ok(desc.length <= 1024 && /[가-힣]/.test(desc));
  const help = sh(brain, ['--help']);
  for (const flag of new Set(skill.match(/--[a-z][a-z-]+/g))) assert.ok(help.includes(flag), flag);
});
check('viz writes one HTML file', () => assert.ok(existsSync(sh(brain, ['viz', 'src/lib/credits.ts', '--out', join(repo, '..', 'v.html')], { BRAIN_DB: db }).trim().replace(/^~(?=\/)/, homedir()))));

// freshness: every answer says whether the index still matches the checkout (these checks edit the fixture, so they run last)
const rebuild = () => JSON.parse(sh(brain, ['build', '.', '--db', db, '--if-stale', '--json']));
check('JSON answers carry freshness: fresh right after the build', () => {
  for (const r of [q('impact', 'src/lib/credits.ts'), q('refs', 'src/lib/credits.ts#reserve'), q('why', 'why reserve first?'), q('find', 'reserve')])
    assert.equal(r.freshness.state, 'fresh');
});
check('build --if-stale skips a fresh index', () => assert.equal(rebuild().skipped, true));
check('build --if-stale rebuilds when the build options differ, and always with --vault', () => {
  const skipped = (...extra) => JSON.parse(sh(brain, ['build', '.', '--db', db, '--if-stale', '--json', ...extra])).skipped;
  assert.equal(skipped('--no-knowledge'), false);
  assert.equal(skipped('--no-knowledge'), true);
  assert.equal(skipped(), false);                          // back to the default options
  assert.equal(skipped('--include-root', 'src'), false);
  assert.equal(skipped('--vault', 'docs'), false);
  assert.equal(skipped('--vault', 'docs'), false);         // vault notes are outside git: no way to tell they did not change
  assert.equal(skipped(), false);
  assert.equal(skipped(), true);
});
appendFileSync(join(repo, 'src/lib/charge.ts'), '// edited after the build\n');
check('an uncommitted edit makes JSON and why answers stale', () => {
  const r = q('why', 'why does reserve throw InsufficientCredits instead of returning false?');
  assert.equal(r.freshness.state, 'stale');
  assert.deepEqual(r.freshness.files, ['src/lib/charge.ts']);
  assert.match(text('why', 'why does reserve throw InsufficientCredits?'), /stale: .*1 file changed since the index/);
});
check('build --if-stale rebuilds a stale index, and the edit it indexed is no longer "changed"', () => {
  assert.equal(rebuild().skipped, false);
  assert.equal(q('status').state, 'fresh');
  assert.equal(rebuild().skipped, true);
});
check('a file with a Korean name: an edit after each build is "changed", under its real name', () => {
  appendFileSync(join(repo, 'notes/메모.txt'), '한 줄 더\n');
  assert.deepEqual(q('status').changed, ['notes/메모.txt']);
  assert.equal(rebuild().skipped, false);
  appendFileSync(join(repo, 'notes/메모.txt'), '또 한 줄\n');
  assert.equal(q('status').state, 'stale');
});
console.log(`${n} checks passed (fixture at ${repo})`);
