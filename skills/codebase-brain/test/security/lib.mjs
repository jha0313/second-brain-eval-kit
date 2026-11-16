// Shared pieces of the black-box security tests (lane S). The tests drive bin/brain only, through the CLI and the
// P0 seams (BRAIN_REPLAY_DIR, BRAIN_FAIL_AT, BRAIN_CRASH_AT), and judge by file bytes and exact canary strings,
// never by the masker's own patterns (plan §3.10).
//
// Fake secrets are built at runtime from fragments ('gh' + 'p_' + …): this branch is pushed to a public repo with
// push protection, so no complete secret-shaped literal may appear in these files (harness.test.mjs checks it).
import { createHash } from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BRAIN, fixtureRepo } from '../phase1/helpers.mjs';

export const OWNER = 'o', REPO = 'r', REPO_ID = 4242;
export const NOW = '2026-11-15T10:00:00Z';                 // virtual clock start and the server Date of every response
export const WINDOW = '2026-11-15T09:00:00Z';              // cursor NOW − 1 h (R2): `since` of the next incremental run
const DATE = new Date(NOW).toUTCString();
const API = 'https://api.github.com';
const B = `/repos/${OWNER}/${REPO}`;
export const BASE = B;

// ---------------------------------------------------------------------------------------------------- canaries

const D = '0123456789', UP = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', LOW = 'abcdefghijklmnopqrstuvwxyz';
const B62 = D + UP + LOW, UD = UP + '234567', B64 = B62 + '+/', B64URL = B62 + '-_';
// Invisible characters are built from code points, so none is ever written into these sources.
export const U = (...cps) => String.fromCodePoint(...cps);
export const sha = (s, n = 40) => createHash('sha256').update(String(s)).digest('hex').slice(0, n);

/** Deterministic random-looking text: the same seed always gives the same canary, different seeds differ. */
export function rnd(seed, n, abc = B62) {
  let out = '';
  for (let i = 0; out.length < n; i++) {
    for (const b of createHash('sha256').update(`${seed}#${i}`).digest()) if (out.length < n) out += abc[b % abc.length];
  }
  return out;
}

export const SECRET_KINDS = ['github-token', 'aws-key', 'slack', 'private-key', 'api-key', 'jwt', 'url-credential', 'bearer', 'assignment'];
export const ONE_LINE_KINDS = SECRET_KINDS.filter((k) => k !== 'private-key');

const one = (v) => [v, [v]];
const after = (prefix, v) => [prefix + v, [v]];                 // the prefix may stay after masking, the value may not
const jwt = (s) => 'ey' + 'JhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' + 'ey' + 'J' + rnd(s, 40, B64URL) + '.' + rnd(`${s}:sig`, 43, B64URL);
const pem = (edge) => `-----${edge} RSA ` + 'PRIVATE' + ' KEY-----';

// Real-world shapes of each kind of design §6.4. Each returns [text to plant, needles that must never come out].
const SHAPES = {
  'github-token': ['p_', 'o_', 'u_', 's_', 'r_'].map((p) => (s) => one('gh' + p + rnd(s, 36)))
    .concat((s) => one('github' + '_pat_' + rnd(s, 22) + '_' + rnd(`${s}:2`, 59))),
  'aws-key': [(s) => one('AK' + 'IA' + rnd(s, 16, UD)), (s) => one('AS' + 'IA' + rnd(s, 16, UD)),
    (s) => after('aws_secret' + '_access_key = ', rnd(s, 40, B64))],
  slack: [(s) => one('xo' + 'xb-' + rnd(s, 12, D) + '-' + rnd(`${s}:2`, 13, D) + '-' + rnd(`${s}:3`, 24)),
    (s) => one('xo' + 'xp-' + rnd(s, 12, D) + '-' + rnd(`${s}:2`, 13, D) + '-' + rnd(`${s}:3`, 32, LOW + D)),
    (s) => { const p = 'T' + rnd(s, 10, UD) + '/B' + rnd(`${s}:2`, 10, UD) + '/' + rnd(`${s}:3`, 24); return ['https://hooks.slack' + '.com/services/' + p, [p]]; }],
  'private-key': [(s) => { const body = [1, 2, 3].map((i) => rnd(`${s}:${i}`, 64, B64)); return [[pem('BEGIN'), ...body, pem('END')].join('\n'), body]; }],
  'api-key': [(s) => one('sk' + '-ant-api03-' + rnd(s, 80) + 'AA'), (s) => one('sk' + '-' + rnd(s, 48)),
    (s) => one('sk' + '_live_' + rnd(s, 24)), (s) => one('rk' + '_live_' + rnd(s, 24)), (s) => one('AI' + 'za' + rnd(s, 35))],
  jwt: [(s) => one(jwt(s))],
  'url-credential': [(s) => { const pw = rnd(s, 20); return ['https://deploy:' + pw + '@git.example.com/infra.git', [pw]]; },
    (s) => { const pw = rnd(s, 16); return ['postgres://app:' + pw + '@db.internal:5432/app', [pw]]; }],
  bearer: [(s) => after('Authorization: Bearer ', rnd(s, 40)), (s) => after('Authorization: ' + 'token ', rnd(s, 40))],
  assignment: [(s) => { const v = rnd(s, 12); return ['pass' + 'word = "' + v + '"', [v]]; }, (s) => after('client_' + 'secret: ', rnd(s, 14)),
    (s) => after('api_' + 'key=', rnd(s, 18)), (s) => { const v = rnd(s, 10); return ['sec' + "ret: '" + v + "'", [v]]; }, (s) => after('pass' + 'wd=', rnd(s, 11))],
};

