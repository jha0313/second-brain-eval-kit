// Knowledge adapter: the team's memory outside the code. Docs, changes/ fragments, CHANGELOG
// entries, commit messages (with PR numbers and touched files) and an optional Obsidian vault.
// Code nodes come from the code adapters; this file only links text to them (one fact base).
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { git } from './files.mjs';

const MD_EXT = /\.(md|mdx)$/i;
const PR_RE = /(?<![\w/#])#(\d{2,6})\b/g;
const PATH_RE = /(?<![\w/.-])(?:@\/)?((?:[\w.-]+\/)+(?:[\w.-]*\w)?)(?!\w)/g;   // a/b/c.ts, services/billing/, @/lib/x
const PATH_TRIES = ['', '.ts', '.tsx', '/index.ts', '/index.tsx', '.mjs', '.js'];
const IDENT_RE = /\b([A-Za-z_][A-Za-z0-9_]*[a-z0-9][A-Z][A-Za-z0-9_]*|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+|[A-Z][A-Z0-9]*_[A-Z0-9_]+)\b/g;
const MAX_LINES = 40;
const BULK_FILES = 300;

export function indexKnowledge({ repo, tracked, db, vault, commitDate, maxCommits = 5000, log }) {
  const insChunk = db.prepare(`INSERT INTO chunks(source, path, start_line, end_line, title, body, sha, date, prs)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insLink = db.prepare('INSERT INTO links(chunk, node, kind, evidence) VALUES (?, ?, ?, ?)');
  const nodeByKey = db.prepare('SELECT id FROM nodes WHERE key = ?');
  const symbolsByName = db.prepare(`SELECT id FROM nodes WHERE name = ? AND kind != 'file' AND exported = 1 LIMIT 4`);
  const insDir = db.prepare(`INSERT OR IGNORE INTO nodes(key, kind, name, path, lang) VALUES (?, 'dir', ?, ?, 'dir')`);
  const known = new Set(tracked);
  const dirs = new Set(tracked.flatMap((p) => p.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/'))));
  const byBase = new Map();
  for (const p of tracked) { const b = p.split('/').pop(); byBase.set(b, byBase.has(b) ? null : p); }   // null = ambiguous
  const stats = { docs: 0, changes: 0, changelog: 0, commits: 0, bulkCommits: 0, vault: 0, vaultSkippedNewer: 0, chunks: 0,
    links: { 'mentions-path': 0, 'mentions-symbol': 0, 'area-doc': 0, touches: 0 } };

  const dirNode = (d) => { insDir.run(`dir:${d}`, d.split('/').pop(), d); return nodeByKey.get(`dir:${d}`).id; };
  // docs are file nodes too, so a commit that touched a doc links to it (doc <-> commit hop)
  const insDoc = db.prepare(`INSERT OR IGNORE INTO nodes(key, kind, name, path, line, lang, flags) VALUES (?, 'file', ?, ?, 1, 'md', 'doc')`);
  for (const p of tracked) if (MD_EXT.test(p)) insDoc.run(p, p.split('/').pop(), p);
  const link = (chunk, node, kind, evidence) => { insLink.run(chunk, node, kind, evidence); stats.links[kind]++; };

  // text -> code: file paths, directory paths, unique basenames, exported symbol names
  const linkText = (chunk, text, selfPath) => {
    const seen = new Set();
    for (const [, raw] of text.matchAll(PATH_RE)) {
      const p = raw.replace(/^\.\//, '').replace(/\/$/, '');
      if (seen.has(p) || p === selfPath) continue;
      seen.add(p);
      const file = PATH_TRIES.map((x) => p + x).find((c) => known.has(c));
      if (file) { const n = nodeByKey.get(file); if (n) link(chunk, n.id, 'mentions-path', raw); }
      else if (dirs.has(p) && p.includes('/')) link(chunk, dirNode(p), 'mentions-path', p + '/');
    }
    for (const [, base] of text.matchAll(/`([\w.-]+\.(?:tsx?|mjs|js|py|h|cpp))`/g)) {
      const p = byBase.get(base);
      if (p && !seen.has(p)) { seen.add(p); const n = nodeByKey.get(p); if (n) link(chunk, n.id, 'mentions-path', base); }
    }
    for (const [, name] of text.matchAll(IDENT_RE)) {
      if (seen.has(name) || name.length < 6) continue;
      seen.add(name);
      const hits = symbolsByName.all(name);
      if (hits.length && hits.length <= 3) for (const h of hits) link(chunk, h.id, 'mentions-symbol', name);
    }
  };

  const addChunk = (c) => {
    const r = insChunk.run(c.source, c.path ?? null, c.start ?? null, c.end ?? null, c.title, c.body, c.sha ?? null, c.date ?? null,
      prsOf(`${c.title}\n${c.body}`));
    stats.chunks++;
    return Number(r.lastInsertRowid);
  };

  // 1. Markdown in the repo: one chunk per heading section (long sections split), CHANGELOG per entry
  for (const rel of tracked.filter((p) => MD_EXT.test(p))) {
    const text = readFileSync(join(repo, rel), 'utf8');
    const source = rel === 'CHANGELOG.md' ? 'changelog' : rel.startsWith('changes/') ? 'change' : 'doc';
    const pieces = source === 'changelog' ? changelogEntries(text) : sections(text, rel);
    for (const s of pieces) {
      const id = addChunk({ source, path: rel, ...s });
      linkText(id, `${s.title}\n${s.body}`, rel);
      // an area doc (services/billing/CLAUDE.md) describes the directory it lives in
      if (s.start === 1 && /(^|\/)(CLAUDE|AGENTS|README)\.md$/.test(rel) && rel.includes('/')) {
        link(id, dirNode(rel.split('/').slice(0, -1).join('/')), 'area-doc', rel);
      }
    }
    stats[source === 'doc' ? 'docs' : source === 'change' ? 'changes' : 'changelog']++;
  }
  log?.(`  markdown: ${stats.docs} docs, ${stats.changes} change fragments, CHANGELOG ${stats.changelog ? 'yes' : 'no'}`);

  // 2. Commit history reachable from the indexed commit: message + PR numbers + touched files
  const SEP = '\x1e';
  const out = git(repo, ['log', `-n${maxCommits}`, '--no-merges', '--name-only', `--format=${SEP}%H%x1f%cI%x1f%s%x1f%b%x1f`, 'HEAD']);
  for (const rec of out.split(SEP).slice(1)) {
    const [sha, date, subject, body, files = ''] = rec.split('\x1f');
    const cleanBody = body.split('\n').filter((l) => !/^(Co-authored-by|Signed-off-by|Claude-Session|Reviewed-by):/i.test(l.trim()) && !/^https?:\/\/claude\.ai\//.test(l.trim())).join('\n').trim();
    const touched = files.split('\n').map((f) => f.trim()).filter(Boolean);
    // a bulk commit (initial import, mass rename, the root of a shallow clone) says nothing about one file
    const bulk = touched.length > BULK_FILES;
    const id = addChunk({ source: 'commit', title: subject, body: bulk ? cleanBody : `${cleanBody}\n\nfiles: ${touched.join(' ')}`, sha, date: date.slice(0, 10) });
    if (bulk) stats.bulkCommits++;
    else for (const f of touched) { const n = nodeByKey.get(f); if (n) link(id, n.id, 'touches', sha.slice(0, 8)); }
    linkText(id, `${subject}\n${cleanBody}`);
    stats.commits++;
  }
  log?.(`  git log: ${stats.commits} commit${stats.commits === 1 ? '' : 's'}${stats.bulkCommits ? ` (${stats.bulkCommits} bulk, touching 300+ files: not linked to files)` : ''}`);

  // 3. Optional vault (read-only). Notes born after the indexed commit are skipped: the memory must not know the future.
  if (vault && existsSync(vault)) {
    for (const abs of walk(vault)) {
      if (!MD_EXT.test(abs)) continue;
      const rel = relative(vault, abs).split(sep).join('/');
      const text = readFileSync(abs, 'utf8');
      const born = text.match(/^born:\s*(\d{4}-\d{2}-\d{2})/m)?.[1];
      if (born && commitDate && born > commitDate) { stats.vaultSkippedNewer++; continue; }
      const sha = rel.match(/^Changes\/([0-9a-f]{7,40})\b/)?.[1];       // commit notes are named "<sha> <subject>.md"
      for (const s of sections(text, rel)) {
        const id = addChunk({ source: 'vault', path: `vault:${rel}`, ...s, sha, date: born });
        linkText(id, `${s.title}\n${s.body}`);
      }
      stats.vault++;
    }
    log?.(`  vault: ${stats.vault} notes (${stats.vaultSkippedNewer} newer than the commit skipped)`);
  }

  db.exec(`INSERT INTO chunks_fts(rowid, title, body) SELECT id, title, body FROM chunks`);
  db.exec(`INSERT INTO chunks_tri(rowid, title, body) SELECT id, title, body FROM chunks`);
  return stats;
}

const prsOf = (text) => [...new Set([...text.matchAll(PR_RE)].map((m) => `#${m[1]}`))].join(' ');

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p); else yield p;
  }
}

// Heading sections with their line ranges, so a citation can say path:12-31.
export function sections(text, rel) {
  const lines = text.split('\n');
  const out = [];
  // title: frontmatter title (changes/ fragments), else the first H1, else the file name
  const fm = /^---\n([\s\S]*?)\n---/.exec(text);
  const fmField = (k) => new RegExp(`^${k}:\\s*"?(.+?)"?\\s*$`, 'm').exec(fm?.[1] ?? '')?.[1];
  const fmTitle = fmField('title_en') || fmField('title') || fmField('title_ko');
  const h1 = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
  const docTitle = fmTitle || h1 || rel.split('/').pop().replace(MD_EXT, '');
  const fmLines = fm ? fm[0].split('\n').length : 0;
  let cur = { title: docTitle, start: 1, lines: [], body: false };
  const flush = () => {
    for (let i = 0; i < cur.lines.length; i += MAX_LINES) {
      const part = cur.lines.slice(i, i + MAX_LINES);
      out.push({ title: cur.title, body: part.join('\n').trim(), start: cur.start + i, end: cur.start + i + part.length - 1 });
    }
  };
  let inFence = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const h = !inFence && i >= fmLines && /^(#{1,4})\s+(.+)/.exec(line);
    if (h) {
      const t = h[2].trim();
      const title = t === docTitle ? t : `${docTitle} › ${t}`;
      if (cur.body) { flush(); cur = { title, start: i + 1, lines: [line], body: false }; }
      else { cur.title = title; cur.lines.push(line); }            // only frontmatter so far: one chunk, not two
    } else {
      cur.lines.push(line);
      if (i >= fmLines && line.trim()) cur.body = true;
    }
  });
  flush();
  return out.filter((s) => s.body.length >= 20);
}

// CHANGELOG.md: the preamble (how the file is kept), then one chunk per top-level "- " entry, titled with its version.
function changelogEntries(text) {
  const lines = text.split('\n');
  const first = lines.findIndex((l) => /^##\s/.test(l));
  const out = first > 0 ? [{ title: 'CHANGELOG', start: 1, end: first, body: lines.slice(0, first).join('\n').trim() }] : [];
  let version = '';
  let cur = null;
  const flush = () => { if (cur) out.push({ ...cur, body: cur.lines.join('\n'), end: cur.start + cur.lines.length - 1 }); cur = null; };
  lines.forEach((line, i) => {
    const v = /^##\s+\[([^\]]+)\]/.exec(line);
    if (v) { flush(); version = v[1]; return; }
    if (/^- /.test(line)) { flush(); cur = { title: `CHANGELOG ${version}`, start: i + 1, lines: [line] }; }
    else if (cur && (/^\s+\S/.test(line))) cur.lines.push(line);
    else flush();
  });
  flush();
  return out;
}
