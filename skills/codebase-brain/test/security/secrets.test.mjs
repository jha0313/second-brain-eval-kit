// Secret corpus, black-box (plan §3.10, design §6.4, T7): every kind of §6.4 is planted in every GitHub location
// (replayed through BRAIN_REPLAY_DIR) and in the repo (doc, change note, commit message, file name, symbol name).
// Oracle: the exact canary strings. None may occur in the store files or in any command's stdout / stderr.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fixtureRepo } from '../phase1/helpers.mjs';
import {
  OWNER, REPO, canaries, secret, identSecret, addTokenCanaries, githubSecretCorpus, repoSecretCorpus, replayRoutes, writeReplay,
  setupRepo, cli, sync, parseJson, brief, storeLeaks, outputLeaks, leaksIn, dbText, itemCount,
} from './lib.mjs';

const reg = addTokenCanaries(canaries());
const gh = githubSecretCorpus(reg);
const corpus = repoSecretCorpus(reg);
const originToken = identSecret(reg, 'origin-url', 'github-token');
const runs = {};
let fx, html;

before(() => {
  fx = setupRepo({ ...corpus, origin: `https://x-access-token:${originToken}@github.com/${OWNER}/${REPO}.git` });
  const replay = writeReplay(replayRoutes(gh));
  const read = (...args) => cli(fx, args);
  runs.build = [fx.build];
  runs.sync = [sync(fx, replay), sync(fx, replay, ['--json'])];
  const searches = [
    read('search', 'rotation', '--limit', '50'), read('search', 'rotation', '--limit', '50', '--json'),
    read('search', 'credentials', '--kind', 'pr,issue,review,comment'), read('search', 'rotation', '--kind', 'doc,change,commit', '--limit', '50', '--json'),
  ];
  const repoPtrs = [...new Set(searches.flatMap((r) => parseJson(r)?.rows ?? []).map((row) => row.ptr).filter((p) => !/^(pr|issue|review|rc|ic):/.test(p)))];
  const ptrs = [...gh.ptrs, `commit:${fx.head.slice(0, 8)}`];
  const gets = [];
  for (let i = 0; i < ptrs.length; i += 5) gets.push(read('get', ...ptrs.slice(i, i + 5)), read('get', ...ptrs.slice(i, i + 5), '--json'));
  const sources = [...new Set([...ptrs, ...repoPtrs])].flatMap((p) => [read('source', p), read('source', p, '--json')]);
  runs.read = [...searches, ...gets, ...sources];
  runs.phase0 = [
    read('why', 'credential rotation runbook'), read('why', 'credential rotation runbook', '--json'), read('why', 'slack workspace hook rotation'),
    read('find', 'rotate'), read('find', 'rotate', '--json'), read('find', 'vault-keys'), read('find', 'vault-keys', '--json'), read('status'), read('status', '--json'),
    read('refs', 'src/lib/credits.ts'), read('refs', 'src/lib/credits.ts#reserve', '--json'), read('callers', 'src/lib/credits.ts#reserve'),
    read('impact', 'src/lib/credits.ts'), read('impact', 'src/lib/credits.ts', '--json'), read('deps', 'app/api/run/route.ts'), read('shared', 'src/lib', 'app'),
  ];
  const out = mkdtempSync(join(tmpdir(), 'brain-s-viz-'));
  html = [join(out, 'credits.html'), join(out, 'vault-keys.html')];
  runs.viz = [read('viz', 'src/lib/credits.ts', '--out', html[0]), read('viz', 'src/lib/vault-keys.ts', '--out', html[1])];
});

const codeStore = (l) => l.startsWith('<store>.db');
const githubStore = (l) => l.startsWith('<store>.github.db');

