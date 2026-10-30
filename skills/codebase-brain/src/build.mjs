// brain build: code facts + team knowledge -> one brain.db. Never writes into the target repo.
import { resolve } from 'node:path';
import { statSync } from 'node:fs';
import { createDb, setMeta, inTransaction } from './db.mjs';
import { trackedFiles, headCommit, git, TS_EXT, CPP_EXT, PY_EXT } from './files.mjs';
import { loadTypeScript, indexTypeScript } from './index-ts.mjs';
import { indexGeneric } from './index-generic.mjs';
import { indexKnowledge } from './index-knowledge.mjs';

export function build({ repo, dbPath, vault, includeRoots = [], noKnowledge = false, log = console.error, tilde = (p) => p }) {
  repo = resolve(repo);
  const t0 = Date.now();
  const lap = (from) => +((Date.now() - from) / 1000).toFixed(2);
  const commit = headCommit(repo);
  const commitDate = commit ? git(repo, ['show', '-s', '--format=%cI', commit]).trim().slice(0, 10) : null;
  const tracked = trackedFiles(repo);
  log(`brain build ${tilde(repo)} @ ${commit?.slice(0, 8) ?? '(no git)'} — ${tracked.length} tracked files`);

  const db = createDb(dbPath);
  const insNode = db.prepare(`INSERT INTO nodes(key, kind, name, path, line, end_line, parent, exported, lang, flags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insEdge = db.prepare('INSERT INTO edges(src, dst, kind, path, line, col) VALUES (?, ?, ?, ?, ?, ?)');
  const addNode = (n) => Number(insNode.run(n.key, n.kind, n.name, n.path ?? null, n.line ?? null, n.end_line ?? null,
    n.parent ?? null, n.exported ?? 0, n.lang ?? null, n.flags ?? '').lastInsertRowid);
  const addEdge = (src, dst, kind, path, line, col) => insEdge.run(src, dst, kind, path, line, col);

  const timings = {}, stats = {};
  inTransaction(db, () => {
    if (tracked.some((p) => TS_EXT.test(p))) {
      const t = Date.now();
      const { ts, from } = loadTypeScript(repo);
      log(`  typescript ${ts.version} (${from})`);
      stats.ts = { version: ts.version, from, ...indexTypeScript({ ts, repo, tracked, db, addNode, addEdge, log }) };
      timings.ts = lap(t);
    }
    if (tracked.some((p) => CPP_EXT.test(p) || PY_EXT.test(p))) {
      const t = Date.now();
      stats.generic = indexGeneric({ repo, tracked, db, addNode, addEdge, includeRoots });
      timings.generic = lap(t);
      const g = stats.generic;
      log(`  #include: ${g.cppFiles} C/C++ files, ${g.includeEdges} edges · import: ${g.pyFiles} Python files, ${g.pyEdges} edges (${timings.generic}s)`);
    }
    if (!noKnowledge) {
      const t = Date.now();
      stats.knowledge = indexKnowledge({ repo, tracked, db, vault, commitDate, log });
      timings.knowledge = lap(t);
    }
    const unresolvedLocal = (stats.ts?.unresolvedLocal ?? 0) + (stats.generic?.unresolvedLocal ?? 0);
    setMeta(db, 'repo', repo);
    setMeta(db, 'commit', commit);
    setMeta(db, 'commit_date', commitDate);
    setMeta(db, 'built_at', new Date().toISOString());
    setMeta(db, 'tracked_files', tracked.length);
    setMeta(db, 'vault', vault ?? null);
    setMeta(db, 'stats', stats);
    setMeta(db, 'coverage', { unresolvedLocal, programs: stats.ts?.programs ?? 0, orphans: stats.ts?.orphans ?? 0 });
    timings.total = lap(t0);
    setMeta(db, 'timings', timings);
  });
  db.exec('ANALYZE');
  db.close();
  const size = statSync(dbPath).size;
  log(`done in ${timings.total}s → ${tilde(dbPath)} (${(size / 1e6).toFixed(1)} MB)`);
  return { timings, stats, size };
}