// Shapes that fit inside a branch name, a file path or (github-token, aws-key, api-key) a symbol name.
const IDENT = {
  'github-token': (s) => 'gh' + 'p_' + rnd(s, 36),
  'aws-key': (s) => 'AK' + 'IA' + rnd(s, 16, UD),
  slack: (s) => 'xo' + 'xb-' + rnd(s, 12, D) + '-' + rnd(`${s}:2`, 13, D) + '-' + rnd(`${s}:3`, 24),
  'api-key': (s) => 'sk' + '_live_' + rnd(s, 24),
  jwt,
};

const pick = (arr, seed) => arr[parseInt(sha(seed, 8), 16) % arr.length];

/** A canary registry: id ("<location>/<kind>") -> exact needle. Ids, not values, go into assertion messages. */
export const canaries = () => new Map();

/** Plant one secret of `kind` for location `loc`; returns the text to put there. */
export function secret(reg, loc, kind) {
  const id = `${loc}/${kind}`;
  const [text, needles] = pick(SHAPES[kind], id)(id);
  needles.forEach((n, i) => reg.set(needles.length > 1 ? `${id}#${i + 1}` : id, n));
  return text;
}

/** An identifier-shaped secret (branch, path, symbol). */
export function identSecret(reg, loc, kind) {
  const id = `${loc}/${kind}`;
  const v = IDENT[kind](id);
  reg.set(id, v);
  return v;
}

/** The same secret split by zero-width characters (normalize must join it before masking): both forms are needles. */
export function zwSplit(reg, loc, kind) {
  const v = identSecret(reg, loc, kind);
  const split = v.match(/.{1,6}/g).join(U(0x200B));
  reg.set(`${loc}/${kind}#zw`, split);
  return split;
}

/** A short literal password (T7): masked whatever its length. */
export function shortPassword(reg, loc) {
  const v = rnd(`${loc}/short-password`, 6);
  reg.set(`${loc}/assignment#short`, v);
  return 'pass' + `word: "${v}"`;
}

// Labels carry no assignment keyword, so each secret is caught (or not) by its own kind's rule.
export const secretLines = (reg, loc, kinds = SECRET_KINDS) =>
  kinds.map((k, i) => `rotation step ${i + 1}:${k === 'private-key' ? '\n' : ' '}${secret(reg, loc, k)}`).join('\n');
export const secretLine = (reg, loc, kinds) => kinds.map((k, i) => `(${i + 1}) ${secret(reg, loc, k)}`).join(' · ');

// Token canaries in the environment of every run. In replay mode the active token is "replay-token" (seams.mjs):
// it is a canary too, since the token may appear only in the Authorization header.
export const ACTIVE_TOKEN = 'replay-' + 'token';
export const TOKEN_ENV = { GH_TOKEN: 'brain' + 'TokCanary' + rnd('env:GH_TOKEN', 28, LOW + D), GITHUB_TOKEN: 'gh' + 'p_' + rnd('env:GITHUB_TOKEN', 36) };
export function addTokenCanaries(reg) {
  reg.set('env/GH_TOKEN', TOKEN_ENV.GH_TOKEN);
  reg.set('env/GITHUB_TOKEN', TOKEN_ENV.GITHUB_TOKEN);
  reg.set('seam/active-token', ACTIVE_TOKEN);
  return reg;
}

// ----------------------------------------------------------------------------------------- GitHub REST objects

const user = (login, type = 'User') => ({ login, id: parseInt(sha(login, 6), 16), type, site_admin: false, html_url: `https://github.com/${login}` });

