// Design doc markdown -> one interactive HTML page. The markdown stays the single source.
// usage: node build-html.mjs <in.md> <out.html> [--widgets DIR]... [--eyebrow TEXT] [--place SEC=NAME,...]
//   <!--widget:NAME--> on its own line in the md is replaced by DIR/NAME.html (+ DIR/NAME.js in the page script).
//   --place s6-2=sync puts widget "sync" at the end of subsection 6.2 (for docs you cannot add markers to).
//   The task explorer ("plan") is built in: it reads the §8 table whose first column is "ID".
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const opt = { widgets: [], eyebrow: '설계서', place: {} };
const pos = [];
for (let k = 0; k < argv.length; k++) {
  const a = argv[k];
  if (a === '--widgets') opt.widgets.push(argv[++k]);
  else if (a === '--eyebrow') opt.eyebrow = argv[++k];
  else if (a === '--place') for (const p of argv[++k].split(',')) { const [s, n] = p.split('='); opt.place[s] = n; }
  else pos.push(a);
}
const [src, out] = pos;
if (!src || !out) { console.error('usage: node build-html.mjs <in.md> <out.html> [--widgets DIR] [--eyebrow TEXT] [--place SEC=NAME,...]'); process.exit(2); }

const md = readFileSync(src, 'utf8');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function inline(s) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
  return s;
}
const cells = (line) => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
const idOf = (text) => { const m = /^(\d+(?:\.\d+)?)\.?\s/.exec(text); return m ? 's' + m[1].replace('.', '-') : 's-' + text.toLowerCase().replace(/[^a-z0-9가-힣]+/g, '-').replace(/^-|-$/g, ''); };

const lines = md.split('\n');
let title = '', i = 0;
const meta = [], body = [], toc = [], used = new Set();
let h2 = null, h3 = null, para = [], list = null, quote = [], taskTable = null;

