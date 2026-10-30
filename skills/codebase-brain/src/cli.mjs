// brain — a map (code graph) and a memory (docs + history) for coding agents.
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { build } from './build.mjs';
import { openDb, defaultDbPath, getMeta } from './db.mjs';
import { resolveTarget, find, refs, impact, deps, shared, freshness, freshnessOf, coverageFor } from './query.mjs';
import { why, markMentions } from './why.mjs';
import { MAX_NAME_OWNERS } from './index-knowledge.mjs';
import { viz } from './viz.mjs';
import { table, c, cut, cutLeft, plural, width, COLS } from './fmt.mjs';

const HELP = `brain — codebase map + memory (prototype)

  brain build <repo> [--db F] [--vault DIR] [--include-root DIR] [--no-knowledge] [--if-stale]
  brain status                         index commit, age, files changed since, coverage
  brain find <name|path>               symbols and files → IDs (path#Name)
  brain refs <target>                  every use site (file targets: every importer)
  brain callers <target>               call / new / render sites, grouped by enclosing symbol
  brain impact <target> [--hops N]     reverse BFS: files that may be affected, by hop + tests
  brain deps <target> [--hops N]       forward closure (what the target pulls in)
  brain shared <dirA> <dirB>           files both trees depend on
  brain why "<question>"               FAST: citations from docs, changes, commits, vault (no LLM)
  brain viz <target> [--out F]         2-hop graph + "why" panel as one HTML file

  common: --db F (or BRAIN_DB) · --repo DIR · --json · --limit N · --cursor N
          --filter test,page,route,server-action,client,script,generated · --exclude test
          --kind call,renders,type,…  · --no-types · --no-mocks · --files (one row per file) · --list (every path)`;

// notices show $HOME as ~ (build progress, status header, viz file); query results keep repo-relative paths
const HOME = homedir();
const tilde = (p) => (p && HOME && (p === HOME || p.startsWith(HOME + '/')) ? '~' + p.slice(HOME.length) : p);

const BOOL = new Set(['json', 'files', 'no-types', 'no-mocks', 'no-knowledge', 'if-stale', 'list', 'open', 'imports', 'help']);

function parse(argv) {
  const pos = [], opt = { 'include-root': [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const k = a.slice(2);
    if (BOOL.has(k)) opt[k] = true;
    else if (k === 'include-root') opt[k].push(argv[++i]);
    else opt[k] = argv[++i];
  }
  return { pos, opt };
}

const list = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : undefined);
const out = (s = '') => process.stdout.write(s + '\n');

// the checkout we are in: --repo, else the git repo around cwd
let checkout;
function here(opt) {
  if (opt.repo) return resolve(opt.repo);
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return undefined; }
}

function dbPathFor(opt) {
  if (opt.db) return resolve(opt.db);
  if (process.env.BRAIN_DB) return resolve(process.env.BRAIN_DB);
  return defaultDbPath(checkout ?? process.cwd());
}

