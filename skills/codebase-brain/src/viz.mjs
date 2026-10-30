// brain viz: the 2-hop neighbourhood of a target as one self-contained HTML file (no CDN, works offline).
// Layout is computed here (seeded, deterministic): rings by hop, then a short force pass to untangle.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { impact } from './query.mjs';
import { why } from './why.mjs';
import { getMeta } from './db.mjs';

const MODULE_EDGES = `'imports','imports-type','reexports','dynamic-import','mocks','includes'`;

export function viz(db, node, { out, hops = 2, question, max = 260 } = {}) {
  const meta = getMeta(db);
  const imp = impact(db, node, {});                       // full closure for the numbers, 2 hops for the picture
  const all = [...imp.fileHop].filter(([, h]) => h <= hops);
  const center = node.kind === 'file' ? node.path : node.path;
  // keep every direct dependent; fill the rest with the best-connected hop-2 files
  const fileIdOf = db.prepare('SELECT id FROM nodes WHERE key = ?');
  const ids = new Map(all.map(([p]) => [p, fileIdOf.get(p)?.id]));
  const edgeRows = db.prepare(`SELECT s.path AS a, d.path AS b, group_concat(DISTINCT e.kind) AS k FROM edges e JOIN nodes s ON s.id = e.src
    JOIN nodes d ON d.id = e.dst WHERE e.src = ? AND e.kind IN (${MODULE_EDGES}) GROUP BY d.path`);
  const useRows = db.prepare(`SELECT e.path AS a, d.path AS b, 'use' AS k FROM edges e JOIN nodes d ON d.id = e.dst
    WHERE e.path = ? AND d.path != e.path AND e.kind NOT IN ('import','export') GROUP BY d.path`);
  // one line per file pair, styled by what the pair has: a value import, only `import type`, only vi.mock, or a symbol use
  const styleOf = (k) => { const ks = k.split(','); return ks.every((x) => x === 'mocks') ? 'mock' : ks.every((x) => x === 'imports-type') ? 'type' : k === 'use' ? 'use' : 'import'; };
  const inSet = new Set(all.map(([p]) => p));
  const byPair = new Map();
  for (const [p] of all) {
    const rows = [...edgeRows.all(ids.get(p) ?? -1), ...(node.kind !== 'file' ? useRows.all(p) : [])];
    for (const r of rows) if (inSet.has(r.b) && r.a !== r.b && !byPair.has(`${r.a}\0${r.b}`)) byPair.set(`${r.a}\0${r.b}`, [r.a, r.b, styleOf(r.k)]);
  }
  const uniq = [...byPair.values()];
  const degree = new Map();
  for (const [a, b] of uniq) { degree.set(a, (degree.get(a) || 0) + 1); degree.set(b, (degree.get(b) || 0) + 1); }
  let keep = all;
  if (all.length > max) {
    const h1 = all.filter(([, h]) => h <= 1);
    const h2 = all.filter(([, h]) => h > 1).sort((x, y) => (degree.get(y[0]) || 0) - (degree.get(x[0]) || 0));
    keep = [...h1, ...h2.slice(0, Math.max(0, max - h1.length))];
  }
  const kept = new Set(keep.map(([p]) => p));
  const links = uniq.filter(([a, b]) => kept.has(a) && kept.has(b));

  // hub: a direct dependent that many hop-2 files reach the target through
  const via = new Map();
  for (const [a, b] of links) if (imp.fileHop.get(b) === 1 && imp.fileHop.get(a) === 2) via.set(b, (via.get(b) || 0) + 1);
  const hubs = [...via].sort((x, y) => y[1] - x[1]).slice(0, 3);

  const touch = db.prepare(`SELECT c.source, c.sha, c.date, c.title, c.prs FROM links l JOIN chunks c ON c.id = l.chunk
    WHERE l.node = ? AND l.kind = 'touches' ORDER BY c.date DESC LIMIT 2`);
  const mention = db.prepare(`SELECT c.source, c.sha, c.path, c.start_line, c.end_line, c.title, c.date, c.prs FROM links l JOIN chunks c ON c.id = l.chunk
    WHERE l.node = ? AND l.kind != 'touches' ORDER BY c.date DESC LIMIT 2`);
  // a commit message that names the file is a commit, not a doc: it has a SHA, no path
  const note = (r) => r.source === 'commit' ? { t: 'commit', cite: r.sha.slice(0, 8), date: r.date, title: r.title, prs: r.prs }
    : { t: 'doc', cite: `${r.path}:${r.start_line}-${r.end_line}`, title: r.title };
  const nodes = keep.map(([p, h]) => {
    const id = ids.get(p) ?? fileIdOf.get(p)?.id;
    const notes = id ? [...touch.all(id), ...mention.all(id)].map(note).filter((n, i, all) => all.findIndex((m) => m.cite === n.cite) === i) : [];
    return { id: p, hop: h, area: areaOf(p, imp.flagsOf.get(p) || ''), flags: imp.flagsOf.get(p) || '', deg: degree.get(p) || 0, notes };
  });
  layout(nodes, links, center);

  const q = question || `why ${node.name} ${node.kind === 'file' ? '' : node.path}`;
  const w = why(db, q, { limit: 6 });
  const data = {
    target: node.key, kind: node.kind, commit: meta.commit?.slice(0, 8), repo: meta.repo.split('/').pop(), question: q,
    total: imp.total, shown: nodes.length - 1, totalWithin: all.length - 1, beyond: imp.total - (all.length - 1), hopsDrawn: hops,
    hops: imp.hops.filter((h) => h.hop <= hops).map(({ hop, files, tests }) => ({ hop, files, tests })),
    allHops: imp.hops.map(({ hop, files, tests }) => ({ hop, files, tests })),
    hubs: hubs.map(([p, n]) => ({ path: p, via: n })), nodes, links,
    why: w.citations.map(({ source, cite, date, prs, title, snippet }) => ({ source, cite, date, prs, title, snippet })),
  };
  const file = out || join(tmpdir(), `brain-viz-${node.name.replace(/[^\w.-]/g, '_')}.html`);
  writeFileSync(file, page(data));
  return file;
}