export function pr({ number, state, title, body, head, author = 'alice', assoc = 'MEMBER', created = '2026-09-01T10:00:00Z', updated, draft = false }) {
  const closed = state !== 'open';
  return {
    url: `${API}${B}/pulls/${number}`, id: 50_000 + number, node_id: `PR_${number}`, html_url: `https://github.com/${OWNER}/${REPO}/pull/${number}`,
    number, state: closed ? 'closed' : 'open', locked: false, title, user: user(author), body, labels: [], milestone: null,
    created_at: created, updated_at: updated, closed_at: closed ? updated : null, merged_at: state === 'merged' ? updated : null,
    merge_commit_sha: sha(`merge-${number}`), assignees: [], requested_reviewers: [], draft,
    head: { label: `${OWNER}:${head}`, ref: head, sha: sha(`head-${number}`), user: user(OWNER, 'Organization') },
    base: { label: `${OWNER}:main`, ref: 'main', sha: sha(`base-${number}`), user: user(OWNER, 'Organization') },
    author_association: assoc, auto_merge: null,
  };
}

export function issue({ number, state, title, body, author = 'bob', assoc = 'CONTRIBUTOR', created = '2026-09-02T10:00:00Z', updated }) {
  return {
    url: `${API}${B}/issues/${number}`, id: 60_000 + number, node_id: `I_${number}`, html_url: `https://github.com/${OWNER}/${REPO}/issues/${number}`,
    number, title, user: user(author), labels: [], state, locked: false, comments: 1, created_at: created, updated_at: updated,
    closed_at: state === 'closed' ? updated : null, author_association: assoc, body, state_reason: state === 'closed' ? 'completed' : null,
  };
}

/** The issues API lists every PR too (R5): the same title and body, plus a pull_request field. */
export const prAsIssue = (p) => ({
  ...issue({ number: p.number, state: p.state, title: p.title, body: p.body, author: p.user.login, assoc: p.author_association, created: p.created_at, updated: p.updated_at }),
  html_url: p.html_url, pull_request: { url: p.url, html_url: p.html_url, diff_url: `${p.html_url}.diff`, patch_url: `${p.html_url}.patch`, merged_at: p.merged_at },
});

export function issueComment({ id, number, body, author = 'carol', assoc = 'CONTRIBUTOR', updated }) {
  return {
    url: `${API}${B}/issues/comments/${id}`, id, node_id: `IC_${id}`, html_url: `https://github.com/${OWNER}/${REPO}/issues/${number}#issuecomment-${id}`,
    issue_url: `${API}${B}/issues/${number}`, user: user(author), created_at: updated, updated_at: updated, author_association: assoc, body,
  };
}

export function reviewComment({ id, number, review, path, body, diffHunk = '@@ -1,2 +1,3 @@\n line\n+line', replyTo = null, line = 3, author = 'dave', assoc = 'MEMBER', updated }) {
  return {
    url: `${API}${B}/pulls/comments/${id}`, id, node_id: `RC_${id}`, pull_request_review_id: review, diff_hunk: diffHunk, path,
    commit_id: sha(`head-${number}`), original_commit_id: sha(`head-${number}`), user: user(author), body,
    created_at: updated, updated_at: updated, html_url: `https://github.com/${OWNER}/${REPO}/pull/${number}#discussion_r${id}`,
    pull_request_url: `${API}${B}/pulls/${number}`, author_association: assoc, start_line: null, original_start_line: null,
    start_side: null, line, original_line: line, side: 'RIGHT', position: line, original_position: line, subject_type: 'line',
    ...(replyTo ? { in_reply_to_id: replyTo } : {}),
  };
}

export function review({ id, number, state, body, author = 'dave', assoc = 'MEMBER', submitted = '2026-10-04T10:00:00Z' }) {
  return {
    id, node_id: `PRR_${id}`, user: user(author), body, state, html_url: `https://github.com/${OWNER}/${REPO}/pull/${number}#pullrequestreview-${id}`,
    pull_request_url: `${API}${B}/pulls/${number}`, author_association: assoc, submitted_at: submitted, commit_id: sha(`head-${number}`),
  };
}

export function file({ filename, status = 'added', patch = '@@ -0,0 +1 @@\n+x', previous = null }) {
  const blob = sha(`blob-${filename}`);
  return {
    sha: blob, filename, status, additions: 1, deletions: 0, changes: 1, patch,
    blob_url: `https://github.com/${OWNER}/${REPO}/blob/${blob}/${filename}`, raw_url: `https://github.com/${OWNER}/${REPO}/raw/${blob}/${filename}`,
    contents_url: `${API}${B}/contents/${filename}?ref=${blob}`, ...(previous ? { previous_filename: previous } : {}),
  };
}

