// linker: raw references out of text (pure) and their resolution against the current code.db (relink).
// Lane D owns this file.
//
// Contract (design §6.6):
// - extraction is PURE and index-free: it only classifies strings by shape. Whether a path exists, whether a
//   basename is unique, whether a route string is really a file path is decided at relink time.
// - extraction never emits a target that isRedacted() (sanitize.mjs); such strings get no ref at all
// - relink runs inside the caller's withWriteLock (build end, sync end). It opens github.db itself (read-write)
//   and code.db read-only, and closes both in finally. No network. git grep only via execFile, no shell.
// - relink resolves refs whose status is 'pending' or whose resolved_build differs from code.db meta.build_id
// - resolved targets that point into code are repo paths taken from code.db (already sanitized), never raw grep text
//   beyond "path:line"
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, getMeta, inTransaction } from './db.mjs';
import { git } from './files.mjs';
import { githubDbPath, openGithubDb } from './gh-schema.mjs';
import { pathIndex, PATH_RE, IDENT_RE, MAX_NAME_OWNERS } from './index-knowledge.mjs';
import { isRedacted, sanitizeIdent } from './sanitize.mjs';

/**
 * @typedef {{ kind: 'file'|'dir'|'symbol'|'commit'|'item'|'route'|'name', target: string, origin: 'text'|'merge-sha'|'inline'|'pr-files' }} RawRef
 * @typedef {{ ptr: string, kind: string, title?: string|null, body?: string|null, path?: string|null, merge_sha?: string|null,
 *   state?: string|null, merged_at?: string|null }} RefSource
 *   a sanitized items row (or the subset of it extraction reads). The merge-sha commit ref is made only when
 *   state is 'merged' or merged_at is set: GitHub also gives open PRs a merge_commit_sha (a test merge).
 */

export const BUDGET = { bytes: 16e6, ms: 20000 };
const MAX_RESOLVED = 10;
const BATCH = 500;

const CODE_SPAN_RE = /`([^`\n]+)`/g;
const BASENAME_RE = /^[\w.-]+\.(?:tsx?|mjs|js|py|h|cpp)$/;                  // Phase 0 linkText: a bare file name in backticks
const WORD_RE = /^[A-Za-z_$][\w$]{2,}$/;                                    // a code span that is one identifier
const NAME_RE = /^(?=.*[A-Za-z])(?=.*[.:_-])[\w.:-]{4,200}$/;               // jobs.reserve, credits:settle, JOB_RUN_QUEUE
const SHA_RE = /(?<![\w-])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?![\w-])/g;   // digits and letters mixed: not 12345678, not deadbeef
const HEX_RE = /^[0-9a-f]{7,40}$/;
const isSha = (s) => /^(?=.*\d)(?=.*[a-f])[0-9a-f]{7,40}$/.test(s);
const ITEM_RE = /(?<![\w&/#])#([1-9]\d{0,7})\b/g;
const REPO_ITEM_RE = /(?<![\w./-])([\w.-]+)\/([\w.-]+)#([1-9]\d{0,7})\b/g;
const GH_URL_RE = /https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/(?:pull|issues)\/([1-9]\d{0,7})\b/g;
const URL_RE = /https?:\/\/([^\s/?#<>()[\]`'"]+)(\/[^\s?#<>()[\]`'"]*)?/g;
const ROUTE_TEXT_RE = /(?<![\w/.:~@$-])\/[\w.{}[\]:-]+(?:\/[\w.{}[\]:-]+)+/g;     // two or more segments: /api/run, /v2/charge/{id}
// GitHub's own links (PRs, attachments, avatars) are not routes of this repo's app
const GITHUB_HOST_RE = /(^|\.)(github\.com|githubusercontent\.com)$/i;