function areaOf(p, flags) {
  if (flags.includes('test')) return 'test';
  const top = p.split('/')[0];
  if (['app', 'components', 'features'].includes(top)) return 'ui';
  if (['lib', 'shared'].includes(top)) return 'lib';
  if (top === 'services') return 'services';
  if (top === 'actions') return 'actions';
  if (p.includes('/io/async/')) return 'async';
  if (p.includes('/io/')) return 'io';
  return 'other';
}

// rings by hop, areas grouped by angle, then springs + repulsion with a pull back to the ring
function layout(nodes, links, center) {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const R = { 0: 0, 1: 220, 2: 440 };
  const order = ['ui', 'actions', 'lib', 'services', 'io', 'async', 'other', 'test'];
  const byHop = new Map();
  for (const n of nodes) { const h = Math.min(n.hop, 2); if (!byHop.has(h)) byHop.set(h, []); byHop.get(h).push(n); }
  for (const [h, list] of byHop) {
    list.sort((a, b) => order.indexOf(a.area) - order.indexOf(b.area) || a.id.localeCompare(b.id));
    list.forEach((n, i) => {
      const a = (i / list.length) * Math.PI * 2 + (h === 2 ? 0.15 : 0);
      n.r = R[h] + (h ? (rnd() - 0.5) * 36 : 0);
      n.x = Math.cos(a) * n.r; n.y = Math.sin(a) * n.r;
    });
  }
  const at = new Map(nodes.map((n) => [n.id, n]));
  const L = links.map(([a, b]) => [at.get(a), at.get(b)]).filter(([a, b]) => a && b);
  for (let it = 0; it < 220; it++) {
    const alpha = 1 - it / 220;
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      let dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy || 0.01;
      if (d2 > 90000) continue;
      const f = (700 / d2) * alpha;
      a.x += dx * f * 0.05; a.y += dy * f * 0.05; b.x -= dx * f * 0.05; b.y -= dy * f * 0.05;
    }
    for (const [a, b] of L) {
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1, f = ((d - 120) / d) * 0.004 * alpha;
      a.x += dx * f; a.y += dy * f; b.x -= dx * f; b.y -= dy * f;
    }
    for (const n of nodes) {
      if (n.id === center && n.hop === 0) { n.x = 0; n.y = 0; continue; }
      const d = Math.hypot(n.x, n.y) || 1, k = 0.35;
      n.x += ((n.x / d) * n.r - n.x) * k; n.y += ((n.y / d) * n.r - n.y) * k;
    }
  }
  for (const n of nodes) { n.x = Math.round(n.x); n.y = Math.round(n.y); delete n.r; }
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

