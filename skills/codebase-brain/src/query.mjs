// Map queries. Every answer says how complete it is: truncated by a limit, or partial because
// the index could not resolve some local imports, or stale because HEAD moved since the build.
import { getMeta } from './db.mjs';
import { git } from './files.mjs';

const MODULE_EDGES = ['imports', 'imports-type', 'reexports', 'dynamic-import', 'mocks', 'includes'];
const USAGE_EDGES = ['call', 'new', 'renders', 'extends', 'implements', 'type', 'ref'];

// ---------- targets: IDs, not strings ----------

export function resolveTarget(db, q) {
  const one = (sql, ...a) => db.prepare(sql).all(...a);
  const byKey = one('SELECT * FROM nodes WHERE key = ?', q.replace(':', '#'));
  if (byKey.length) return { node: byKey[0] };
  const m = /^(.+?)[#:]([\w$.]+)$/.exec(q);                       // path#Name or path:Name
  if (m && !/\.\w+$/.test(q)) {
    const hits = one(`SELECT * FROM nodes WHERE kind != 'file' AND name = ? AND (path = ? OR path LIKE ?)`, m[2].split('.').pop(), m[1], `%${m[1]}`);
    if (hits.length === 1) return { node: hits[0] };
    if (hits.length > 1) return { candidates: hits };
  }
  const dir = q.replace(/\/+$/, '');
  if (one(`SELECT 1 FROM nodes WHERE kind = 'file' AND path LIKE ? LIMIT 1`, `${dir}/%`).length) {   // a directory: every file under it
    const known = one('SELECT * FROM nodes WHERE key = ?', `dir:${dir}`)[0];
    return { node: known || { id: -1, key: `dir:${dir}`, kind: 'dir', name: dir.split('/').pop(), path: dir } };
  }
  if (q.includes('/') || /\.\w+$/.test(q)) {                       // a path, or the tail of one
    const hits = one(`SELECT * FROM nodes WHERE kind IN ('file','dir') AND (path = ? OR path LIKE ?) ORDER BY length(path)`, q, `%/${q.replace(/^\/+/, '')}`);
    if (hits.length === 1 || (hits.length && hits[0].path === q)) return { node: hits[0] };
    if (hits.length) return { candidates: hits };
  }
  const hits = one(`SELECT * FROM nodes WHERE name = ? AND kind NOT IN ('file','dir') ORDER BY exported DESC, kind`, q);
  const exported = hits.filter((h) => h.exported);
  if (hits.length === 1) return { node: hits[0] };
  if (exported.length === 1) return { node: exported[0], others: hits.length - 1 };
  if (hits.length) return { candidates: hits };
  return { candidates: [] };
}

export function find(db, q, { limit = 20, kind } = {}) {
  const like = `%${q}%`;
  const rows = db.prepare(`
    SELECT n.*, (SELECT count(*) FROM edges e WHERE e.dst = n.id AND e.kind NOT IN ('import','export')) AS uses
    FROM nodes n
    WHERE (n.name = ? OR n.name LIKE ? OR n.path LIKE ?) ${kind ? 'AND n.kind = ?' : ''}
    ORDER BY (n.name = ?) DESC, n.exported DESC, uses DESC LIMIT ?`).all(...[q, like, like, ...(kind ? [kind] : []), q, limit + 1]);
  return { rows: rows.slice(0, limit), truncated: rows.length > limit };
}

// ---------- refs / callers ----------

export function refs(db, node, { kinds, filter, exclude, limit = 50, cursor = 0, includeImports = false } = {}) {
  // a file's "references" are the files that import it; a symbol's are its use sites
  const ks = kinds?.length ? kinds : node.kind === 'file' ? MODULE_EDGES : [...USAGE_EDGES, ...(includeImports ? ['import', 'export'] : [])];
  const rows = db.prepare(`
    SELECT e.kind, e.path, e.line, e.col, s.name AS in_name, s.kind AS in_kind, f.flags
    FROM edges e JOIN nodes s ON s.id = e.src LEFT JOIN nodes f ON f.key = e.path
    WHERE e.dst = ? AND e.kind IN (${ks.map(() => '?').join(',')})
    ORDER BY e.path, e.line, e.col`).all(node.id, ...ks)
    .filter((r) => flagMatch(r.flags, filter, exclude));
  const files = new Set(rows.map((r) => r.path));
  return { total: rows.length, files: files.size, rows: rows.slice(cursor, cursor + limit),
    next: cursor + limit < rows.length ? cursor + limit : null };
}

export function flagMatch(flags = '', filter, exclude) {
  const f = (flags || '').split(' ');
  if (filter?.length && !filter.some((x) => f.includes(x))) return false;
  if (exclude?.length && exclude.some((x) => f.includes(x))) return false;
  return true;
}

// ---------- impact: reverse BFS ----------
// File target: follow import/include edges backwards until no new files appear (Glean's C++ fanout rule).
// Symbol target: hop 1 = files that use the symbol; then follow the enclosing symbols' users,
// and importers of the file when the use sits in top-level code.

export function impact(db, node, { hops = 99, noTypes = false, noMocks = false } = {}) {
  const fileOf = db.prepare('SELECT id, path, flags FROM nodes WHERE key = ?');
  const importers = db.prepare(`SELECT DISTINCT e.src AS id, n.path, n.flags, e.kind FROM edges e JOIN nodes n ON n.id = e.src
    WHERE e.dst = ? AND e.kind IN (${MODULE_EDGES.map(() => '?').join(',')})`);
  const users = db.prepare(`SELECT DISTINCT e.src AS id, s.kind AS src_kind, e.path, e.kind FROM edges e JOIN nodes s ON s.id = e.src
    WHERE e.dst = ? AND e.kind IN (${[...USAGE_EDGES, 'import'].map(() => '?').join(',')})`);
  const moduleKinds = MODULE_EDGES.filter((k) => !(noTypes && k === 'imports-type') && !(noMocks && k === 'mocks'));
  const flagsOf = new Map();
  const fileHop = new Map();                                  // path -> hop first reached
  const reach = (path, hop) => {
    if (!path || fileHop.has(path)) return false;
    fileHop.set(path, hop);
    if (!flagsOf.has(path)) flagsOf.set(path, fileOf.get(path)?.flags ?? '');
    return true;
  };

  const isFile = node.kind === 'file' || node.kind === 'dir';
  const start = node.kind === 'dir'
    ? db.prepare(`SELECT id, path, flags FROM nodes WHERE kind = 'file' AND path LIKE ?`).all(`${node.path}/%`)
    : isFile ? [{ id: node.id, path: node.path }] : [];
  for (const s of start) reach(s.path, 0);
  if (!isFile) reach(node.path, 0);

  let frontier = isFile ? start.map((s) => ({ id: s.id, file: true })) : [{ id: node.id, file: false }];
  const seen = new Set(frontier.map((f) => `${f.file}:${f.id}`));
  for (let hop = 1; hop <= hops && frontier.length; hop++) {
    const next = [];
    const push = (id, file) => { const k = `${file}:${id}`; if (!seen.has(k)) { seen.add(k); next.push({ id, file }); } };
    for (const f of frontier) {
      if (f.file) {
        for (const r of importers.all(f.id, ...MODULE_EDGES)) {
          if (!moduleKinds.includes(r.kind)) continue;
          reach(r.path, hop); push(r.id, true);
        }
      } else {
        for (const r of users.all(f.id, ...USAGE_EDGES, 'import')) {
          if (noTypes && r.kind === 'type') continue;
          reach(r.path, hop);
          if (r.kind === 'import') continue;                     // an import alone: the file may be affected, nothing it defines is
          if (r.src_kind === 'file') push(r.id, true); else push(r.id, false);
        }
      }
    }
    frontier = next;
  }

  const byHop = new Map();
  for (const [path, hop] of fileHop) {
    if (hop === 0) continue;
    if (!byHop.has(hop)) byHop.set(hop, []);
    byHop.get(hop).push(path);
  }
  const hopRows = [...byHop.entries()].sort((a, b) => a[0] - b[0]).map(([hop, paths]) => ({
    hop, files: paths.length, tests: paths.filter((p) => flagsOf.get(p).includes('test')).length, paths: paths.sort() }));
  return { hops: hopRows, total: fileHop.size - start.length - (isFile ? 0 : 1), flagsOf, fileHop };
}

// ---------- deps (forward) and shared ----------

export function deps(db, node, { hops = 99, noTypes = false } = {}) {
  const out = db.prepare(`SELECT DISTINCT e.dst AS id, n.path, e.kind FROM edges e JOIN nodes n ON n.id = e.dst
    WHERE e.src = ? AND e.kind IN (${MODULE_EDGES.filter((k) => k !== 'mocks').map(() => '?').join(',')})`);
  const kinds = MODULE_EDGES.filter((k) => k !== 'mocks' && !(noTypes && k === 'imports-type'));
  const starts = node.kind === 'dir'
    ? db.prepare(`SELECT id, path FROM nodes WHERE kind = 'file' AND path LIKE ?`).all(`${node.path}/%`) : [{ id: node.id, path: node.path }];
  const hopOf = new Map(starts.map((s) => [s.path, 0]));
  let frontier = starts;
  for (let hop = 1; hop <= hops && frontier.length; hop++) {
    const next = [];
    for (const f of frontier) for (const r of out.all(f.id, ...MODULE_EDGES.filter((k) => k !== 'mocks'))) {
      if (!kinds.includes(r.kind) || hopOf.has(r.path)) continue;
      hopOf.set(r.path, hop); next.push(r);
    }
    frontier = next;
  }
  return { starts: starts.map((s) => s.path), hopOf };
}

export function shared(db, a, b, opts) {
  const da = deps(db, a, opts), dbb = deps(db, b, opts);
  const inA = (p) => da.hopOf.has(p) && !da.starts.includes(p);
  const inB = (p) => dbb.hopOf.has(p) && !dbb.starts.includes(p);
  const both = [...da.hopOf.keys()].filter((p) => inA(p) && inB(p)).sort();
  return { both, a: da.hopOf.size - da.starts.length, b: dbb.hopOf.size - dbb.starts.length, hopA: da.hopOf, hopB: dbb.hopOf };
}

// ---------- freshness and coverage ----------

// `checkout` is the repo the agent works in (--repo, or the git repo around cwd). It wins when it has the
// indexed commit, so an index built in one clone and copied into another checks the copy, not the original.
export function freshness(db, checkout) {
  const meta = getMeta(db);
  const hasCommit = (r) => { try { git(r, ['cat-file', '-e', `${meta.commit}^{commit}`], { stdio: ['ignore', 'pipe', 'ignore'] }); return true; } catch { return false; } };
  const repo = [checkout, meta.repo].find((r) => r && meta.commit && hasCommit(r)) ?? meta.repo;
  const out = { commit: meta.commit, builtAt: meta.built_at, repo, head: null, changed: [] };
  try {
    out.head = git(repo, ['rev-parse', 'HEAD']).trim();
    const committed = out.head !== meta.commit ? git(repo, ['diff', '--name-only', `${meta.commit}..HEAD`]).split('\n') : [];
    const working = git(repo, ['status', '--porcelain', '--untracked-files=no']).split('\n').map((l) => l.slice(3));
    out.changed = [...new Set([...committed, ...working].filter(Boolean))];
  } catch { out.head = null; }
  return { ...out, meta };
}

export function coverageFor(db, { truncated, paths = [] }) {
  const meta = getMeta(db);
  const unresolved = meta.coverage?.unresolvedLocal ?? 0;
  const inResult = paths.length ? db.prepare(`SELECT count(*) AS n FROM unresolved WHERE local = 1 AND path IN (${paths.map(() => '?').join(',')})`).get(...paths).n : 0;
  const state = truncated ? 'truncated' : unresolved ? 'partial' : 'complete';
  return { state, unresolvedLocal: unresolved, unresolvedInResult: inResult, commit: meta.commit };
}