// "/api/run?x=1." -> "/api/run"; null for "/" and anything with a space
function routeOf(s) {
  const r = s.replace(/[?#].*$/, '').replace(/[.,:;!)]+$/, '').replace(/\/+$/, '');
  return /^\/(?!\/)\S+$/.test(r) ? r : null;
}

// the whitespace-delimited run around a match: a reference glued to a redaction ("src/[REDACTED:…]/x.ts") is only
// a fragment of the real value, so it is dropped rather than linked as something shorter
function gluedToRedaction(text, m) {
  let a = m.index, b = m.index + m[0].length;
  while (a > 0 && !/\s/.test(text[a - 1])) a--;
  while (b < text.length && !/\s/.test(text[b])) b++;
  return isRedacted(text.slice(a, b));
}

function* textRefs(text, selfRepo) {
  const self = String(selfRepo ?? '').toLowerCase();
  const item = (owner, repo, n) => ({ kind: 'item', target: `${owner}/${repo}`.toLowerCase() === self ? `#${n}` : `${owner}/${repo}#${n}` });
  const all = (re) => [...text.matchAll(re)].filter((m) => !gluedToRedaction(text, m));

  for (const m of all(PATH_RE)) {
    const end = m.index + m[0].length;
    if (text[end] === '#' && /\d/.test(text[end + 1] ?? '')) continue;          // owner/repo#12 is an item
    const raw = m[1].replace(/^\.\//, '');
    if (!/[A-Za-z]/.test(raw)) continue;                                        // 1/2, 2026/11/16
    yield raw.endsWith('/') ? { kind: 'dir', target: raw.replace(/\/+$/, '') } : { kind: 'file', target: raw };
  }
  for (const m of all(IDENT_RE)) if (m[1].length >= 6) yield { kind: 'symbol', target: m[1] };
  for (const m of all(SHA_RE)) yield { kind: 'commit', target: m[0] };
  for (const m of all(GH_URL_RE)) yield item(m[1], m[2], m[3]);
  for (const m of all(REPO_ITEM_RE)) yield item(m[1], m[2], m[3]);
  for (const m of all(ITEM_RE)) yield { kind: 'item', target: `#${m[1]}` };
  for (const m of all(URL_RE)) {
    const r = !GITHUB_HOST_RE.test(m[1]) && m[2] && routeOf(m[2]);
    if (r) yield { kind: 'route', target: r };
  }
  for (const m of all(ROUTE_TEXT_RE)) {
    const r = routeOf(m[0]);
    if (r && r.split('/').filter(Boolean).length >= 2) yield { kind: 'route', target: r };
  }
  for (const m of all(CODE_SPAN_RE)) {
    const s = m[1].trim().replace(/\(\)$/, '');
    if (s.startsWith('/')) { const r = routeOf(s); if (r) yield { kind: 'route', target: r }; continue; }
    if (BASENAME_RE.test(s)) { yield { kind: 'file', target: s }; continue; }
    if (WORD_RE.test(s) && !isSha(s)) yield { kind: 'symbol', target: s };
    if (NAME_RE.test(s)) yield { kind: 'name', target: s };
  }
}

/**
 * Raw refs for one item from its title, body, inline path and merge SHA. selfRepo 'owner/name' marks
 * owner/repo#12 of the same repo as an item ref and others as external.
 * @param {RefSource} item @param {{ selfRepo: string }} opts @returns {RawRef[]} deduplicated
 */
export function extractRefs(item, { selfRepo } = {}) {
  const out = new Map();
  const add = ({ kind, target }, origin) => {
    const key = `${kind}\0${target}\0${origin}`;
    if (target && !isRedacted(target) && !out.has(key)) out.set(key, { kind, target, origin });
  };
  if (item.path) add({ kind: 'file', target: item.path }, 'inline');
  // GitHub fills merge_commit_sha for open PRs too (a test merge): only a merged PR's SHA is a real commit
  if (item.merge_sha && HEX_RE.test(item.merge_sha) && (item.state === 'merged' || item.merged_at)) add({ kind: 'commit', target: item.merge_sha }, 'merge-sha');
  const own = /^(?:pr|issue):(\d+)$/.exec(item.ptr ?? '')?.[1];
  for (const r of textRefs(`${item.title ?? ''}\n${item.body ?? ''}`, selfRepo)) {
    if (!(r.kind === 'item' && r.target === `#${own}`)) add(r, 'text');
  }
  return [...out.values()];
}

/**
 * pr-files refs from client.files(n).files (filenames are sanitized by the caller first). A rename adds the old path too.
 * @param {{ filename: string, previous_filename?: string }[]} files @returns {RawRef[]}
 */
export function fileRefs(files) {
  const out = new Map();
  for (const f of files || []) {
    for (const p of [f.filename, f.previous_filename]) if (p && !out.has(p)) out.set(p, { kind: 'file', target: p, origin: 'pr-files' });
  }
  return [...out.values()];
}

// ---------- relink ----------

const linked = (resolved) => ({ status: 'linked', reason: null, resolved });
const unlinked = (reason) => ({ status: 'unlinked', reason, resolved: [] });
const ambiguous = (resolved) => ({ status: 'ambiguous', reason: 'too-many', resolved: resolved.slice(0, MAX_RESOLVED) });

// app/(shop)/api/[id]/route.ts -> ['api', '[id]']: the first app/ is the routing root; groups and @slots are not in the URL
function routeSegments(path) {
  const s = path.split('/');
  return s.slice(s.indexOf('app') + 1, -1).filter((x) => !/^\(.*\)$/.test(x) && !x.startsWith('@'));
}

function routeMatches(pattern, segs) {
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i];
    if (/^\[\[\.\.\..+\]\]$/.test(p)) return true;                               // [[...x]]: zero or more segments
    if (/^\[\.\.\..+\]$/.test(p)) return segs.length > i;                       // [...x]: one or more
    if (i >= segs.length || !(/^\[.+\]$/.test(p) || p === segs[i])) return false;
  }
  return pattern.length === segs.length;
}

/** Index-only resolvers. Each returns a verdict, or null when git (cat-file, grep) has to decide. */
function resolvers({ code, gh, tracked }) {
  const ix = pathIndex(tracked);
  const byBase = new Map();
  for (const p of tracked) { const b = p.split('/').pop(); if (!byBase.has(b)) byBase.set(b, []); byBase.get(b).push(p); }
  const symbols = code.prepare(`SELECT key FROM nodes WHERE name = ? AND kind != 'file' AND exported = 1 ORDER BY key LIMIT ${MAX_RESOLVED + 1}`);
  const items = gh.prepare(`SELECT ptr FROM items WHERE number = ? AND kind IN ('pr', 'issue')`);
  const routes = code.prepare(`SELECT path, flags FROM nodes WHERE kind = 'file' AND flags != ''`).all()
    .filter((r) => r.flags.split(' ').some((f) => f === 'route' || f === 'page'))
    .map((r) => ({ path: r.path, pattern: routeSegments(r.path) }));

  // as stored for PR files and inline comments; text gets Phase 0's extension tries and the unique basename
  const file = ({ target, origin }) => {
    if (origin !== 'text') return ix.known.has(target) ? linked([target]) : unlinked('not-in-index');
    const hit = ix.resolvePath(target) ?? ix.resolveBase(target);
    if (hit) return linked([hit.path]);
    const all = target.includes('/') ? [] : byBase.get(target) ?? [];
    return all.length > 1 ? ambiguous(all) : unlinked('not-in-index');
  };
  return {
    file, dir: file,
    symbol({ target }) {
      const keys = symbols.all(target).map((r) => r.key);
      return !keys.length ? unlinked('no-match') : keys.length > MAX_NAME_OWNERS ? ambiguous(keys) : linked(keys);
    },
    item({ target }) {
      const n = /^#(\d+)$/.exec(target)?.[1];
      if (!n) return unlinked(target.includes('/') ? 'external-repo' : 'not-synced');
      const hit = items.get(Number(n));
      return hit ? linked([hit.ptr]) : unlinked('not-synced');
    },
    route({ target }) {
      const asFile = ix.resolvePath(target.slice(1));                          // "/src/lib/credits.ts" is a path, not a URL
      if (asFile) return linked([asFile.path]);
      const segs = target.split('/').filter(Boolean);
      const hits = routes.filter((r) => routeMatches(r.pattern, segs)).map((r) => r.path);
      return hits.length ? linked(hits.slice(0, MAX_RESOLVED)) : null;
    },
    // a name that is already a tracked file (`package.json`) is that file, not a string to grep for
    name({ target }) { const hit = ix.resolvePath(target) ?? ix.resolveBase(target); return hit ? linked([hit.path]) : null; },
  };
}

// one `git cat-file --batch-check` for every SHA: sha -> 'commit' | 'ambiguous' | 'missing' | ..., null when git failed
function commitTypes(repoDir, shas) {
  return new Promise((resolve) => {
    const child = execFile('git', ['-C', repoDir, 'cat-file', '--batch-check'], { encoding: 'utf8', maxBuffer: Infinity }, (err, stdout) => {
      if (err) return resolve(null);
      const lines = stdout.split('\n');
      resolve(new Map(shas.map((s, i) => [s, lines[i]?.split(' ')[1]])));
    });
    child.stdin.on('error', () => {});                                          // git exited early: the callback reports it
    child.stdin.end(shas.map((s) => `${s}^{commit}\n`).join(''));
  });
}

/**
 * One fixed-string git grep of the indexed commit for every token (tokens go in a file, never on the command line).
 * Output is read as it streams; a token found in more than MAX_RESOLVED files is decided ('too-many') at once.
 * @returns {Promise<{ files: Map<string, Map<string, string>>, open: Set<string>, over: boolean, failed: number|string|null }>}
 *   open: tokens not decided as too-many; over: the budget stopped git; failed: git's exit code or signal on an error
 */
async function grepTokens(repoDir, commit, tokens, budget) {
  const dir = mkdtempSync(join(tmpdir(), 'brain-relink-'));
  try {
    const list = join(dir, 'tokens');
    writeFileSync(list, tokens.join('\n') + '\n', { mode: 0o600 });
    const files = new Map(tokens.map((t) => [t, new Map()]));
    const open = new Set(tokens);
    const prefix = `${commit}:`;
    let bytes = 0, rest = '', over = false, done = false;
    // -z: "<commit>:<path>\0<line>\0<text>" with the path verbatim (no C-quoting of non-ASCII names, ':' safe)
    const args = ['-C', repoDir, 'grep', '--no-color', '-n', '-z', '-I', '-F', '-f', list, commit, '--'];
    const take = (line) => {
      const a = line.indexOf('\0'), b = line.indexOf('\0', a + 1);
      if (a < 0 || b < 0) return;
      const head = line.slice(0, a), path = head.startsWith(prefix) ? head.slice(prefix.length) : head;
      const no = line.slice(a + 1, b), text = line.slice(b + 1);
      for (const t of open) {
        if (!text.includes(t)) continue;
        const f = files.get(t);
        if (!f.has(path)) f.set(path, no);
        if (f.size > MAX_RESOLVED) open.delete(t);
      }
    };
    const failed = await new Promise((resolve) => {
      const child = execFile('git', args, { encoding: 'utf8', maxBuffer: Infinity }, (err) => {
        clearTimeout(timer);
        if (!err || over || done) return resolve(null);
        resolve(err.code === 1 ? null : err.code ?? err.signal ?? 'error');      // exit 1: nothing matched
      });
      const timer = setTimeout(() => { over = true; child.kill(); }, budget.ms);
      child.stdout.on('data', (chunk) => {
        if (over || done) return;
        const lines = (rest + chunk).split('\n');
        rest = lines.pop();
        for (const l of lines) take(l);
        bytes += Buffer.byteLength(chunk);
        if (bytes > budget.bytes) { over = true; child.kill(); }
        else if (!open.size) { done = true; child.kill(); }                     // every token is too-many already
      });
    });
    if (!over && !done && !failed && rest) take(rest);
    return { files, open, over, failed };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// a token git grep -f can take: 3–200 chars on one line (an empty or multi-line pattern changes what -f means)
const greppable = (t) => t.length >= 3 && t.length <= 200 && !/[\n\r\0]/.test(t);

/**
 * @param {{ codeDbPath: string, repoDir: string, budget?: { bytes: number, ms: number }, log?: (s: string) => void }} opts
 * @typedef {{ linked: number, ambiguous: number, unlinked: number, pending: number, build: string }} RelinkResult
 * @returns {Promise<null | RelinkResult>} null: no github.db. A failure throws; build and sync record it as { error }
 *   null when there is no github.db next to the code DB
 */
export async function relink({ codeDbPath, repoDir, budget = BUDGET, log } = {}) {
  const gh = openGithubDb(githubDbPath(codeDbPath));
  if (!gh) return null;
  let code;
  try {
    code = openDb(codeDbPath);
    const { build_id: build, commit } = getMeta(code);
    // not-synced item refs too: a later sync can add the item without a new build
    const todo = gh.prepare(`SELECT rowid AS id, ptr, kind, target, origin FROM refs
      WHERE status = 'pending' OR resolved_build IS NOT ? OR (kind = 'item' AND reason = 'not-synced') ORDER BY rowid`).all(build);
    const verdicts = new Map();                                                 // refs rowid -> { status, reason, resolved }
    if (todo.length) {
      // the files of the indexed commit (what git grep searches), not the checkout as it is now
      const tracked = git(repoDir, ['ls-tree', '-r', '-z', '--name-only', commit]).split('\0').filter(Boolean);
      const r = resolvers({ code, gh, tracked: tracked.map((p) => sanitizeIdent(p)) });
      const later = { commit: [], name: [], grep: [] };
      for (const ref of todo) {
        if (isRedacted(ref.target)) verdicts.set(ref.id, unlinked('redacted'));
        else if (ref.kind === 'commit' || ref.kind === 'name') later[ref.kind].push(ref);
        else if (r[ref.kind]) {
          const v = r[ref.kind](ref);
          if (v) verdicts.set(ref.id, v); else later.grep.push(ref);
        }
      }

      if (later.commit.length) {
        const shas = [...new Set(later.commit.map((x) => x.target).filter((t) => HEX_RE.test(t)))];
        const types = shas.length ? await commitTypes(repoDir, shas) : new Map();
        if (!types) log?.('  relink: git cat-file failed; commit refs stay pending');
        for (const x of later.commit) {
          const t = types?.get(x.target);
          verdicts.set(x.id, !types ? { status: 'pending', reason: null, resolved: [] }
            : t === 'commit' ? linked([`commit:${x.target}`]) : t === 'ambiguous' ? ambiguous([]) : unlinked('not-local'));
        }
      }

      // a name the same item already links as a file, dir or symbol (`JOB_RUN_QUEUE`) is not resolved again
      const sibling = new Map();
      const keyOf = (x) => `${x.ptr}\0${x.target}`;
      for (const s of gh.prepare(`SELECT ptr, target, resolved FROM refs WHERE status = 'linked' AND resolved_build = ? AND kind IN ('file', 'dir', 'symbol')`).all(build)) {
        sibling.set(keyOf(s), JSON.parse(s.resolved ?? '[]'));
      }
      for (const x of todo) {
        const v = verdicts.get(x.id);
        if (v?.status === 'linked' && ['file', 'dir', 'symbol'].includes(x.kind)) sibling.set(keyOf(x), v.resolved);
      }
      for (const x of later.name) {
        const v = sibling.has(keyOf(x)) ? linked(sibling.get(keyOf(x))) : r.name(x);
        if (v) verdicts.set(x.id, v); else later.grep.push(x);
      }

      const tokens = [...new Set(later.grep.map((x) => x.target).filter(greppable))];
      const g = tokens.length ? await grepTokens(repoDir, commit, tokens, budget) : null;
      if (g?.over) log?.(`  relink: git grep hit its budget (${budget.bytes} bytes, ${budget.ms} ms); the rest stays pending`);
      if (g?.failed) log?.(`  relink: git grep failed (${g.failed}); its refs stay pending`);
      for (const x of later.grep) {
        if (!greppable(x.target)) { verdicts.set(x.id, unlinked('no-match')); continue; }
        const hits = [...g.files.get(x.target)].map(([p, n]) => `${sanitizeIdent(p)}:${n}`);
        if (!g.open.has(x.target)) verdicts.set(x.id, ambiguous(hits));
        else if (g.over) verdicts.set(x.id, { status: 'pending', reason: 'budget', resolved: [] });
        else if (g.failed) verdicts.set(x.id, { status: 'pending', reason: null, resolved: [] });
        else verdicts.set(x.id, hits.length ? linked(hits) : unlinked('no-match'));
      }
    }

    const upd = gh.prepare('UPDATE refs SET status = ?, reason = ?, resolved = ?, resolved_build = ? WHERE rowid = ?');
    const all = [...verdicts];
    for (let i = 0; i < all.length; i += BATCH) {
      inTransaction(gh, () => { for (const [id, v] of all.slice(i, i + BATCH)) upd.run(v.status, v.reason, JSON.stringify(v.resolved), build, id); });
    }
    const counts = { linked: 0, ambiguous: 0, unlinked: 0, pending: 0 };
    for (const { status, n } of gh.prepare('SELECT status, count(*) AS n FROM refs GROUP BY status').all()) counts[status] = n;
    log?.(`  relink: ${counts.linked} linked · ${counts.ambiguous} ambiguous · ${counts.unlinked} unlinked · ${counts.pending} pending`);
    return { ...counts, build };
  } finally {
    try { code?.close(); } catch { /* already closed */ }
    gh.close();
  }
}