// ------------------------------------------------------------------------------------------------- replay dir

export const ok = (body, headers = {}) => ({ status: 200, headers: { date: DATE, 'x-ratelimit-remaining': '4999', ...headers }, body });
export const PULLS_Q = { state: 'all', sort: 'updated', direction: 'desc', per_page: '100' };
export const STREAMS = [
  ['issues', `${B}/issues`, { state: 'all', sort: 'updated', direction: 'asc', per_page: '100' }],
  ['issueComments', `${B}/issues/comments`, { sort: 'updated', direction: 'asc', per_page: '100' }],
  ['reviewComments', `${B}/pulls/comments`, { sort: 'updated', direction: 'asc', per_page: '100' }],
];
export const repoJson = () => ({
  id: REPO_ID, node_id: 'R_r', name: REPO, full_name: `${OWNER}/${REPO}`, private: false, owner: user(OWNER, 'Organization'),
  html_url: `https://github.com/${OWNER}/${REPO}`, default_branch: 'main', visibility: 'public',
});
const isoSec = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const pullsUrl = (page) => `${API}${B}/pulls?${new URLSearchParams({ ...PULLS_Q, page: String(page) })}`;

/**
 * Routes for the EXACT request table at the top of src/gh-client.mjs.
 * gh: { prPages: pr[][], issues, issueComments, reviewComments, reviews: { n: review[] }, files: { n: file[] } }
 * Each stream also answers `since` = WINDOW (the next incremental run) and `since` = last item − 1 s (R4's re-read
 * after progress), so either reading order of R4 finds a route.
 */
export function replayRoutes(gh) {
  const routes = [{ path: B, query: {}, responses: [ok(repoJson())] }];
  const pages = gh.prPages;
  pages.forEach((page, i) => {
    const link = i + 1 < pages.length ? { link: `<${pullsUrl(i + 2)}>; rel="next", <${pullsUrl(pages.length)}>; rel="last"` } : {};
    routes.push({ path: `${B}/pulls`, query: i ? { ...PULLS_Q, page: String(i + 1) } : PULLS_Q, responses: [ok(page, link)] });
  });
  for (const [key, path, query] of STREAMS) {
    const items = [...gh[key]].sort((a, b) => a.updated_at.localeCompare(b.updated_at));
    routes.push({ path, query, responses: [ok(items)] });
    routes.push({ path, query: { ...query, since: WINDOW }, responses: [ok(items.filter((x) => x.updated_at >= WINDOW))] });
    if (items.length) {
      const since = isoSec(Date.parse(items.at(-1).updated_at) - 1000);
      routes.push({ path, query: { ...query, since }, responses: [ok(items.filter((x) => x.updated_at >= since))] });
    }
  }
  for (const n of pages.flat().map((p) => p.number)) {
    routes.push({ path: `${B}/pulls/${n}/reviews`, query: { per_page: '100' }, responses: [ok(gh.reviews[n] ?? [])] });
    routes.push({ path: `${B}/pulls/${n}/files`, query: { per_page: '100' }, responses: [ok(gh.files[n] ?? [])] });
  }
  return routes;
}

/**
 * Replace the responses of one route (error injection). path is relative to /repos/o/r ('' = the repo itself);
 * responses is a list, or a function of the old list.
 */
export function override(routes, path, query, responses) {
  const r = routes.find((x) => x.path === B + path && JSON.stringify(x.query) === JSON.stringify(query));
  if (!r) throw new Error(`no route ${path}`);
  r.responses = typeof responses === 'function' ? responses(r.responses) : responses;
  return routes;
}

export function writeReplay(routes) {
  const dir = mkdtempSync(join(tmpdir(), 'brain-s-replay-'));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ now: NOW, routes }, null, 1));
  return dir;
}

// --------------------------------------------------------------------------------------------- the secret corpus

