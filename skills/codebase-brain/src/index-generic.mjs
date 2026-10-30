// Generic adapter: file-level graph from `#include` (C/C++) and `import` (Python) lines only.
// No compiler, so no symbols: this is the folly include graph from the talk.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, posix } from 'node:path';
import { CPP_EXT, PY_EXT, fileFlags, readHead } from './files.mjs';

const INCLUDE = /^\s*#\s*include\s*([<"])([^>"]+)[>"]/;
const PY_IMPORT = /^\s*(?:from\s+(\.*[\w.]*)\s+import\s+([\w*, ()]+)|import\s+([\w., ]+))/;

export function indexGeneric({ repo, tracked, addNode, addEdge, db, includeRoots = [] }) {
  const cpp = tracked.filter((p) => CPP_EXT.test(p));
  const py = tracked.filter((p) => PY_EXT.test(p));
  const known = new Set(tracked);
  const fileId = new Map();
  const stats = { files: 0, edges: 0, unresolvedLocal: 0, external: 0, cppFiles: cpp.length, includeEdges: 0, pyFiles: py.length, pyEdges: 0 };
  const unresolved = db.prepare('INSERT INTO unresolved(path, line, spec, local) VALUES (?, ?, ?, ?)');
  const node = (rel, lang) => {
    if (!fileId.has(rel)) {
      fileId.set(rel, addNode({ key: rel, kind: 'file', name: rel.split('/').pop(), path: rel, line: 1, lang,
        flags: fileFlags(rel, readHead(join(repo, rel))) }));
      stats.files++;
    }
    return fileId.get(rel);
  };

  // `#include <folly/io/IOBuf.h>` resolves against the repo root (and any -I roots); `"x.h"` tries the includer's dir first.
  const roots = ['', ...includeRoots.map((r) => r.replace(/\/?$/, '/'))];
  for (const rel of cpp) {
    const from = node(rel, 'cpp');
    const lines = readFileSync(join(repo, rel), 'utf8').split('\n');
    lines.forEach((text, i) => {
      const m = INCLUDE.exec(text);
      if (!m) return;
      const [, quote, spec] = m;
      const candidates = [...(quote === '"' ? [posix.join(dirname(rel), spec)] : []), ...roots.map((r) => posix.normalize(r + spec))];
      const hit = candidates.find((c) => known.has(c));
      if (hit) { addEdge(from, node(hit, 'cpp'), 'includes', rel, i + 1, 0); stats.edges++; stats.includeEdges++; return; }
      // a quoted include we cannot find is ours; an angle include we cannot find is a system/third-party header
      if (quote === '"') { stats.unresolvedLocal++; unresolved.run(rel, i + 1, spec, 1); } else stats.external++;
    });
  }

  for (const rel of py) {
    const from = node(rel, 'py');
    readFileSync(join(repo, rel), 'utf8').split('\n').forEach((text, i) => {
      const m = PY_IMPORT.exec(text);
      if (!m) return;
      // `from pkg import mod` may name a submodule: try pkg/mod.py first, then pkg itself
      const names = m[1] !== undefined ? m[2].replace(/[()]/g, '').split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean) : [];
      const mods = m[1] !== undefined ? [m[1]] : m[3].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]);
      for (const mod of mods) {
        const sub = names.map((n) => resolvePython(rel, mod.endsWith('.') ? mod + n : `${mod}.${n}`, known)).filter(Boolean);
        if (sub.length) { for (const t of new Set(sub)) { addEdge(from, node(t, 'py'), 'imports', rel, i + 1, 0); stats.edges++; stats.pyEdges++; } continue; }
        const target = resolvePython(rel, mod, known);
        if (target) { addEdge(from, node(target, 'py'), 'imports', rel, i + 1, 0); stats.edges++; stats.pyEdges++; }
        else if (mod.startsWith('.')) { stats.unresolvedLocal++; unresolved.run(rel, i + 1, mod, 1); }
        else stats.external++;
      }
    });
  }
  return stats;
}

function resolvePython(rel, mod, known) {
  let base;
  if (mod.startsWith('.')) {
    const dots = mod.match(/^\.+/)[0].length;
    base = dirname(rel).split('/').slice(0, dots > 1 ? -(dots - 1) : undefined).join('/');
    mod = mod.slice(dots);
  } else base = '';
  const p = posix.join(base, mod.replace(/\./g, '/'));
  return [`${p}.py`, `${p}/__init__.py`].find((c) => known.has(c.replace(/^\.\//, '')));
}