const flushPara = () => { if (para.length) { body.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
const flushList = () => { if (list) { body.push(`<${list.tag}>${list.items.map((x) => `<li>${inline(x)}</li>`).join('')}</${list.tag}>`); list = null; } };
const flushQuote = () => { if (quote.length) { body.push(`<blockquote><p>${inline(quote.join(' '))}</p></blockquote>`); quote = []; } };
const flush = () => { flushPara(); flushList(); flushQuote(); };
const marker = (name) => { used.add(name); body.push(`<!--widget:${name}-->`); };
const closeH3 = () => { if (h3) { if (opt.place[h3]) marker(opt.place[h3]); body.push('</div>'); h3 = null; } };
const closeH2 = () => { closeH3(); if (h2) { if (opt.place[h2]) marker(opt.place[h2]); body.push('</section>'); h2 = null; } };

// header: "# title", then the bullet list up to the first "---"
for (; i < lines.length; i++) {
  const l = lines[i];
  if (l.startsWith('# ')) { title = l.slice(2).trim(); continue; }
  if (l.startsWith('- ') && title) { meta.push(l.slice(2)); continue; }
  if (!l.trim()) continue;
  if (/^---\s*$/.test(l)) { i++; }
  break;
}

for (; i < lines.length; i++) {
  const l = lines[i];
  const w = /^<!--\s*widget:([\w-]+)\s*-->\s*$/.exec(l);
  if (w) { flush(); marker(w[1]); continue; }
  if (/^```/.test(l)) {
    flush();
    const lang = l.slice(3).trim();
    const buf = [];
    for (i++; i < lines.length && !/^```/.test(lines[i]); i++) buf.push(lines[i]);
    if (lang === 'mermaid') body.push(`<figure class="diagram" tabindex="0" title="클릭하면 크게 봅니다"><pre class="mermaid">${esc(buf.join('\n'))}</pre><figcaption>클릭하면 크게 봅니다</figcaption></figure>`);
    else body.push(`<div class="term-wrap"><pre class="term">${esc(buf.join('\n'))}</pre></div>`);
    continue;
  }
  const h = /^(#{2,4})\s+(.+)$/.exec(l);
  if (h) {
    flush();
    const level = h[1].length, text = h[2].trim(), id = idOf(text);
    if (level === 2) { closeH2(); h2 = id; body.push(`<section id="${id}" class="sec"><h2>${inline(text)}</h2>`); toc.push({ id, text, level }); }
    else if (level === 3) { closeH3(); h3 = id; body.push(`<div id="${id}" class="sub"><h3>${inline(text)}</h3>`); toc.push({ id, text, level }); }
    else body.push(`<h4>${inline(text)}</h4>`);
    continue;
  }
  if (/^\|/.test(l)) {
    flush();
    const rows = [];
    for (; i < lines.length && /^\|/.test(lines[i]); i++) rows.push(lines[i]);
    i--;
    const head = cells(rows[0]);
    const data = rows.slice(2).map(cells);
    if (!taskTable && h2 === 's8' && head[0] === 'ID') taskTable = { head, data, sec: h3 };
    body.push(`<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${data.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
    continue;
  }
  const q = /^>\s?(.*)$/.exec(l);
  if (q) { flushPara(); flushList(); quote.push(q[1]); continue; }
  const li = /^(\s*)(- |\d+\. )(.*)$/.exec(l);
  if (li) {
    flushPara(); flushQuote();
    const tag = /\d/.test(li[2]) ? 'ol' : 'ul';
    if (li[1].length && list) { list.items[list.items.length - 1] += ' ' + li[3]; continue; }   // one nesting level folds into its parent
    if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
    list.items.push(li[3]);
    continue;
  }
  if (/^---\s*$/.test(l) || !l.trim()) { flush(); continue; }
  if (list && /^\s+\S/.test(l)) { list.items[list.items.length - 1] += ' ' + l.trim(); continue; }
  flushList(); flushQuote();
  para.push(l.trim());
}
flush();
closeH2();

// ---- task plan from the §8 "ID" table: deps, waves, critical path ----
const plan = { tasks: [], crit: [], waves: 0 };
if (taskTable) {
  const { head, data } = taskTable;
  const col = (...names) => head.findIndex((x) => names.some((n) => x.startsWith(n)));
  const c = { id: col('ID'), work: col('작업'), recv: col('받는'), out: col('내놓는', '산출물'), deps: col('의존'), wave: col('웨이브'), size: col('크기'), done: col('완료') };
  const get = (r, k) => (c[k] >= 0 ? r[c[k]] || '' : '');
  const ids = data.map((r) => get(r, 'id').replace(/[`*]/g, '').trim());
  const idRe = new RegExp(`(?<![A-Za-z0-9])(${[...ids].sort((a, b) => b.length - a.length).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![A-Za-z0-9])`, 'g');
  plan.tasks = data.map((r, k) => ({
    id: ids[k], work: get(r, 'work'), recv: get(r, 'recv'), out: get(r, 'out'), depsText: get(r, 'deps'),
    deps: [...new Set([...get(r, 'deps').matchAll(idRe)].map((m) => m[1]))].filter((d) => d !== ids[k]),
    size: get(r, 'size'), done: get(r, 'done'), wave: c.wave >= 0 && /^\d+$/.test(get(r, 'wave').trim()) ? +get(r, 'wave') : null,
  }));
  const byId = Object.fromEntries(plan.tasks.map((t) => [t.id, t]));
  const weight = (t) => ({ S: 1, M: 2, L: 3 })[(t.size.trim()[0] || '').toUpperCase()] || 1;
  const depth = {}, dist = {}, prev = {}, seen = new Set();
  const visit = (id) => {
    if (id in depth) return;
    if (seen.has(id)) throw new Error(`task dependency cycle at ${id}`);
    seen.add(id);
    const t = byId[id];
    let d = -1, best = 0, from = null;
    for (const p of t.deps) { visit(p); d = Math.max(d, depth[p]); if (dist[p] > best) { best = dist[p]; from = p; } }
    depth[id] = t.wave ?? d + 1; dist[id] = best + weight(t); prev[id] = from;
  };
  plan.tasks.forEach((t) => visit(t.id));
  plan.tasks.forEach((t) => { t.wave = depth[t.id]; });
  plan.waves = Math.max(...plan.tasks.map((t) => t.wave)) + 1;
  let end = plan.tasks.reduce((a, t) => (dist[t.id] > dist[a.id] ? t : a), plan.tasks[0]).id;
  for (; end; end = prev[end]) plan.crit.unshift(end);
}
const planWidget = () => `<div class="widget" id="w-plan">
  <div class="w-head"><b>직접 눌러 보기 · 작업과 의존</b><small>§8 작업 표에서 읽어 온 작업 ${plan.tasks.length}개 · 웨이브는 의존 깊이</small></div>
  <div class="controls"><label><input type="checkbox" id="planCrit"> critical path 표시 (${plan.crit.join(' → ')}, 크기 S=1 · M=2 · L=3)</label></div>
  <div class="waves" style="--waves:${plan.waves}"></div>
  <div class="legend">
    <span><i style="border-color:var(--accent);background:var(--accent-soft)"></i>고른 작업</span>
    <span><i style="border-color:var(--amber)"></i>먼저 끝나야 함</span>
    <span><i style="border-color:var(--ok)"></i>이 작업을 기다림</span>
    <span><i style="border-color:var(--bad);border-width:0 0 0 3px"></i>critical path</span>
  </div>
  <div class="detail"></div>
</div>`;

// ---- widgets: markers -> DIR/NAME.html, scripts -> DIR/NAME.js ----
if (taskTable && !used.has('plan')) {                   // default spot: end of the subsection after the task table's (8.1 -> 8.2), else the table's own
  const next = taskTable.sec?.replace(/-(\d+)$/, (_, n) => '-' + (+n + 1));
  let start = body.findIndex((b) => b.startsWith(`<div id="${next}" `));
  if (start < 0) start = body.findIndex((b) => b.startsWith(`<div id="${taskTable.sec}" `));
  const end = start < 0 ? -1 : body.indexOf('</div>', start);   // subsections never nest, so the first bare </div> closes it
  if (end >= 0) body.splice(end, 0, '<!--widget:plan-->'); else body.push('<!--widget:plan-->');
  used.add('plan');
}
const find = (name, ext) => { for (const d of opt.widgets) { const f = join(d, name + ext); if (existsSync(f)) return f; } return null; };
let html = body.join('\n');
const scripts = [];
for (const name of used) {
  if (name === 'plan') { html = html.replace('<!--widget:plan-->', planWidget()); continue; }
  const f = find(name, '.html');
  if (!f) { console.error(`widget "${name}" not found in: ${opt.widgets.join(', ') || '(no --widgets dir)'}`); process.exit(1); }
  html = html.replace(`<!--widget:${name}-->`, readFileSync(f, 'utf8'));
  const js = find(name, '.js');
  if (js) scripts.push(`// ---- widget: ${name} ----\n(function () {\n${readFileSync(js, 'utf8')}\n})();`);
}

const tpl = readFileSync(new URL('../assets/template.html', import.meta.url), 'utf8');
const metaHtml = meta.map((m) => { const [k, ...v] = m.split(':'); return v.length ? `<div class="chip"><span>${inline(k)}</span>${inline(v.join(':').trim())}</div>` : `<div class="chip">${inline(m)}</div>`; }).join('');
const tocHtml = toc.map((t) => `<a href="#${t.id}" class="toc-l${t.level}" data-id="${t.id}">${inline(t.text)}</a>`).join('');
const fill = { TITLE: esc(title), H1: inline(title), EYEBROW: esc(opt.eyebrow), META: metaHtml, TOC: tocHtml, BODY: html,
  PLAN: JSON.stringify(plan).replace(/</g, '\\u003c'), WIDGET_JS: scripts.join('\n\n') };
const page = tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in fill ? fill[k] : m));
writeFileSync(out, page);
const nMermaid = (md.match(/^```mermaid/gm) || []).length;
console.log(`wrote ${out}: ${toc.length} headings, ${nMermaid} mermaid, ${plan.tasks.length} tasks${plan.crit.length ? ` (critical path ${plan.crit.join(' → ')})` : ''}, widgets [${[...used].join(', ')}], ${(page.length / 1024).toFixed(0)} KB`);