/** GitHub side: every kind in PR titles / bodies, branch names, review comments, issue comments, reviews, PR file paths. */
export function githubSecretCorpus(reg) {
  const M = (loc) => secretLines(reg, loc), L = (loc, ks) => secretLine(reg, loc, ks), I = (loc, k) => identSecret(reg, loc, k);
  const plus = (text) => text.split('\n').map((l) => `+${l}`).join('\n');
  const prs = [
    pr({ number: 101, state: 'open', title: 'Rotate credentials: ' + L('pr-title@101', ['github-token', 'api-key']), body: M('pr-body@101'),
      head: `rotate/${I('branch@101', 'github-token')}`, updated: '2026-10-05T10:00:00Z' }),
    pr({ number: 102, state: 'merged', title: 'Move keys to the vault: ' + L('pr-title@102', ['aws-key', 'jwt']),
      body: `Moved the key to the vault. Old value: ${zwSplit(reg, 'pr-body@102', 'github-token')}`, head: `fix/${I('branch@102', 'aws-key')}`, updated: '2026-10-03T10:00:00Z' }),
    pr({ number: 103, state: 'closed', title: 'Webhook rotation: ' + L('pr-title@103', ['slack', 'url-credential']), body: 'Superseded by #101.',
      head: `chore/${I('branch@103', 'slack')}`, author: 'carol', assoc: 'CONTRIBUTOR', updated: '2026-10-01T10:00:00Z' }),
  ];
  const page2 = [pr({ number: 104, state: 'merged', title: 'Header auth: ' + L('pr-title@104', ['bearer', 'assignment']), body: `Earlier rotation, see docs/credits.md. Old db ${shortPassword(reg, 'pr-body@104')}`,
    head: `feat/${I('branch@104', 'api-key')}/${I('branch@104', 'jwt')}`, updated: '2026-09-20T10:00:00Z' })];
  const rcPath = `config/${I('review-comment-path@7001', 'github-token')}.yml`;
  return {
    prPages: [prs, page2],
    issues: [
      issue({ number: 201, state: 'open', title: 'Leaked keys in CI logs: ' + L('issue-title@201', ['github-token', 'slack', 'jwt', 'bearer']), body: M('issue-body@201'), updated: '2026-10-06T10:00:00Z' }),
      issue({ number: 202, state: 'closed', title: 'Rotate staging: ' + L('issue-title@202', ['aws-key', 'api-key', 'url-credential', 'assignment']), body: `Done in #101. Staging ${shortPassword(reg, 'issue-body@202')}`, updated: '2026-10-07T10:00:00Z' }),
      prAsIssue(prs[0]),
    ],
    issueComments: [
      issueComment({ id: 8001, number: 201, body: M('issue-comment@201'), updated: '2026-10-08T10:00:00Z' }),
      issueComment({ id: 8002, number: 101, body: M('issue-comment@pr101'), updated: '2026-10-09T10:00:00Z' }),
    ],
    reviewComments: [
      reviewComment({ id: 7001, number: 101, review: 9001, path: rcPath, body: M('review-comment@7001'),
        diffHunk: '@@ -1,2 +1,12 @@\n' + plus(M('diff-hunk@7001')), updated: '2026-10-04T11:00:00Z' }),
      reviewComment({ id: 7002, number: 101, review: 9001, path: rcPath, body: 'Rotation done, thanks.', replyTo: 7001, updated: '2026-10-04T12:00:00Z' }),
    ],
    reviews: {
      101: [review({ id: 9001, number: 101, state: 'CHANGES_REQUESTED', body: M('review-body@9001') })],
      102: [review({ id: 9002, number: 102, state: 'APPROVED', body: 'LGTM after the rotation.' })],
    },
    files: {
      101: [
        file({ filename: `config/${I('pr-file@101', 'github-token')}.json`, patch: '@@ -0,0 +1,12 @@\n' + plus(M('patch@101')) }),
        file({ filename: `keys/${I('pr-file@101', 'aws-key')}.pem` }),
        file({ filename: `hooks/${I('pr-file@101', 'slack')}.yml` }),
        file({ filename: `src/${I('pr-file@101', 'api-key')}.ts` }),
        file({ filename: `tokens/${I('pr-file@101', 'jwt')}.txt` }),
        file({ filename: 'config/credentials.json', status: 'renamed', previous: `config/${I('pr-file-previous@101', 'github-token')}.json` }),
      ],
      102: [file({ filename: 'src/lib/credits.ts', status: 'modified' })],
      103: [file({ filename: 'src/lib/charge.ts', status: 'modified' })],
      104: [file({ filename: 'docs/credits.md', status: 'modified' })],
    },
    ptrs: ['pr:101', 'pr:102', 'pr:103', 'pr:104', 'issue:201', 'issue:202', 'review:9001', 'review:9002', 'rc:7001', 'rc:7002', 'ic:8001', 'ic:8002'],
  };
}

/**
 * Repo side: a doc (a private key across the 40-line chunk boundary), a change note (a heading inside the key
 * block), a commit message, a file name and two symbol names. extraFiles go into the first commit, laterFiles
 * into a second commit whose message carries every kind.
 */