test('secrets: code.db holds no canary (doc, change note, commit message, file name, symbol name)', () => {
  assert.equal(fx.build.status, 0, `build: ${brief(reg, fx.build)}`);
  assert.deepEqual(storeLeaks(reg, fx.codeDb).filter(codeStore), []);
  const rows = dbText(fx.codeDb) ?? '';
  assert.ok(rows.includes('Rotate leaked deploy credentials') && rows.includes('credential rotation runbook'), 'the corpus was indexed, not skipped');
  assert.match(rows, /\[REDACTED:/, 'the corpus is stored masked');
});

test('secrets: github.db, its journal and temp files hold no canary (titles, bodies, branches, comments, reviews, file paths)', () => {
  assert.deepEqual(storeLeaks(reg, fx.codeDb).filter(githubStore), []);
  assert.ok(itemCount(fx.ghDb) >= 12, `github.db holds the synced corpus (items: ${itemCount(fx.ghDb)}); sync --json: ${brief(reg, runs.sync[1])}`);
  assert.match(dbText(fx.ghDb) ?? '', /\[REDACTED:/, 'the corpus is stored masked, not dropped');
});

test('secrets: build, sync and sync --json print no canary', () => {
  assert.deepEqual(outputLeaks(reg, [...runs.build, ...runs.sync]), []);
  assert.equal(parseJson(runs.sync[1])?.status, 'ok', `sync --json: ${brief(reg, runs.sync[1])}`);
});

test('secrets: search, get and source print no canary (text and --json)', () => {
  assert.deepEqual(outputLeaks(reg, runs.read), []);
  assert.ok(parseJson(runs.read[1])?.rows?.length > 0, `search --json found the corpus: ${brief(reg, runs.read[1])}`);
  const quoted = runs.read.filter((r) => r.args[0] === 'source' && !r.args.includes('--json') && r.stdout.startsWith('── quote '));
  assert.ok(quoted.length > gh.ptrs.length, `source quoted every GitHub item and the commit (${quoted.length})`);
});

test('secrets: why, find, status and the graph commands (refs, callers, impact, deps, shared) print no canary', () => {
  assert.deepEqual(outputLeaks(reg, runs.phase0), []);
  assert.ok(parseJson(runs.phase0[1])?.citations?.length > 0, `why --json cites the corpus: ${brief(reg, runs.phase0[1])}`);
});

// HTML may escape "/" and "+" inside embedded JSON or entities: look for the plain form as well.
const unescapeHtml = (s) => s.replace(/\\\/|&#x2[fF];|&#47;/g, '/').replace(/&#x2[bB];|&#43;/g, '+').replace(/&amp;/g, '&');

test('secrets: viz stdout, stderr and the HTML files hold no canary', () => {
  assert.deepEqual(outputLeaks(reg, runs.viz), []);
  for (const f of html) {
    assert.ok(existsSync(f), `viz wrote ${basename(f)}: ${brief(reg, runs.viz[html.indexOf(f)])}`);
    const text = readFileSync(f, 'utf8');
    assert.deepEqual([...new Set([...leaksIn(reg, text), ...leaksIn(reg, unescapeHtml(text))])], [], basename(f));
  }
});

test('secrets: runtime values (query echo, bad pointers, error messages) are masked in stdout and stderr', () => {
  const echo = addTokenCanaries(canaries());
  const [q1, q2, q3] = [['query', 'github-token'], ['query', 'aws-key'], ['query', 'api-key']].map(([loc, k]) => identSecret(echo, loc, k));
  const q4 = secret(echo, 'query', 'bearer');
  const r = [
    cli(fx, ['search', q1]), cli(fx, ['search', q4]), cli(fx, ['why', `why was ${q1} rotated`]), cli(fx, ['find', q2]),
    cli(fx, ['get', `pr:${q1}`]), cli(fx, ['get', `pr:${q1}`, '--json']), cli(fx, ['get', q3]),
    cli(fx, ['source', `doc:docs/${q2}.md:1-2@abcdefgh`]), cli(fx, ['source', `doc:docs/${q2}.md:1-2@abcdefgh`, '--json']),
  ];
  assert.deepEqual(outputLeaks(echo, r), []);
  assert.ok(r.slice(4).every((x) => x.status === 1), 'a bad or unknown pointer is an error (exit 1)');
});

test('secrets: a secret in the checkout path never reaches code.db or the text output', () => {
  const ck = addTokenCanaries(canaries());
  const base = fixtureRepo({ build: false });
  const repo = join(dirname(base.repo), `${basename(base.repo)}-${identSecret(ck, 'checkout-path', 'aws-key')}`);
  renameSync(base.repo, repo);
  const f = { repo, codeDb: base.codeDb };
  const r = [cli(f, ['build', '.', '--db', f.codeDb]), cli(f, ['status']), cli(f, ['why', 'why reserve first?']), cli(f, ['find', 'reserve']), cli(f, ['search', 'reserve'])];
  assert.equal(r[0].status, 0, `build: ${brief(ck, r[0])}`);
  assert.deepEqual([...outputLeaks(ck, r), ...storeLeaks(ck, f.codeDb)], []);
});