function page(d) {
  const json = JSON.stringify(d).replace(/</g, '\\u003c');
  const name = d.target.split(/[#/]/).pop();
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>brain viz · ${esc(name)}</title>
<style>
:root{--bg:#f7f7f5;--panel:#ffffff;--ink:#1d1d1f;--mute:#6b6b70;--line:#d9d9de;--edge:rgba(60,60,70,.16);--edge-hi:rgba(214,40,57,.75);
--target:#d62839;--ui:#2f6fde;--actions:#7b4fd6;--lib:#0f9d76;--services:#0b8fa8;--pipeline:#b83280;--io:#2f6fde;--async:#0f9d76;--test:#e8590c;--other:#8a8a92}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#111214;--panel:#1a1b1e;--ink:#ececf1;--mute:#9a9aa3;--line:#2c2d33;--edge:rgba(220,220,235,.13);--edge-hi:rgba(255,99,112,.85);
--target:#ff5d6c;--ui:#6ea2ff;--actions:#a98bff;--lib:#3ed3a5;--services:#3fd0ec;--pipeline:#ff73c6;--io:#6ea2ff;--async:#3ed3a5;--test:#ff9b54;--other:#8d8d96}}
:root[data-theme="dark"]{--bg:#111214;--panel:#1a1b1e;--ink:#ececf1;--mute:#9a9aa3;--line:#2c2d33;--edge:rgba(220,220,235,.13);--edge-hi:rgba(255,99,112,.85);
--target:#ff5d6c;--ui:#6ea2ff;--actions:#a98bff;--lib:#3ed3a5;--services:#3fd0ec;--pipeline:#ff73c6;--io:#6ea2ff;--async:#3ed3a5;--test:#ff9b54;--other:#8d8d96}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI","Apple SD Gothic Neo","Noto Sans KR",sans-serif}
.wrap{display:grid;grid-template-columns:minmax(0,1fr) 380px;gap:16px;padding:16px;min-height:100vh}
@media (max-width:900px){.wrap{grid-template-columns:1fr}}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px 16px}
h1{font-size:18px;margin:0 0 2px}h2{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--mute);margin:16px 0 8px}
.mute{color:var(--mute)}code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace}
svg{width:100%;height:auto;display:block}
.stat{display:flex;gap:18px;margin:8px 0 0}.stat b{display:block;font-size:26px;line-height:1.1}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}td,th{padding:3px 6px;text-align:right;border-bottom:1px solid var(--line)}td:first-child,th:first-child{text-align:left}
th{color:var(--mute);font-weight:500;font-size:12px}
.legend{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12px;color:var(--mute);margin-top:8px}.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:5px;vertical-align:-1px}
.cite{border-top:1px solid var(--line);padding:8px 0}.cite:first-of-type{border-top:0}
.badge{display:inline-block;font-size:11px;padding:0 6px;border-radius:6px;border:1px solid var(--line);color:var(--mute);margin-right:6px}
.snip{color:var(--mute);font-size:12.5px;margin-top:2px}
#tip{position:fixed;pointer-events:none;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:8px 10px;font-size:12px;max-width:420px;display:none;box-shadow:0 6px 24px rgba(0,0,0,.18)}
circle{stroke:var(--panel);stroke-width:1.5}line{stroke:var(--edge)}line.type{stroke-dasharray:5 4}line.mock{stroke-dasharray:1 3}line.hi{stroke:var(--edge-hi);stroke-width:1.6}
.edgekey{display:inline-block;width:26px;border-top:2px solid var(--mute);margin-right:5px;vertical-align:3px}circle.dim{opacity:.25}
.ring{fill:none;stroke:var(--line);stroke-dasharray:3 5}.ringlabel{fill:var(--mute);font-size:12px}
.label{fill:var(--ink);font-size:12px;paint-order:stroke;stroke:var(--bg);stroke-width:4px}
</style></head><body>
<div class="wrap">
  <div class="card">
    <h1 id="title"></h1>
    <div class="mute" id="sub"></div>
    <svg id="g" viewBox="-560 -540 1120 1080" role="img" aria-label="dependency graph"></svg>
    <div class="legend" id="legend"></div>
  </div>
  <div>
    <div class="card">
      <h2 style="margin-top:0">May be affected · reverse imports, all hops</h2>
      <div class="stat" id="stat"></div>
      <table id="hops"></table>
      <h2>Hubs</h2><div id="hubs"></div>
    </div>
    <div class="card" style="margin-top:16px">
      <h2 style="margin-top:0">Why · FAST, no LLM</h2>
      <div class="mute" id="q" style="font-size:12.5px"></div>
      <div id="why"></div>
    </div>
    <div class="card" style="margin-top:16px"><h2 style="margin-top:0">Selected file</h2><div id="sel" class="mute">Hover or tap a dot.</div></div>
  </div>