export function repoSecretCorpus(reg) {
  const fileName = identSecret(reg, 'repo-file-name', 'github-token');
  const docName = identSecret(reg, 'repo-doc-name', 'slack');
  const sym1 = identSecret(reg, 'repo-symbol', 'aws-key'), sym2 = identSecret(reg, 'repo-symbol', 'api-key');
  const key = secret(reg, 'repo-change-note', 'private-key').split('\n');
  const filler = Array.from({ length: 34 }, (_, i) => `- step ${i + 1} of the credential rotation runbook for the credits service`);
  const doc = ['# Credential rotation', '', ...filler, secretLines(reg, 'repo-doc', ['private-key']),     // key: lines 37–42
    secretLines(reg, 'repo-doc', ONE_LINE_KINDS), `old staging ${shortPassword(reg, 'repo-doc')}`, ''].join('\n');
  return {
    extraFiles: {
      [`src/lib/${fileName}.ts`]: "import { reserve } from './credits';\nexport const rotateKeys = () => reserve;\n",
      'src/lib/vault-keys.ts': `export function ${sym1}() { return 'rotation'; }\nexport const ${sym2} = 1;\n`,
      [`docs/${docName}.md`]: '# Slack rotation\n\nThe rotation of the workspace hook for the credits service is tracked here.\n',
      'changes/20261101-rotate-keys.md': ['# Rotate deploy keys', '', 'The credential rotation replaced this key:', key[0], key[1], '## rotated keys',
        ...key.slice(2), '', secretLines(reg, 'repo-change-note', ONE_LINE_KINDS), ''].join('\n'),
    },
    laterFiles: { 'docs/rotation.md': doc },
    message: `Rotate leaked deploy credentials (#101)\n\n${secretLines(reg, 'repo-commit-message')}\n`,
  };
}

// ------------------------------------------------------------------------------------------------ running brain

const NO_GH = mkdtempSync(join(tmpdir(), 'brain-s-ghconfig-'));
const DEAD = 'http://127.0.0.1:9';
// Safety nets, not steering: if a run ever missed the replay seam, it still cannot reach the network.
const NO_FETCH = '--import=data:text/javascript,globalThis.fetch=undefined';

/** bin/brain with no inherited GitHub credentials, token canaries in the environment, no network, a timeout. */
export function cli(fx, args, env = {}) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GH|GITHUB|BRAIN)_/.test(k)));
  const r = spawnSync(BRAIN, args, {
    cwd: fx.repo, encoding: 'utf8', timeout: 120_000,
    env: { ...base, NO_COLOR: '1', BRAIN_DB: fx.codeDb, GH_CONFIG_DIR: NO_GH, ...TOKEN_ENV,
      NODE_OPTIONS: `${base.NODE_OPTIONS ?? ''} ${NO_FETCH}`.trim(), NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: DEAD, HTTP_PROXY: DEAD, NO_PROXY: '', ...env },
  });
  return { args, stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status, signal: r.signal };
}

// Every failpoint of seams.mjs, with page / file numbers that every corpus run reaches: pulls has 2 pages, then the
// issues stream is page 3; files are fetched for all 4 PRs of a first sync.
export const FAILPOINTS = ['sync:after-repo', 'sync:page:1', 'sync:page:2', 'sync:page:3', 'sync:files:1', 'sync:files:4',
  'sync:final:before', 'sync:final:inside', 'sync:full:before-swap', 'sync:relink'];

/** `brain sync` always through the replay seam: there is no other way for these tests to reach GitHub. */
export const sync = (fx, replayDir, args = [], env = {}) => cli(fx, ['sync', ...args], { BRAIN_REPLAY_DIR: replayDir, ...env });

const git = (repo, ...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });

