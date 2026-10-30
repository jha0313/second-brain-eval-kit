// why (FAST mode): question -> hybrid search -> one hop across doc <-> code <-> commit -> citations.
// No LLM call. The agent reads the cited lines and does the reasoning.
import { resolveTarget } from './query.mjs';
import { git } from './files.mjs';
import { MAX_NAME_OWNERS } from './index-knowledge.mjs';

const STOP = new Set(('a an the is are was were be been do does did why how what when where which who whom whose this that these those ' +
  'it its of in on at to for from by with without and or not no yes we our you your they their i me my should would could can ' +
  'will just only each every any all some there here than then so if else into about before after over under again ever also ' +
  'happen happened break broke broken change changed make made use used get got allow allowed ' +
  'go goes went gone going wrong time times').split(' '));     // question framing ("what went wrong last time"), not topic
const KO_SUFFIX = /(으로부터|에서부터|까지는|에서는|으로는|이라서|라서|에서|으로|에게|한테|까지|부터|처럼|보다|이랑|하고|이나|이는|는데|인데|이고|은|는|이|가|을|를|에|의|로|와|과|도|만|요|나요|까요|했나|했나요|인가|인가요|하나|하나요|되나|되나요|됐나|있나|없나)$/;
const RRF_K = 60;

export function terms(question) {
  const raw = question.match(/[@\w./#-]+|[가-힣]+/g) || [];
  const ascii = [], hangul = [], names = [], prs = [], shas = [];
  for (const t of raw) {
    if (/^#\d+$/.test(t)) { prs.push(t); continue; }
    if (/^[0-9a-f]{7,40}$/.test(t)) { shas.push(t); continue; }
    if (/[가-힣]/.test(t)) { const s = t.length > 2 ? t.replace(KO_SUFFIX, '') : t; if (s.length >= 2) hangul.push(s); continue; }
    const clean = t.replace(/^[^\w@]+|[^\w]+$/g, '');
    if (!clean) continue;
    if (/[/.]/.test(clean) || /[a-z][A-Z]|^[A-Z][a-z]+[A-Z]|[A-Z]{2,}[a-z]|_/.test(clean)) names.push(clean);   // paths, camelCase, IOBuf, snake_case
    for (const w of clean.split(/[^A-Za-z0-9_]+/)) if (w.length > 1 && !STOP.has(w.toLowerCase())) ascii.push(w.toLowerCase());
  }
  return { ascii: [...new Set(ascii)], hangul: [...new Set(hangul)], names: [...new Set(names)], prs, shas };
}

export function why(db, question, { limit = 8, perSource = 3 } = {}) {
  const t = terms(question);
  const lists = [];                                           // ranked lists of chunk ids, fused by RRF

  // 1. keyword (BM25), title weighted 3x
  if (t.ascii.length) {
    const q = t.ascii.map((w) => `"${w.replace(/"/g, '')}"`).join(' OR ');
    lists.push({ name: 'bm25', ids: db.prepare(`SELECT rowid AS id FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts, 3.0, 1.0) LIMIT 60`).all(q).map((r) => r.id) });
  }
  // 2. Korean terms: substring match (trigram index for 3+ chars, LIKE for 2), ranked by how many terms hit
  if (t.hangul.length) {
    const score = new Map();
    for (const h of t.hangul) {
      const rows = h.length >= 3
        ? db.prepare(`SELECT rowid AS id FROM chunks_tri WHERE chunks_tri MATCH ? LIMIT 400`).all(`"${h}"`)
        : db.prepare(`SELECT id FROM chunks WHERE title LIKE ? OR body LIKE ? LIMIT 400`).all(`%${h}%`, `%${h}%`);
      for (const r of rows) score.set(r.id, (score.get(r.id) || 0) + 1);
    }
    lists.push({ name: 'korean', ids: [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([id]) => id) });
  }
  // 3. names in the question (paths, identifiers) -> code nodes -> chunks linked to them
  const seeds = [];
  for (const n of t.names) {
    const r = resolveTarget(db, n);
    if (r.node) seeds.push(r.node);
    else if (r.candidates?.length && r.candidates.length <= MAX_NAME_OWNERS) seeds.push(...r.candidates);
  }
  if (seeds.length) {
    const ids = new Set(seeds.flatMap((s) => [s.id, ...(s.kind !== 'file' && s.path ? [fileNode(db, s.path)?.id] : [])]).filter(Boolean));
    const dirIds = [...ids].flatMap((id) => ancestorDirs(db, id));
    const all = [...ids, ...dirIds];
    const rows = db.prepare(`SELECT l.chunk AS id, count(*) AS n, max(c.date) AS d FROM links l JOIN chunks c ON c.id = l.chunk
      WHERE l.node IN (${all.map(() => '?').join(',')}) GROUP BY l.chunk ORDER BY n DESC, d DESC LIMIT 60`).all(...all);
    lists.push({ name: 'links', ids: rows.map((r) => r.id) });
  }
  // 4. PR numbers and SHAs are exact keys
  for (const pr of t.prs) lists.push({ name: pr, ids: db.prepare(`SELECT id FROM chunks WHERE (' ' || prs || ' ') LIKE ? ORDER BY source = 'commit' DESC LIMIT 20`).all(`% ${pr} %`).map((r) => r.id) });
  for (const sha of t.shas) lists.push({ name: sha, ids: db.prepare(`SELECT id FROM chunks WHERE sha LIKE ? LIMIT 5`).all(`${sha}%`).map((r) => r.id) });

  const fuse = (ls) => {
    const fused = new Map();
    for (const l of ls) l.ids.forEach((id, rank) => {
      const f = fused.get(id) || { id, score: 0, via: [] };
      f.score += 1 / (RRF_K + rank + 1); f.via.push(l.name); fused.set(id, f);
    });
    return fused;
  };
  // 5. one hop doc -> commit: the commits that wrote the best-matching docs (a Korean question finds the
  //    Korean change fragment, and the hop brings the English commit with the PR number)
  const first = [...fuse(lists).values()].sort((a, b) => b.score - a.score).slice(0, 6);
  const docOf = db.prepare(`SELECT c.source, n.id AS node FROM chunks c JOIN nodes n ON n.key = c.path WHERE c.id = ?`);
  // only docs written by one or two commits (a changes/ fragment, a decision note): a long-lived doc's
  // writers are many and say nothing about this question
  const writers = db.prepare(`SELECT l.chunk AS id FROM links l JOIN chunks c ON c.id = l.chunk
    WHERE l.node = ? AND l.kind = 'touches' AND (SELECT count(*) FROM links x WHERE x.node = l.node AND x.kind = 'touches') <= 2`);
  const hop = [];
  for (const f of first) {
    const d = docOf.get(f.id);
    if (d && d.source !== 'commit') for (const w of writers.all(d.node)) if (!hop.includes(w.id)) hop.push(w.id);
  }
  if (hop.length) lists.push({ name: 'doc→commit', ids: hop });
  // A question that names code (IOBuf, createOrder, lib/x.ts) wants sources about that code: drop keyword
  // hits that never mention any of the names and are not linked to them. Nothing left = a real knowledge gap.
  const bare = t.names.map((n) => n.split('/').pop().replace(/\.\w+$/, '').toLowerCase()).filter((n) => n.length >= 3);
  if (bare.length) {
    const mentions = db.prepare('SELECT lower(title || char(10) || body) AS t FROM chunks WHERE id = ?');
    const linked = new Set(lists.find((l) => l.name === 'links')?.ids || []);
    for (const l of lists) if (l.name === 'bm25' || l.name === 'korean') l.ids = l.ids.filter((id) => linked.has(id) || bare.some((n) => mentions.get(id).t.includes(n)));
  }
  const fused = fuse(lists);

  // keep sources mixed; a vault note that mirrors a commit we already cite adds nothing
  const getChunk = db.prepare('SELECT * FROM chunks WHERE id = ?');
  const picked = [], perSrc = {}, shas = new Set(), paths = new Set();
  for (const f of [...fused.values()].sort((a, b) => b.score - a.score)) {
    const ch = getChunk.get(f.id);
    const sha8 = ch.sha?.slice(0, 7);
    if (sha8 && shas.has(sha8)) continue;
    if (ch.path && paths.has(ch.path)) continue;                   // one section per file: the best one
    if (ch.path) paths.add(ch.path);
    if ((perSrc[ch.source] = (perSrc[ch.source] || 0) + 1) > perSource) continue;
    if (sha8) shas.add(sha8);
    picked.push({ ...ch, score: f.score, via: f.via });
    if (picked.length >= limit) break;
  }

  // 6. one hop: the code each citation points to
  const linksOf = db.prepare(`SELECT n.path, n.name, n.kind, l.kind AS link FROM links l JOIN nodes n ON n.id = l.node WHERE l.chunk = ?`);
  const related = new Map();
  for (const p of picked) {
    p.links = linksOf.all(p.id);
    for (const l of p.links) {
      const key = l.kind === 'dir' ? `${l.path}/` : l.path;
      if (!key) continue;
      const r = related.get(key) || { path: key, citations: 0, kinds: new Set() };
      r.citations++; r.kinds.add(l.link); related.set(key, r);
    }
  }
  const touchedBy = seeds.length ? db.prepare(`SELECT c.sha, c.date, c.title, c.prs FROM links l JOIN chunks c ON c.id = l.chunk
    WHERE l.kind = 'touches' AND l.node = ? ORDER BY c.date DESC LIMIT 3`) : null;
  const history = seeds.slice(0, 3).map((s) => ({ seed: s.key, commits: touchedBy.all(s.kind === 'file' ? s.id : fileNode(db, s.path)?.id ?? -1) }));

  return { question, terms: t, seeds: seeds.map((s) => s.key), lists: lists.map((l) => `${l.name}:${l.ids.length}`), gap: !picked.length,
    citations: picked.map((ch) => ({ ...cite(ch), mentions: mentions(ch) })), related: [...related.values()].sort((a, b) => b.citations - a.citations).slice(0, 10)
      .map((r) => ({ ...r, kinds: [...r.kinds] })), history };
}

function cite(ch) {
  const loc = ch.source === 'commit' ? ch.sha.slice(0, 8) : `${ch.path}:${ch.start_line}-${ch.end_line}`;
  return { source: ch.source, cite: loc, sha: ch.sha, path: ch.path, lines: ch.path ? [ch.start_line, ch.end_line] : null,
    date: ch.date, prs: ch.prs || '', title: ch.title, snippet: snippet(ch.body), via: ch.via, score: +ch.score.toFixed(4),
    links: (ch.links || []).slice(0, 6).map((l) => l.kind === 'dir' ? `${l.path}/` : l.kind === 'file' ? l.path : `${l.path}#${l.name}`) };
}

// What a citation's text names that an agent might cite in turn: SHA-shaped strings (a build or deploy ID is
// not a commit) and file names (a file the text names may be gone). Display only: ranking never looks at it.
const SHA_RE = /(?<![\w-])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?!\w)/g;
const FILE_RE = /(?<![\w@./-])(?:\.\/|\/)?((?:[\w@.-]+\/)*[\w@-][\w@.-]*\.(?:tsx?|jsx?|mjs|cjs|mdx?|json|ya?ml|sql|py|sh|css|scss|html|toml))(?![\w/-])/g;
function mentions(ch) {
  const text = `${ch.title ?? ''}\n${ch.body ?? ''}`.replace(/\bhttps?:\/\/\S+/g, '');
  return { shas: [...new Set(text.match(SHA_RE) || [])],
    files: [...new Set([...text.matchAll(FILE_RE)].map((m) => m[1]))] };
}

// marks each citation with the SHAs that are not commits and the files that are not in the checkout's tree
// (a bare name counts if some tracked path ends with it). Fails open: no git, no marks
export function markMentions(repo, r) {
  const all = r.citations.map((c) => c.mentions ?? { shas: [], files: [] });
  const shas = [...new Set(all.flatMap((m) => m.shas))], files = all.flatMap((m) => m.files);
  let isCommit = () => true, inTree = () => true;
  try {
    if (shas.length) {
      const types = git(repo, ['cat-file', '--batch-check'], { input: shas.join('\n') + '\n' }).trim().split('\n');
      const commits = new Set(shas.filter((_, i) => types[i]?.split(' ')[1] === 'commit'));
      isCommit = (x) => commits.has(x);
    }
    if (files.length) {
      const suffixes = new Set(git(repo, ['ls-files', '-z']).split('\0').filter(Boolean)
        .flatMap((p) => p.split('/').map((_, i, parts) => parts.slice(i).join('/'))));
      inTree = (x) => suffixes.has(x);
    }
  } catch { /* not a git checkout: no marks */ }
  r.citations.forEach((c, i) => {
    delete c.mentions;
    c.notCommits = all[i].shas.filter((x) => !isCommit(x));
    c.notInTree = all[i].files.filter((x) => !inTree(x));
  });
  return r;
}

const snippet = (body) => body.replace(/^---[\s\S]*?---\s*/, '').replace(/^files: .*$/m, '').replace(/^#{1,6}\s.*$/gm, '')
  .replace(/^\s*[-*]\s+/gm, '').replace(/\s+/g, ' ').trim().slice(0, 220);
const fileNode = (db, path) => db.prepare(`SELECT id FROM nodes WHERE key = ?`).get(path);
function ancestorDirs(db, id) {
  const n = db.prepare('SELECT path FROM nodes WHERE id = ?').get(id);
  if (!n?.path) return [];
  const parts = n.path.split('/').slice(0, -1);
  const keys = parts.map((_, i) => `dir:${parts.slice(0, i + 1).join('/')}`).slice(1);   // skip top-level dirs: too broad
  if (!keys.length) return [];
  return db.prepare(`SELECT id FROM nodes WHERE key IN (${keys.map(() => '?').join(',')})`).all(...keys).map((r) => r.id);
}