</div>
<div id="tip"></div>
<script>
const D = ${json};
const theme = new URLSearchParams(location.search).get('theme');
if (theme) document.documentElement.dataset.theme = theme;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const AREAS = {target:'target',ui:'app · components · features',actions:'actions',lib:'lib · shared',services:'services',io:'io',async:'io/async',test:'tests',other:'other'};
$('title').textContent = D.target;
const notDrawn = [D.totalWithin - D.shown ? (D.totalWithin - D.shown) + ' hop-' + D.hopsDrawn + ' files (cap)' : '', D.beyond ? D.beyond + ' files at hop ' + (D.hopsDrawn + 1) + '+' : ''].filter(Boolean);
$('sub').innerHTML = esc(D.repo) + ' @' + esc(D.commit) + ' · picture = hops 1–' + D.hopsDrawn + ' only: ' + D.shown + ' files, ' + D.links.length + ' edges · not drawn: ' + (notDrawn.join(', ') || 'nothing');
$('stat').innerHTML = '<div><b>' + D.total.toLocaleString() + '</b><span class="mute">files may be affected</span></div><div><b>' + D.allHops.reduce((a,h)=>a+h.tests,0).toLocaleString() + '</b><span class="mute">tests</span></div><div><b>' + D.allHops.length + '</b><span class="mute">hops deep</span></div>';
$('hops').innerHTML = '<tr><th>hop</th><th>files</th><th>tests</th></tr>' + D.allHops.map(h => '<tr><td>' + (h.hop===1?'1 (direct)':h.hop) + '</td><td>' + h.files + '</td><td>' + h.tests + '</td></tr>').join('');
$('hubs').innerHTML = D.hubs.length ? D.hubs.map(h => '<div><code>' + esc(h.path) + '</code> <span class="mute">· ' + h.via + ' more files reach the target through it</span></div>').join('') : '<span class="mute">none</span>';
$('q').textContent = '“' + D.question + '”';
$('why').innerHTML = D.why.length === 0 ? '<div class="mute" style="margin-top:6px">No doc, change note or commit in this repo mentions it: a knowledge gap. The graph says where; nothing says why.</div>' : D.why.map(c => '<div class="cite"><span class="badge">' + esc(c.source) + '</span><code>' + esc(c.cite) + '</code> <span class="mute">' + esc(c.date||'') + ' ' + esc(c.prs.split(' ').slice(0,2).join(' ')) + '</span><div>' + esc(c.title) + '</div><div class="snip">' + esc(c.snippet.slice(0,180)) + '</div></div>').join('') || '<span class="mute">no citations</span>';
const used = new Set(D.nodes.map(n => n.hop === 0 ? 'target' : n.area));
const styles = new Set(D.links.map(l => l[2]));
const EDGES = {import:['import','imports (arrow → the file it imports)'],type:['type','import type only'],mock:['mock','vi.mock only'],use:['use','uses a symbol']};
$('legend').innerHTML = Object.entries(AREAS).filter(([k]) => used.has(k)).map(([k,v]) => '<span><span class="dot" style="background:var(--' + k + ')"></span>' + esc(v) + '</span>').join('') +
  Object.entries(EDGES).filter(([k]) => styles.has(k)).map(([k,[cls,v]]) => '<span><svg width="28" height="8" style="display:inline;width:28px;vertical-align:0"><line x1="0" y1="4" x2="28" y2="4" class="' + cls + '" style="stroke:var(--mute);stroke-width:1.6"/></svg> ' + esc(v) + '</span>').join('');