/** The Phase 0 fixture + extra files, an origin remote, an optional second commit, then `brain build`. */
export function setupRepo({ extraFiles = {}, laterFiles = null, message = '', origin = `https://github.com/${OWNER}/${REPO}.git` } = {}) {
  const fx = fixtureRepo({ extraFiles, build: false });
  git(fx.repo, 'remote', 'add', 'origin', origin);
  if (laterFiles) {
    for (const [rel, text] of Object.entries(laterFiles)) {
      mkdirSync(dirname(join(fx.repo, rel)), { recursive: true });
      writeFileSync(join(fx.repo, rel), text);
    }
    const msg = join(mkdtempSync(join(tmpdir(), 'brain-s-msg-')), 'message');
    writeFileSync(msg, message);
    git(fx.repo, 'add', '-A', '-f');
    git(fx.repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--cleanup=verbatim', '-F', msg);
  }
  const head = git(fx.repo, 'rev-parse', 'HEAD').trim();
  return { ...fx, head, build: cli(fx, ['build', '.', '--db', fx.codeDb]) };
}

/** Back to "never synced": remove github.db, its journal, temp files and any lock; code.db stays. */
export function resetGithub(fx) {
  for (const f of storeFiles(fx.codeDb)) if (f !== fx.codeDb) rmSync(f, { force: true });
}

/** The first lines of a run's output for an assertion message: canaries named by id, control characters escaped. */
export function brief(reg, r) {
  let t = (r.stdout || r.stderr || `exit ${r.status} ${r.signal ?? ''}`).slice(0, 240);
  for (const [id, n] of reg) t = t.split(n).join(`<${id}>`);
  return JSON.stringify(t.split('\n').slice(0, 3).join(' | '));
}

export function parseJson(r) {
  try { return JSON.parse(r.stdout); } catch { return null; }
}

// --------------------------------------------------------------------------------------------------- scanning

/** Every file of the two stores: code.db, github.db, *-journal, *.full-tmp, *.lock (and their temp files). */
export function storeFiles(codeDb) {
  const dir = dirname(codeDb), base = basename(codeDb).replace(/\.db$/, '.');
  return readdirSync(dir).filter((n) => n.startsWith(base)).map((n) => join(dir, n)).filter((p) => statSync(p).isFile());
}

const label = (codeDb, file) => '<store>' + basename(file).slice(basename(codeDb).length - 3);

/** Ids whose needle occurs in text or bytes. folded: FTS terms are case-folded, so look for the lower-case form too. */
export function leaksIn(reg, hay, { folded = false } = {}) {
  const out = [];
  for (const [id, n] of reg) if (hay.includes(n) || (folded && hay.includes(n.toLowerCase()))) out.push(id);
  return out;
}

/** Every value of every table (FTS shadow tables included), read from a copy so the store is never touched. */
export function dbText(path) {
  const dir = mkdtempSync(join(tmpdir(), 'brain-s-dump-'));
  const copy = join(dir, 'copy.db');
  let db;
  try {
    copyFileSync(path, copy);
    db = new DatabaseSync(copy, { readOnly: true });
    const parts = [];
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
      try {
        for (const row of db.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`).all()) {
          for (const v of Object.values(row)) parts.push(v instanceof Uint8Array ? Buffer.from(v).toString('utf8') : String(v));
        }
      } catch { /* a table this SQLite build cannot read: its bytes are still scanned raw */ }
    }
    return parts.join('\n');
  } catch { return null; } finally { try { db?.close(); } catch {} rmSync(dir, { recursive: true, force: true }); }
}

/** Canary ids found in the stores' raw bytes, and in their rows (rows catch a value split across overflow pages). */
export function storeLeaks(reg, codeDb) {
  const out = new Set();
  for (const f of storeFiles(codeDb)) {
    for (const id of leaksIn(reg, readFileSync(f), { folded: true })) out.add(`${label(codeDb, f)} bytes: ${id}`);
    if (/\.db$|\.full-tmp$/.test(f)) {
      const text = dbText(f);
      if (text) for (const id of leaksIn(reg, text, { folded: true })) out.add(`${label(codeDb, f)} rows: ${id}`);
    }
  }
  return [...out];
}

/** Canary ids in the stdout / stderr of runs (a canary passed as an argument is named <canary> in the message). */
export function outputLeaks(reg, runs) {
  const out = [];
  for (const r of runs) {
    const name = r.args.map((a) => (leaksIn(reg, a).length ? '<canary>' : a)).join(' ').slice(0, 70);
    for (const stream of ['stdout', 'stderr']) for (const id of leaksIn(reg, r[stream])) out.push(`${name} ${stream}: ${id}`);
  }
  return out;
}

/** items rows in github.db, -1 when it cannot be read. */
export function itemCount(ghDb) {
  try {
    const db = new DatabaseSync(ghDb, { readOnly: true });
    try { return db.prepare('SELECT count(*) AS n FROM items').get().n; } finally { db.close(); }
  } catch { return -1; }
}

// --------------------------------------------------------------------------------------- output-format checks

// C0 (but tab and LF), C1, bidi controls, zero-width characters, and the line separators L2 folds to a space.
const RANGES = [[0x00, 0x08], [0x0B, 0x1F], [0x80, 0x9F], [0x200B, 0x200F], [0x202A, 0x202E], [0x2028, 0x2029], [0x2060, 0x2060], [0x2066, 0x2069], [0xFEFF, 0xFEFF]];
export const FORBIDDEN_RE = new RegExp(`[${RANGES.map(([a, b]) => `${U(a)}-${U(b)}`).join('')}]`, 'g');
export const badChars = (text) => [...new Set((String(text).match(FORBIDDEN_RE) || []).map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`))];

// Line heads that only external text produces in search / get / why / find output (every attack line starts so).
const HEAD_RE = /^\s*(SYSTEM\b|ignore (all )?previous|INJ-|── (end )?quote\b|│)/i;
export const headViolations = (text) => String(text).split('\n').filter((l) => HEAD_RE.test(l));

/**
 * Matches of `re` (global) outside a "…" span: ext() quotes an external string and escapes \" and \\ inside it,
 * so a title, snippet or first line can only appear between unescaped quotes.
 */
export function unquoted(text, re) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const inside = [];
    for (let i = 0, q = false; i < line.length; i++) {
      inside[i] = q;
      if (line[i] === '\\') { inside[++i] = q; continue; }
      if (line[i] === '"') q = !q;
    }
    for (const m of line.matchAll(re)) if (!inside[m.index]) out.push(m[0]);
  }
  return out;
}