function target(db, q, opt) {
  const r = resolveTarget(db, q);
  if (r.node) {
    if (r.others && !opt.json) out(c.dim(`  "${q}" → ${r.node.key} (the only exported one; ${r.others === 1 ? '1 local symbol shares' : `${r.others} local symbols share`} the name — brain find ${q})`));
    return r.node;
  }
  if (opt.json) out(JSON.stringify({ error: 'ambiguous-or-missing', query: q, candidates: (r.candidates || []).map((n) => n.key) }));
  else if (r.candidates?.length) {
    out(`${c.yellow('ambiguous')} "${q}" — pick one ID and ask again:`);
    out(table(['ID', 'KIND', 'LINE'], r.candidates.slice(0, 15).map((n) => [n.key, n.kind, n.line ?? '']), { max: [90] }));
  } else {
    const near = find(db, q.split(/[#/:]/).pop(), { limit: 5 }).rows;
    out(`${c.red('not found')} "${q}"${near.length ? ' — close matches:' : ''}  ${c.dim('(fail open: fall back to grep)')}`);
    for (const n of near) out(`  ${n.key}  ${c.dim(n.kind)}`);
  }
  process.exit(2);
}

// JSON answers carry it as `freshness`; text answers print the stale line only when the checkout moved on
const fresh = (db) => freshnessOf(freshness(db, checkout));
function staleNote(f) {
  if (f.state === 'stale') out(c.yellow(`  stale: HEAD @${f.head.slice(0, 8)}, ${plural(f.changed, 'file')} changed since the index — grep those, or brain build`));
}

function footer(db, cov, extra = '') {
  const f = fresh(db);
  const covText = cov.state === 'complete' ? c.green('complete')
    : cov.state === 'truncated' ? c.yellow('truncated') : c.yellow(`partial (${plural(cov.unresolvedLocal, 'unresolved local import')})`);
  out(c.dim(`  coverage: `) + covText + c.dim(` · index @${f.commit?.slice(0, 8)}${extra}`));
  staleNote(f);
}

// app/api/thumb/[id]/route.ts -> "/api/thumb": route groups (x) and slots @x are not in the URL; grep stops at the first [param]
const routeUrl = (p) => '/' + p.replace(/^(.*\/)?app\//, '').split('/').slice(0, -1)
  .filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith('@')).join('/').replace(/\/?\[.*$/, '');

// a path is never cut (the agent cites it or passes it on): one wider than its room goes whole on its own line under the row
function tableWhole(head, rows, col, opts = {}) {
  const max = opts.max || [];
  const widthOf = (i) => Math.max(...[head, ...rows].map((r) => Math.min(width(String(r[i] ?? '')), max[i] || Infinity)));
  const room = COLS - 2 - head.reduce((s, _, i) => (i === col ? s : s + widthOf(i) + 2), 0);
  const long = (v) => width(String(v)) > room;
  const lines = table(head, rows.map((r) => r.map((v, i) => (i === col && long(v) ? '↓' : v))),
    { ...opts, max: head.map((_, i) => (i === col ? 0 : max[i])) }).split('\n');
  rows.forEach((r, i) => { if (long(r[col])) lines[2 + i] += '\n    ' + r[col]; });
  return lines.join('\n');
}

function describe(n) {
  return `${c.bold(n.key)} ${c.dim(`(${n.kind}${n.exported ? ', exported' : ''}${n.flags ? ', ' + n.flags : ''})`)}`;
}

const cmds = {
  build({ pos, opt }) {
    const repo = resolve(pos[0] || opt.repo || '.');
    const dbPath = opt.db ? resolve(opt.db) : process.env.BRAIN_DB ? resolve(process.env.BRAIN_DB) : defaultDbPath(repo);
    const options = { includeRoots: opt['include-root'], noKnowledge: !!opt['no-knowledge'] };
    // --if-stale: keep an index of this repo, built with the same options, that still matches the checkout.
    // A vault always rebuilds: its notes are outside git, so nothing tells us they did not change
    if (opt['if-stale'] && existsSync(dbPath) && !opt.vault) {
      const db = openDb(dbPath), f = freshness(db, repo);
      db.close();
      if (f.state === 'fresh' && f.meta.repo === repo && !f.meta.vault && JSON.stringify(f.meta.options) === JSON.stringify(options)) {
        console.error(`brain build: index @${f.commit.slice(0, 8)} is fresh — skipped (drop --if-stale to rebuild)`);
        return opt.json && out(JSON.stringify({ db: dbPath, skipped: true, freshness: freshnessOf(f) }));
      }
    }
    const r = build({ repo, dbPath, vault: opt.vault, ...options, tilde });
    if (opt.json) out(JSON.stringify({ db: dbPath, skipped: false, ...r }));
  },

  status({ opt }) {
    const db = openDb(dbPathFor(opt));
    const f = freshness(db, checkout), m = f.meta, s = m.stats;
    const counts = Object.fromEntries(db.prepare(`SELECT CASE WHEN lang = 'md' THEN 'doc' ELSE kind END AS kind, count(*) n FROM nodes GROUP BY 1`).all().map((r) => [r.kind, r.n]));
    const edges = db.prepare('SELECT count(*) n FROM edges').get().n;
    const chunks = Object.fromEntries(db.prepare('SELECT source, count(*) n FROM chunks GROUP BY source').all().map((r) => [r.source, r.n]));
    const ageMin = Math.round((Date.now() - Date.parse(m.built_at)) / 60000);
    if (opt.json) return out(JSON.stringify({ ...f, counts, edges, chunks, ageMin, meta: undefined, stats: s, timings: m.timings }));
    out(`${c.bold('brain status')}  ${cutLeft(tilde(f.repo), COLS - 16)}`);
    out(table(['', ''], [
      ['index', `@${m.commit?.slice(0, 8)} (${m.commit_date}) · built ${ageMin} min ago in ${m.timings.total}s`],
      ['head', f.head ? `@${f.head.slice(0, 8)} · ${plural(f.changed.length, 'file')} changed since the index` : 'unknown (not a git repo?)'],
      ['map', `${plural(counts.file || 0, 'code file')} · ${plural(Object.entries(counts).filter(([k]) => !['file', 'dir', 'doc'].includes(k)).reduce((a, [, n]) => a + n, 0), 'symbol')} · ${plural(edges, 'edge')}`],
      ['programs', s.ts ? `${plural(s.ts.programs, 'TS program')} · ${s.ts.configs.map((x) => `${x.config} ${x.files.toLocaleString('en-US')} files`).join(' · ')} · ${s.ts.orphans} in no tsconfig (nearest config's options; list: --json orphanFiles) · typescript ${s.ts.version}` : '—'],
      ['memory', `${plural(counts.doc || 0, 'markdown file')} → ${Object.entries(chunks).map(([k, n]) => `${k} ${n}`).join(' · ')} chunks`
        + (s.knowledge?.unlinkedNames?.count ? ` · ${plural(s.knowledge.unlinkedNames.count, 'name')} with ${MAX_NAME_OWNERS + 1}+ exported owners not linked (${s.knowledge.unlinkedNames.examples.join(', ')}${s.knowledge.unlinkedNames.count > 5 ? ', …' : ''})` : '')],
      ['coverage', `${plural(m.coverage.unresolvedLocal, 'unresolved local import')}${s.ts ? ` · ${s.ts.unresolvedBuildOutput ?? 0} into build output (ignored) · ${s.ts.assetImports} asset imports (css/svg, not tracked) · ${s.ts.externalImports} package imports` : ''}`],
    ]));
    if (f.changed.length) out(c.yellow(`\n  ${plural(f.changed.length, 'file')} changed since the index: ${f.changed.slice(0, 8).join(', ')}${f.changed.length > 8 ? ', …' : ''}`));
  },

  find({ pos, opt }) {
    const db = openDb(dbPathFor(opt));
    const r = find(db, pos[0], { limit: +(opt.limit || 20), kind: opt.kind });
    if (opt.json) return out(JSON.stringify({ ...r, freshness: fresh(db), rows: r.rows.map((n) => ({ id: n.key, kind: n.kind, line: n.line, exported: !!n.exported, uses: n.uses })) }));
    // an ID is never cut (it is the next command's argument): one wider than the room goes on its own line under the row
    const head = ['ID', 'KIND', 'USES', 'LINE'];
    const rows = r.rows.map((n) => [n.key, n.kind + (n.exported || ['file', 'dir'].includes(n.kind) ? '' : ' (local)'), n.uses, n.line ?? '']);
    const room = COLS - [1, 2, 3].reduce((s, i) => s + 2 + Math.max(...[head, ...rows].map((x) => width(String(x[i])))), 2);
    const long = (id) => width(id) > room;
    const lines = table(head, rows.map((x) => (long(x[0]) ? ['↓', ...x.slice(1)] : x)), { align: ['l', 'l', 'r', 'r'] }).split('\n');
    rows.forEach((x, i) => { if (long(x[0])) lines[2 + i] += '\n  ' + x[0]; });
    out(lines.join('\n'));
    if (r.truncated) out(c.yellow(`  more matches — narrow the name or add --kind`));
    staleNote(fresh(db));
  },

  refs({ pos, opt }, mode = 'refs') {
    const db = openDb(dbPathFor(opt));
    const node = target(db, pos[0], opt);
    const kinds = mode === 'callers' ? ['call', 'new', 'renders'] : list(opt.kind);
    const r = refs(db, node, { kinds, filter: list(opt.filter), exclude: list(opt.exclude), includeImports: opt.imports,
      limit: opt.files ? 1e9 : +(opt.limit || 50), cursor: +(opt.cursor || 0) });
    const cov = coverageFor(db, { truncated: r.next !== null });
    const site = (x) => ({ kind: x.kind, site: `${x.path}:${x.line}:${x.col}`, in: x.in_kind === 'file' ? null : x.in_name, flags: x.flags || '' });
    // --files: one row per file (its first site, the site count, every kind), not one per site
    const perFile = () => [...Map.groupBy(r.rows, (x) => x.path).values()]
      .map((xs) => ({ ...site(xs[0]), kind: [...new Set(xs.map((x) => x.kind))].join(' '), sites: xs.length }));
    if (opt.json) return out(JSON.stringify({ target: node.key, kind: node.kind, total: r.total, files: r.files, next: r.next, coverage: cov, freshness: fresh(db),
      sites: opt.files ? perFile() : r.rows.map(site) }));
    const where = node.path && node.kind !== 'file' ? c.dim(`defined ${node.path}:${node.line}`) : '';
    const head = `${mode} ${describe(node)}`;
    out(where && width(head) + width(where) + 2 > COLS ? `${head}\n  ${where}` : `${head}${where ? '  ' + where : ''}`);
    if (opt.files || mode === 'callers') {
      const by = new Map();
      for (const x of r.rows) {
        const k = mode === 'callers' ? `${x.path}\0${x.in_kind === 'file' ? '(top level)' : x.in_name}` : x.path;
        const g = by.get(k) || { path: x.path, in: x.in_kind === 'file' ? '(top level)' : x.in_name, n: 0, kinds: new Map(), flags: x.flags, lines: [] };
        g.n++; g.kinds.set(x.kind, (g.kinds.get(x.kind) || 0) + 1); g.lines.push(x.line); by.set(k, g);
      }
      const rows = [...by.values()].map((g) => [g.path + c.dim(`:${g.lines.slice(0, 3).join(',')}`), ...(mode === 'callers' ? [g.in] : []), g.n,
        [...g.kinds].map(([k, n]) => (n > 1 ? `${k}×${n}` : k)).join(' '), g.flags || '']);
      out(tableWhole(['FILE', ...(mode === 'callers' ? ['CALLER'] : []), 'SITES', 'KINDS', 'ROLE'], rows, 0,
        { align: mode === 'callers' ? ['l', 'l', 'r'] : ['l', 'r'], max: [0, 34] }));
    } else {
      out(tableWhole(['KIND', 'SITE', 'IN', 'ROLE'], r.rows.map((x) => [x.kind, `${x.path}:${x.line}`, x.in_kind === 'file' ? c.dim('(top level)') : x.in_name, x.flags || '']), 1, { max: [0, 0, 32] }));
    }
    out(c.dim(`  ${plural(r.total, 'site')} in ${plural(r.files, 'file')}`) + (r.next !== null ? c.yellow(` · showing ${+(opt.cursor || 0) + 1}–${r.next} · next: --cursor ${r.next}`) : ''));
    footer(db, cov);
  },

  callers(args) { return cmds.refs(args, 'callers'); },

  impact({ pos, opt }) {
    const db = openDb(dbPathFor(opt));
    const node = target(db, pos[0], opt);
    const r = impact(db, node, { hops: +(opt.hops || 99), noTypes: opt['no-types'], noMocks: opt['no-mocks'] });
    const filter = list(opt.filter), exclude = list(opt.exclude);
    const keep = (p) => { const f = (r.flagsOf.get(p) || '').split(' '); return (!filter || filter.some((x) => f.includes(x))) && (!exclude || !exclude.some((x) => f.includes(x))); };
    const hops = r.hops.map((h) => ({ ...h, paths: h.paths.filter(keep) })).map((h) => ({ ...h, files: h.paths.length, tests: h.paths.filter((p) => r.flagsOf.get(p).includes('test')).length })).filter((h) => h.files);
    const total = hops.reduce((a, h) => a + h.files, 0), tests = hops.reduce((a, h) => a + h.tests, 0);
    const cov = coverageFor(db, { truncated: false });
    // a route handler is reached by its URL, not by an import: with no importers, say what to grep instead
    const hint = total === 0 && node.kind === 'file' && node.flags.split(' ').includes('route')
      ? `reached by URL, not imports — grep "${routeUrl(node.path)}" (fetch calls, links, config)` : undefined;
    if (opt.json) return out(JSON.stringify({ target: node.key, kind: node.kind, total, tests, coverage: cov, freshness: fresh(db), hint,
      hops: hops.map((h) => ({ hop: h.hop, files: h.files, tests: h.tests, paths: h.paths })) }));
    const level = node.kind === 'file' || node.kind === 'dir' ? 'file level · import edges' : 'symbol level · use edges';
    out(`impact ${describe(node)}  ${c.dim(level)}${filter ? c.dim(` · only ${filter.join(',')}`) : ''}${exclude ? c.dim(` · without ${exclude.join(',')}`) : ''}`);
    let cum = 0;
    out(table(['HOP', 'FILES', 'TESTS', 'CUMULATIVE', 'EXAMPLES'], hops.map((h) => {
      cum += h.files;
      return [h.hop === 1 ? '1 (direct)' : h.hop, h.files, h.tests, cum, h.paths.filter((p) => !r.flagsOf.get(p).includes('test')).slice(0, 2).map((p) => p.split('/').slice(-2).join('/')).join(', ')];
    }), { align: ['l', 'r', 'r', 'r'], max: [0, 0, 0, 0, 60] }));
    // the deepest hop, not the row count: --filter drops hops with no match (hop 8 empty, hop 9 kept = 9 hops)
    out(c.bold(`  total: ${plural(total, 'file')} may be affected (${tests} tests)`) + c.dim(` · ${hops.at(-1)?.hop ?? 0} hops`));
    if (hint) out(c.yellow(`  ${hint}`));
    if (opt.list) for (const h of hops) for (const p of h.paths) out(`  ${h.hop}\t${p}`);
    footer(db, cov);
  },

  deps({ pos, opt }) {
    const db = openDb(dbPathFor(opt));
    const node = target(db, pos[0], opt);
    const r = deps(db, node, { hops: +(opt.hops || 99), noTypes: opt['no-types'] });
    const rows = [...r.hopOf].filter(([, h]) => h > 0).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
    if (opt.json) return out(JSON.stringify({ target: node.key, from: node.path, total: rows.length, coverage: coverageFor(db, { truncated: false }), freshness: fresh(db), files: rows.map(([p, h]) => ({ path: p, hop: h })) }));
    out(`deps ${describe(node)}: ${plural(rows.length, 'file')} pulled in`);
    if (!['file', 'dir'].includes(node.kind)) out(c.dim(`  file level: what ${node.path} (where ${node.name} is defined) pulls in`));
    if (opt.list) for (const [p, h] of rows) out(`  ${h}\t${p}`);
    else out(table(['HOP', 'FILES'], Object.entries(rows.reduce((a, [, h]) => ({ ...a, [h]: (a[h] || 0) + 1 }), {})), { align: ['l', 'r'] }));
    footer(db, coverageFor(db, { truncated: false }));
  },

  shared({ pos, opt }) {
    const db = openDb(dbPathFor(opt));
    const a = target(db, pos[0], opt), b = target(db, pos[1], opt);
    const r = shared(db, a, b, { noTypes: opt['no-types'] });
    const byTop = r.both.reduce((m, p) => m.set(p.split('/').slice(0, 2).join('/'), (m.get(p.split('/').slice(0, 2).join('/')) || 0) + 1), new Map());
    if (opt.json) return out(JSON.stringify({ a: a.key, b: b.key, total: r.both.length, coverage: coverageFor(db, { truncated: false }), freshness: fresh(db), files: r.both }));
    out(`shared ${describe(a)} ∩ ${describe(b)}`);
    out(c.dim(`  ${a.path} pulls in ${r.a} files · ${b.path} pulls in ${r.b} · both: `) + c.bold(r.both.length));
    out(table(['AREA', 'FILES'], [...byTop].sort((x, y) => y[1] - x[1]).slice(0, opt.list ? 1e9 : 12), { align: ['l', 'r'] }));
    if (opt.list) for (const p of r.both) out(`  ${p}`);
    footer(db, coverageFor(db, { truncated: false }));
  },

  why({ pos, opt }) {
    const db = openDb(dbPathFor(opt));
    const t0 = performance.now();
    const r = why(db, pos.join(' '), { limit: +(opt.limit || 8) });
    const ms = Math.round(performance.now() - t0);
    const f = freshness(db, checkout);
    markMentions(f.repo, r);
    if (opt.json) return out(JSON.stringify({ ...r, ms, freshness: freshnessOf(f) }));
    out(`why ${c.bold(`"${cut(r.question, COLS - 36)}"`)}  ${c.dim(`FAST · no LLM · ${ms} ms`)}`);
    if (r.seeds.length) out(c.dim(`  names → code: ${r.seeds.join(', ')}`));
    if (r.gap) {
      out(c.yellow(`  no doc, change note or commit mentions ${r.terms.names.join(', ') || 'these terms'} — a knowledge gap.`));
      out(c.dim('  read the code itself (the header / the definition), and consider writing the doc'));
      return staleNote(freshnessOf(f));
    }
    // a cite is never cut. Under 120 columns SOURCE and DATE go (the cite's shape says commit / changes/ / doc).
    // A cite wider than 40% of the screen goes on its own line under the row, so TITLE keeps its room
    const wide = COLS >= 120;
    const cols = wide ? ['#', 'SOURCE', 'CITE', 'DATE', 'PR', 'TITLE'] : ['#', 'CITE', 'PR', 'TITLE'];
    const long = (x) => width(x.cite) > Math.floor(COLS * 0.4);
    const cell = (x, i) => ({ '#': i + 1, SOURCE: x.source, CITE: long(x) ? '↓' : x.cite, DATE: x.date || '', PR: x.prs.split(' ').slice(0, wide ? 2 : 1).join(' '), TITLE: x.title });
    const lines = table(cols, r.citations.map((x, i) => cols.map((k) => cell(x, i)[k])), { align: ['r'] }).split('\n');
    const at = 2 + String(r.citations.length).length + 2 + (wide ? Math.max(6, ...r.citations.map((x) => width(x.source))) + 2 : 0);
    r.citations.forEach((x, i) => { if (long(x)) lines[2 + i] += '\n' + ' '.repeat(at) + x.cite; });
    out(lines.join('\n'));
    for (const [i, x] of r.citations.slice(0, 3).entries()) out(c.dim(`  ${i + 1}. `) + cut(x.snippet, COLS - 6));
    // a citation's text can name a build ID or a file that is gone: say so, so neither is cited as evidence
    for (const [i, x] of r.citations.entries()) {
      if (x.inTree === false) out(c.yellow(`  #${i + 1} ${x.cite}: the cited file is not in the tree now — cite the commit that removed it`));
      const bad = [...x.notCommits.map((s) => `${s} (not a commit)`), ...x.notInTree.map((p) => `${p} (not in the tree)`)];
      if (bad.length) out(c.yellow(`  #${i + 1} mentions ${bad.slice(0, 4).join(', ')}${bad.length > 4 ? `, +${bad.length - 4} more` : ''} — do not cite these`));
    }
    if (r.related.length) out(cut(c.dim('  related code (1 hop): ') + r.related.slice(0, 6).map((x) => `${x.path} ×${x.citations}`).join(' · '), COLS));
    for (const h of r.history.filter((h) => h.commits.length)) out(c.dim(`  history of ${h.seed}: `) + h.commits.map((x) => `${x.sha.slice(0, 8)} ${x.prs.split(' ')[0] || ''}`.trim()).join(' · '));
    out(c.dim('  read the cited lines before you answer; cite path:line or SHA'));
    staleNote(freshnessOf(f));
  },

  viz({ pos, opt }) {
    const db = openDb(dbPathFor(opt));
    const node = target(db, pos[0], opt);
    const file = viz(db, node, { out: opt.out, hops: +(opt.hops || 2), question: opt.why, max: +(opt.max || 260) });
    out(tilde(file));
    if (opt.open) execFileSync('open', [file]);
  },
};

process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e; });   // `brain … | head`
const { pos, opt } = parse(process.argv.slice(2));
const cmd = pos.shift();
if (!cmd || opt.help || !cmds[cmd]) { out(HELP); process.exit(cmd && !opt.help ? 1 : 0); }
if (cmd !== 'build') checkout = here(opt);
try { cmds[cmd]({ pos, opt }); }
catch (e) {
  if (opt.json) out(JSON.stringify({ error: e.message }));
  else out(`${c.red('brain error')}: ${e.message}\n  fail open: continue with grep / your normal tools`);
  process.exit(1);
}