const NS = 'http://www.w3.org/2000/svg', svg = $('g');
const el = (t, a) => { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); return e; };
for (const [r, label] of [[220,'hop 1'],[440,'hop 2']]) { svg.append(el('circle', {class:'ring', r})); const t = el('text', {class:'ringlabel', x: r * 0.72 + 8, y: -r * 0.72 - 8}); t.textContent = label; svg.append(t); }
const at = new Map(D.nodes.map(n => [n.id, n]));
const defs = el('defs', {}); const mk = el('marker', {id:'arr', viewBox:'0 0 6 6', refX:'14', refY:'3', markerWidth:'5', markerHeight:'5', orient:'auto'});
mk.append(el('path', {d:'M0,0 L6,3 L0,6 z', style:'fill:var(--mute);opacity:.5'})); defs.append(mk); svg.append(defs);
const lineEls = D.links.map(([a,b,k]) => { const A = at.get(a), B = at.get(b); const l = el('line', {x1:A.x,y1:A.y,x2:B.x,y2:B.y,class:k,'marker-end':'url(#arr)'}); l.dataset.a = a; l.dataset.b = b; svg.append(l); return l; });
const dots = D.nodes.map(n => {
  const c = el('circle', {cx:n.x, cy:n.y, r: n.hop === 0 ? 13 : Math.min(9, 3.5 + Math.sqrt(n.deg)), fill: 'var(--' + (n.hop === 0 ? 'target' : n.area) + ')'});
  c.dataset.id = n.id; svg.append(c); return c;
});
const t0 = at.get(D.nodes.find(n => n.hop === 0)?.id);
if (t0) { const t = el('text', {class:'label', x: t0.x + 16, y: t0.y + 4}); t.textContent = D.target.split('/').pop(); svg.append(t); }
for (const h of D.hubs.slice(0, 3)) { const n = at.get(h.path); if (!n) continue; const t = el('text', {class:'label', x: n.x + 10, y: n.y - 8}); t.textContent = h.path.split('/').pop(); svg.append(t); }
const tip = $('tip');
function show(n, ev) {
  for (const l of lineEls) l.classList.toggle('hi', l.dataset.a === n.id || l.dataset.b === n.id);
  const near = new Set([n.id, ...D.links.filter(([a,b]) => a === n.id || b === n.id).flatMap(([a,b]) => [a,b])]);
  for (const d of dots) d.classList.toggle('dim', !near.has(d.dataset.id));
  const html = '<div><code>' + esc(n.id) + '</code></div><div class="mute">hop ' + n.hop + (n.flags ? ' · ' + esc(n.flags) : '') + ' · ' + n.deg + ' edges here</div>' +
    n.notes.map(x => '<div style="margin-top:4px"><span class="badge">' + x.t + '</span><code>' + esc(x.cite) + '</code> ' + esc(x.title) + '</div>').join('');
  $('sel').innerHTML = html;
  if (ev) { tip.innerHTML = html; tip.style.display = 'block'; tip.style.left = Math.min(ev.clientX + 14, innerWidth - 440) + 'px'; tip.style.top = (ev.clientY + 14) + 'px'; }
}
function clear() { tip.style.display = 'none'; for (const l of lineEls) l.classList.remove('hi'); for (const d of dots) d.classList.remove('dim'); }
for (const d of dots) { const n = at.get(d.dataset.id); d.addEventListener('mousemove', (e) => show(n, e)); d.addEventListener('mouseleave', clear); d.addEventListener('click', () => show(n)); }
</script></body></html>`;
}