/** The footer is two lines, once, at the very end: a body that imitates it must not add a third. */
export function footerProblems(text) {
  const lines = String(text).split('\n').filter((l) => l.trim());
  const count = (re) => lines.filter((l) => re.test(l)).length;
  const p = [];
  const cov = count(/^\s*coverage:/), fr = count(/^\s*freshness:/);
  if (cov !== 1 || fr !== 1) p.push(`${cov} coverage and ${fr} freshness lines (want 1 and 1)`);
  if (!/^ {2}coverage: /.test(lines.at(-2) ?? '') || !/^ {2}freshness: /.test(lines.at(-1) ?? '')) p.push('the footer is not the last two lines');
  return p;
}

/** plan §3.10: head line, every body line "│ ", exactly one end line, then the two footer lines and nothing else. */
export function envelopeProblems(text, ptr) {
  const shown = ptr.replace(FORBIDDEN_RE, '');
  const lines = String(text).split('\n');
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  const p = [];
  if (!(lines[0] ?? '').startsWith(`── quote ${shown} · untrusted · `)) p.push('the first line is not "── quote <ptr> · untrusted · …"');
  if (lines.filter((l) => l.startsWith('── quote')).length !== 1) p.push('not exactly one head line');
  const ends = lines.flatMap((l, i) => (l.startsWith('── end quote') ? [i] : []));
  if (ends.length !== 1) return [...p, `${ends.length} end lines (want exactly 1)`];
  const end = ends[0];
  if (!lines[end].startsWith(`── end quote ${shown}`)) p.push('the end line names another pointer');
  const body = lines.slice(1, end);
  if (!body.length) p.push('no body lines');
  const bad = body.filter((l) => !/^│( |$)/.test(l)).length;
  if (bad) p.push(`${bad} body lines do not start with "│ "`);
  const rest = lines.slice(end + 1);
  if (rest.length !== 2 || !/^ {2}coverage: /.test(rest[0]) || !/^ {2}freshness: /.test(rest[1])) p.push('the end line is not followed by exactly the footer');
  return p;
}

// DTO rules (read.mjs): pointers, repo paths from code.db and the caller's own query live outside `untrusted`.
const OUTSIDE_OK = [/(^|\.)ptr$/, /(^|\.)matched\.\d+$/, /(^|\.)merge\.(commitPtr|prPtr)$/, /(^|\.)links\.\w+\.\d+\.resolved\.\d+$/, /(^|\.)code\.files\.\d+$/, /^query$/];
// GetItem.path is the repo path of a repo-memory item; a GitHub item keeps its paths under untrusted.
const repoPath = (key, parent) => key === 'path' && parent && typeof parent.origin === 'string' && parent.origin !== 'github';

/** Strings that match `marker` must sit under an `untrusted` key; strings under `untrusted` must be normalized. */
export function untrustedProblems(value, marker) {
  const p = [];
  const walk = (v, path, parent) => {
    if (typeof v === 'string') {
      const where = path.join('.');
      const inside = path.includes('untrusted');
      const allowed = OUTSIDE_OK.some((re) => re.test(where)) || repoPath(path.at(-1), parent);
      if (marker.test(v) && !inside && !allowed) p.push(`${where}: external text outside "untrusted"`);
      if (inside && badChars(v).length) p.push(`${where}: ${badChars(v).join(' ')}`);
    } else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, [...path, k], v);
  };
  walk(value, [], null);
  return p;
}
