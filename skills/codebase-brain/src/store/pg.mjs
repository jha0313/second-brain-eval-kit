// Postgres store (server mode, design §6.4): schema brain, read as brain_reader. Lane C owns this file.
// - Every method is ONE SQL statement. Its CTE `v` picks the run (opts.asOf, else the newest) and the statement returns
//   that run as `view` with the rows, so a result never mixes runs. A command passes the first view.run as asOf to its
//   later calls (V16): a run's visible rows never change once it commits, so a later statement at R reads the same data.
// - Visible at run R: valid_from <= R AND (valid_to IS NULL OR valid_to > R); chunks and refs follow their revision.
// - Rows keep the Phase 1 SQLite shapes (code.db chunks, github.db items / refs rows, as the mirror writes them) and
//   the mirror's ids ('c' + chunk_id, 'g' + item_id), so read.mjs shapes both stores alike and ties break as on a mirror
//   of the same run. The lists follow src/store/sqlite.mjs one by one; FTS is chunk.tsv (simple over brain.fts_text:
//   tokens and stems as FTS5's, sql/003) ranked by ts_rank instead of FTS5 bm25, and the trigram lists are ILIKE
//   for every length: a term of 3+ characters one list part each (the pg_trgm indexes when it has a trigram and the
//   planner takes them), a shorter one (never a trigram) in one shared scan (tr in candidates).
// - Search payload (§6.9): candidates with top ranks the lists in SQL and returns only the shown groups.
// - Repo memory pointers: <source>:<path>:<a>-<b>@r<n> (rev n of item <source>:<path>). A Phase 1 @<build> pointer
//   reads the view run when its build is that run's build, else it is stale. Vault notes are never on the server.
import { BrainError, NotFoundError, StalePtrError } from '../errors.mjs';
import { parseRevPtr, formatPtr, formatRevPtr, GH_TYPES, MEMORY_TYPES } from '../ptr.mjs';
import { ITEM_META_COLUMNS } from '../pg/contract.mjs';
import { MAX_NAME_OWNERS } from '../index-knowledge.mjs';
import { CAP, RRF_K, filterOf, termsOf } from './common.mjs';

const R = '(SELECT run_id FROM v)';
const vis = (t, run = R) => `(${t}.valid_from <= ${run} AND (${t}.valid_to IS NULL OR ${t}.valid_to > ${run}))`;
const BYTES = 'COLLATE "C"';                       // text order as SQLite compares it (dates, paths)
const likeOf = (s) => `%${String(s).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
// sync_state refs.other key of a ref (contract.githubSyncState: canonicalJson([ptr, kind, target, origin]))
// (parenthesized: ? ->> and || are all "other" operators of one precedence, left-associative)
const REF_KEY = (i, f) => `('[' || to_json(${i}.ptr)::text || ',' || to_json(${f}.kind)::text || ',' || to_json(${f}.target)::text || ',' || to_json(${f}.origin)::text || ']')`;
// resolved_build of a ref from a run's sync_state refs ({ build, other })
const BUILD_OF = (refs, i, f) => `CASE WHEN ${refs}->'other' ? ${REF_KEY(i, f)} THEN ${refs}->'other'->>${REF_KEY(i, f)} ELSE ${refs}->>'build' END`;
// Phase 1 refs.resolved (text) as rows (val, n); anything but a JSON array is no entries
const RAW_LIST = (col) => `jsonb_array_elements_text(CASE WHEN ${col} IS JSON ARRAY THEN ${col}::jsonb ELSE '[]'::jsonb END) WITH ORDINALITY`;

function statement() {
  const params = [];
  return { params, p: (v) => { params.push(v); return `$${params.length}`; } };
}
// v: the run; s: its GitHub sync_state (no row: the run has no GitHub state). refs is taken out once: state is a
// large toasted jsonb, and rl reads refs for every ref row (Q9: decompressed per row, most of a search's time)
const head = (runSql) => `v AS (SELECT run_id, commit_sha, published_at, sanitize_version, meta->>'build_id' AS build FROM brain.run WHERE run_id = ${runSql}),
  s AS MATERIALIZED (SELECT st.state, st.state->'refs' AS refs FROM brain.sync_state st JOIN v USING (run_id) WHERE st.source = 'github')`;
const atRun = (p, asOf) => `coalesce(${p(asOf ?? null)}::bigint, (SELECT max(run_id) FROM brain.run))`;
const VIEW = `(SELECT to_jsonb(v) FROM v) AS v, (SELECT state->'row' FROM s) AS sync`;

const iso = (t) => (t == null ? null : new Date(t).toISOString());
const noRun = (asOf) => () => (asOf == null ? new BrainError('not-found', 'the server has no published run yet') : new NotFoundError(`run:${asOf}`));
/** @returns {import('../pg/contract.mjs').View} */
function viewOf(r, missing) {
  if (!r?.v) throw missing();
  // the github.db sync_state row as context.mjs reads it (gh-schema readSyncState: limits parsed)
  const sync = r.sync ? { ...r.sync, limits: r.sync.limits ? JSON.parse(r.sync.limits) : {} } : null;
  return { run: Number(r.v.run_id), runCommit: r.v.commit_sha, publishedAt: iso(r.v.published_at), sync,
    codeSanitizeVersion: r.v.sanitize_version ?? null, githubSanitizeVersion: sync?.sanitize_version ?? null };
}

// ---------- rows in the SQLite shapes ----------

// a GitHub item revision as a github.db items row (+ rev, parentPtr); i: brain.item, r: brain.item_rev, s: the ledger
const PARENT = (i, r) => `CASE WHEN ${i}.kind IN ('pr', 'issue') THEN NULL ELSE (SELECT pi.ptr FROM brain.item pi JOIN brain.item_rev px ON px.item_id = pi.item_id
  WHERE pi.ptr IN ('pr:' || (${r}.meta->>'parent_number'), 'issue:' || (${r}.meta->>'parent_number')) AND ${vis('px')} ORDER BY pi.kind = 'pr' DESC LIMIT 1) END`;
const ITEM = (i, r, parent = true) => `(coalesce(${r}.meta, '{}'::jsonb) || jsonb_build_object('id', ${i}.item_id, 'ptr', ${i}.ptr, 'kind', ${i}.kind,
  'title', ${r}.title, 'body', ${r}.body, 'state', ${r}.state, 'author', ${r}.author, 'updated_at', ${r}.source_updated_at, 'rev', ${r}.rev_no,
  'detail_for', (SELECT state->'items'->${i}.ptr->'detail_for' FROM s), 'reviews_at', (SELECT state->'items'->${i}.ptr->'reviews_at' FROM s)
  ${parent ? `, 'parentPtr', ${PARENT(i, r)}` : ''}))`;
// a repo chunk as a code.db chunks row (+ rev)
const CHUNK = (c, i, r) => `jsonb_build_object('id', ${c}.chunk_id, 'source', ${i}.kind,
  'path', CASE WHEN ${i}.kind = 'commit' THEN NULL ELSE substr(${i}.ptr, length(${i}.kind) + 2) END, 'start_line', ${c}.start_line,
  'end_line', ${c}.end_line, 'title', ${c}.title, 'body', ${c}.body, 'sha', ${c}.sha, 'date', ${c}.date, 'prs', ${c}.prs,
  'body_line', ${c}.body_line, 'rev', ${r}.rev_no)`;

const CHUNK_COLS = ['id', 'source', 'path', 'start_line', 'end_line', 'title', 'body', 'sha', 'date', 'prs', 'body_line'];
const ITEM_COLS = ['id', 'ptr', 'kind', 'title', 'body', 'state', 'author', 'updated_at', ...ITEM_META_COLUMNS, 'detail_for', 'reviews_at'];
const pick = (j, cols) => Object.fromEntries(cols.map((c) => [c, j[c] ?? null]));
function chunkRow(j) {
  const c = pick(j, CHUNK_COLS);
  const ptr = c.source === 'commit' ? `commit:${String(c.sha).slice(0, 8)}`
    : formatRevPtr({ type: c.source, path: c.path, a: c.start_line, b: c.end_line, rev: j.rev });
  return { ...c, key: `c${c.id}`, ptr, rev: j.rev, origin: 'repo', parentPtr: null };
}
const itemRow = (j) => ({ ...pick(j, ITEM_COLS), key: `g${j.id}`, rev: j.rev, origin: 'github', parentPtr: j.parentPtr ?? null });
const revsOf = (revs) => (revs ?? []).map((x) => ({ rev: x.rev, run: Number(x.run), publishedAt: iso(x.publishedAt), state: x.state ?? null }));

// ---------- candidates: the lists of sqlite.mjs, in one statement ----------

// resolveTarget (query.mjs) cascade over the nodes visible at R, for one name: what JS can compute from the name alone
function seedSpec(q) {
  const m = /^(.+?)[#:]([\w$.]+)$/.exec(q);
  const sym = m && !/\.\w+$/.test(q);
  return { q, k: q.replace(':', '#'), m1: sym ? m[1] : null, last: sym ? m[2].split('.').pop() : null, dir: q.replace(/\/+$/, ''),
    ispath: q.includes('/') || /\.\w+$/.test(q), tail: q.replace(/^\/+/, '') };
}
// per name: the first step of resolveTarget that hits; seedNodes keeps one node, or at most MAX_NAME_OWNERS candidates.
// SQLite LIKE is case-insensitive and has no escape character: ILIKE ... ESCAPE ''
const HIT = `SELECT h.* FROM sq CROSS JOIN LATERAL (
  WITH s1 AS (SELECT id, key, kind, path FROM nv WHERE key = sq.k LIMIT 1),
  s2 AS (SELECT id, key, kind, path FROM nv WHERE sq.last IS NOT NULL AND kind <> 'file' AND name = sq.last AND (path = sq.m1 OR path ILIKE '%' || sq.m1 ESCAPE '')),
  s3 AS (SELECT coalesce((SELECT id FROM nv WHERE key = 'dir:' || sq.dir), -1) AS id, 'dir:' || sq.dir AS key, 'dir' AS kind, sq.dir AS path
    WHERE EXISTS (SELECT 1 FROM nv WHERE kind = 'file' AND path ILIKE sq.dir || '/%' ESCAPE '')),
  s4 AS (SELECT id, key, kind, path, row_number() OVER (ORDER BY length(path), id) AS o, count(*) OVER () AS n FROM nv
    WHERE sq.ispath AND kind IN ('file', 'dir') AND (path = sq.q OR path ILIKE '%/' || sq.tail ESCAPE '')),
  s5 AS (SELECT id, key, kind, path, exported, count(*) OVER () AS n, count(*) FILTER (WHERE exported) OVER () AS ne FROM nv
    WHERE name = sq.q AND kind NOT IN ('file', 'dir')),
  st AS (SELECT CASE WHEN EXISTS (SELECT 1 FROM s1) THEN 1 WHEN EXISTS (SELECT 1 FROM s2) THEN 2 WHEN EXISTS (SELECT 1 FROM s3) THEN 3
    WHEN EXISTS (SELECT 1 FROM s4) THEN 4 ELSE 5 END AS step)
  SELECT id, key, kind, path FROM s1 WHERE (SELECT step FROM st) = 1
  UNION ALL SELECT id, key, kind, path FROM s2 WHERE (SELECT step FROM st) = 2 AND (SELECT count(*) FROM s2) <= ${MAX_NAME_OWNERS}
  UNION ALL SELECT id, key, kind, path FROM s3 WHERE (SELECT step FROM st) = 3
  UNION ALL SELECT id, key, kind, path FROM s4 WHERE (SELECT step FROM st) = 4 AND CASE
    WHEN n = 1 OR EXISTS (SELECT 1 FROM s4 x WHERE x.o = 1 AND x.path = sq.q) THEN o = 1 ELSE n <= ${MAX_NAME_OWNERS} END
  UNION ALL SELECT id, key, kind, path FROM s5 WHERE (SELECT step FROM st) = 5 AND CASE
    WHEN n = 1 THEN true WHEN ne = 1 THEN exported ELSE n <= ${MAX_NAME_OWNERS} END) h`;

async function candidates(client, q, opts = {}) {
  const t = termsOf(q), f = filterOf(opts);
  const { params, p } = statement();
  const ctes = [head(atRun(p, opts.asOf))], lists = [], names = [];
  const add = (name, select, order) => {
    const c = `l${lists.length}`;
    ctes.push(`${c} AS (SELECT x.*, row_number() OVER (ORDER BY ${order}) AS o FROM (${select}) x ORDER BY o LIMIT ${CAP + 1})`);
    lists.push(`(SELECT jsonb_build_object('name', '${name}', 'rows', coalesce(jsonb_agg(jsonb_build_array(key, grp, d, ptr, flags) ORDER BY o), '[]'::jsonb)) FROM ${c})`);
    names.push(name);
  };
  // each term through brain.fts_text as the indexed text (sql/003), then "t1" OR "t2" …; terms are [A-Za-z0-9_] only.
  // Made once (MATERIALIZED): the lists read it as tq
  const tsq = t.ascii.length > 0;
  if (tsq) ctes.push(`tq AS MATERIALIZED (SELECT websearch_to_tsquery('simple', (SELECT string_agg('"' || brain.fts_text(w) || '"', ' OR ') FROM unnest(${p(t.ascii)}::text[]) w)) AS q)`);
  const P = f.path ? p(f.path) : null;
  const under = (x) => `(${x} = ${P} OR starts_with(${x}, ${P} || '/'))`;
  const seeded = t.names.length > 0;
  if (seeded) {
    ctes.push(`nv AS (SELECT n.node_id AS id, r.p0_key AS key, r.kind, r.name, n.path, r.exported FROM brain.node_rev r JOIN brain.node n USING (node_id) WHERE ${vis('r')})`,
      `sq AS (SELECT * FROM jsonb_to_recordset(${p(JSON.stringify(t.names.map(seedSpec)))}::jsonb) AS x(q text, k text, m1 text, last text, dir text, ispath boolean, tail text))`,
      `hit AS (${HIT})`,
      // seedNodes: each hit, plus the file of a hit that is not a file
      `seeds AS (SELECT id, key, kind FROM hit UNION SELECT nv.id, nv.key, nv.kind FROM hit JOIN nv ON nv.key = hit.path WHERE hit.kind <> 'file')`);
  }

  // a trigram term under 3 characters never has a trigram, so each one was a scan of brain.chunk, twice (items and
  // chunks; Q9: ~46 ms a scan). Those terms are matched in one scan instead, each title and body lowercased once: in a
  // UTF-8 database ILIKE is lower() LIKE lower(), so every list is the same. th / hit: the terms (1-based) a chunk's
  // title matches / its title or body matches
  const short = t.tri.filter((s) => [...s].length < 3);
  const shortNo = (s) => short.indexOf(s) + 1;
  if (short.length && (f.ghKinds.length || f.sources.length)) {
    ctes.push(`lp AS MATERIALIZED (SELECT n::int AS n, lower(x) AS p FROM unnest(${p(short.map(likeOf))}::text[]) WITH ORDINALITY u(x, n))`,
      `tr AS MATERIALIZED (SELECT x.chunk_id, x.rev_id, x.ord, ARRAY(SELECT lp.n FROM lp WHERE x.lt LIKE lp.p) AS th,
          ARRAY(SELECT lp.n FROM lp WHERE x.lt LIKE lp.p OR x.lb LIKE lp.p) AS hit
        FROM (SELECT chunk_id, rev_id, ord, lower(title) AS lt, lower(body) AS lb FROM brain.chunk OFFSET 0) x
        WHERE x.lt LIKE ANY(ARRAY(SELECT p FROM lp)) OR x.lb LIKE ANY(ARRAY(SELECT p FROM lp)))`);
  }

  let pending = '0';
  if (f.ghKinds.length) {
    ctes.push(`gi AS (SELECT i.item_id AS id, i.ptr, i.kind, r.rev_id, r.state, r.author, r.source_updated_at AS updated_at, r.meta
      FROM brain.item_rev r JOIN brain.item i USING (item_id) WHERE i.origin = 'github' AND ${vis('r')})`);
    if (seeded || f.path) {
      // refs at R with their ref_link; cur: resolved against this run's build (else pending until the next relink)
      ctes.push(`rl AS (SELECT gi.ptr, f.kind, f.target, l.status, l.reason, l.resolved_raw, coalesce(${BUILD_OF('s.refs', 'gi', 'f')} = v.build, false) AS cur
        FROM gi JOIN brain.ref f ON f.rev_id = gi.rev_id LEFT JOIN brain.ref_link l ON l.ref_id = f.ref_id AND ${vis('l')} CROSS JOIN v CROSS JOIN s)`);
    }
    if (f.path) {   // sqlite.mjs pathRefs
      ctes.push(`pr AS (SELECT ptr, resolved_raw,
          kind IN ('file', 'dir') AND ${under("regexp_replace(regexp_replace(target, '^[.]/', ''), '/+$', '')")} AS hit,
          coalesce(status, 'pending') = 'pending' OR NOT cur OR (status = 'ambiguous' AND reason IS NOT DISTINCT FROM 'budget') AS waits
        FROM rl WHERE kind IN ('file', 'dir', 'symbol', 'route', 'name'))`,
      `ph AS (SELECT ptr FROM pr WHERE hit UNION SELECT ptr FROM pr WHERE NOT hit AND NOT waits AND EXISTS (SELECT 1 FROM ${RAW_LIST('pr.resolved_raw')} e(val, n)
        WHERE e.n <= 10 AND ${under("regexp_replace(regexp_replace(e.val, '#.*$', ''), ':[0-9]+$', '')")}))`);
      pending = '(SELECT count(*) FROM pr WHERE NOT hit AND waits)';
    }
    const w = [`i.kind = ANY(${p(f.ghKinds)}::text[])`];
    if (f.states) w.push(`p.state = ANY(${p(f.states)}::text[])`);
    if (f.author) w.push(`lower(i.author) = ${p(f.author)}`);
    if (f.since) w.push(`coalesce(i.updated_at, i.meta->>'submitted_at', i.meta->>'created_at') >= ${p(f.since)} ${BYTES}`);
    if (f.path) w.push(`(i.ptr IN (SELECT ptr FROM ph) OR p.ptr IN (SELECT ptr FROM ph) OR ${under("i.meta->>'path'")})`);
    // a review / comment matches as itself but ranks as its PR (else issue) p; d: the date of p
    ctes.push(`g AS (SELECT i.id, i.ptr, i.rev_id, i.meta->>'flags' AS flags, i.meta->>'merge_sha' AS merge_sha, p.id AS gid,
        coalesce(p.meta->>'merged_at', p.meta->>'closed_at', p.updated_at, p.meta->>'created_at') AS d
      FROM gi i
      LEFT JOIN gi a ON i.kind NOT IN ('pr', 'issue') AND a.ptr = 'pr:' || (i.meta->>'parent_number')
      LEFT JOIN gi b ON i.kind NOT IN ('pr', 'issue') AND b.ptr = 'issue:' || (i.meta->>'parent_number')
      JOIN gi p ON p.id = CASE WHEN i.kind IN ('pr', 'issue') THEN i.id ELSE coalesce(a.id, b.id) END
      WHERE ${w.join(' AND ')})`);
    const G = (extra = '', from = '') => `SELECT g.id, 'g' || g.id AS key, 'g' || g.gid AS grp, g.d, g.ptr, g.flags${extra} FROM g${from}`;
    const text = ' JOIN brain.chunk c ON c.rev_id = g.rev_id AND c.ord = 0';   // the item's search chunk (title + body)
    if (tsq) add('items_fts', `${G(', ts_rank(c.tsv, w.q) AS sc', `${text} CROSS JOIN tq w`)} WHERE c.tsv @@ w.q`, 'sc DESC, id');
    for (const s of t.tri) {
      const k = shortNo(s), L = k ? null : p(likeOf(s));
      add('items_tri', k ? `${G(`, ${k} = ANY(tr.th) AS th`, ' JOIN tr ON tr.rev_id = g.rev_id AND tr.ord = 0')} WHERE ${k} = ANY(tr.hit)`
        : `${G(`, coalesce(c.title ILIKE ${L}, false) AS th`, text)} WHERE (c.title ILIKE ${L} OR c.body ILIKE ${L})`, `th DESC, d ${BYTES} DESC NULLS LAST, id`);
    }
    const nums = t.prs.flatMap((n) => [`pr:${n.slice(1)}`, `issue:${n.slice(1)}`]);
    if (nums.length) add('items_keys', `${G()} WHERE g.ptr = ANY(${p(nums)}::text[])`, 'id');
    for (const sha of t.shas) add('items_keys', `${G()} WHERE g.merge_sha LIKE ${p(`${sha}%`)}`, 'id');
    if (seeded) {   // refs resolved in this build to a seed: a node key, or path:line inside a seed file
      ctes.push(`sp AS (SELECT DISTINCT rl.ptr FROM rl CROSS JOIN LATERAL ${RAW_LIST('rl.resolved_raw')} j(val, n)
        WHERE rl.cur AND rl.status IN ('linked', 'ambiguous')
          AND (j.val IN (SELECT key FROM seeds) OR split_part(j.val, ':', 1) IN (SELECT key FROM seeds WHERE kind = 'file')))`);
      add('items_links', `${G()} WHERE g.ptr IN (SELECT ptr FROM sp)`, `d ${BYTES} DESC NULLS LAST, id`);
    }
  }

  if (f.sources.length) {
    const w = [`i.kind = ANY(${p(f.sources)}::text[])`];          // vault is never on the server: it matches no item
    if (f.since) w.push(`c.date >= ${p(f.since)} ${BYTES}`);
    if (f.path) {   // the chunk's own file, or code it links to
      w.push(`(${under("CASE WHEN i.kind = 'commit' THEN NULL ELSE substr(i.ptr, length(i.kind) + 2) END")} OR EXISTS (SELECT 1 FROM brain.link l
        JOIN brain.node n ON n.node_id = l.node_id WHERE l.chunk_id = c.chunk_id AND ${vis('l')} AND ${under('n.path')}))`);
    }
    ctes.push(`ch AS NOT MATERIALIZED (SELECT c.chunk_id AS id, 'c' || c.chunk_id AS key, 'c' || c.chunk_id AS grp, c.date AS d, NULL::text AS ptr,
        NULL::text AS flags, c.tsv, c.title, c.body, c.prs, c.sha
      FROM brain.item_rev r JOIN brain.item i USING (item_id) JOIN brain.chunk c USING (rev_id) WHERE i.origin = 'repo' AND ${vis('r')} AND ${w.join(' AND ')})`);
    const K = 'SELECT id, key, grp, d, ptr, flags';
    if (tsq) add('chunks_fts', `${K}, ts_rank(tsv, w.q) AS sc FROM ch CROSS JOIN tq w WHERE tsv @@ w.q`, 'sc DESC, id');
    for (const s of t.tri) {
      const k = shortNo(s), L = k ? null : p(likeOf(s));
      add('chunks_tri', k ? `${K}, ${k} = ANY(tr.th) AS th FROM ch JOIN tr ON tr.chunk_id = ch.id WHERE ${k} = ANY(tr.hit)`
        : `${K}, coalesce(title ILIKE ${L}, false) AS th FROM ch WHERE title ILIKE ${L} OR body ILIKE ${L}`, `th DESC, d ${BYTES} DESC NULLS LAST, id`);
    }
    for (const n of t.prs) add('chunks_keys', `${K} FROM ch WHERE (' ' || prs || ' ') LIKE ${p(`% ${n} %`)}`, 'id');
    for (const sha of t.shas) add('chunks_keys', `${K} FROM ch WHERE sha LIKE ${p(`${sha}%`)}`, 'id');
    if (seeded) {
      add('chunks_links', `${K} FROM ch WHERE id IN (SELECT l.chunk_id FROM brain.link l WHERE ${vis('l')} AND l.node_id IN (SELECT id FROM seeds))`,
        `d ${BYTES} DESC NULLS LAST, id`);
    }
  }

  // top { cursor, limit } (read.mjs searchIn): the lists are ranked here as read.mjs rank() ranks them, and only the
  // shown groups leave the server (§6.9). A key scores 1 / (RRF_K + o) in each list, summed in list order (the same
  // float8 additions as rank()), and keeps the grp / d / ptr / flags of its first list; a group scores as its best key
  // and takes the d of its first key. Keys are ASCII, and so is d as the kit writes it (an ISO date or null), where byte
  // order is JS string order; a group with any other d gets the lists instead (JS compares UTF-16 code units). kids: the
  // group's best three other keys (rank() kids). The page end is added in JS (cursor + limit may be Infinity there)
  const all = `jsonb_build_array(${lists.join(', ')})`;
  let out = `${all} AS lists`;
  if (opts.top && !names.length) out = `'{"shown": [], "total": 0, "groups": 0, "truncated": []}'::jsonb AS ranked`;
  else if (opts.top) {
    ctes.push(`c AS (${names.map((_, n) => `SELECT ${n} AS n, key, grp, d, ptr, flags, o FROM l${n} WHERE o <= ${CAP}`).join(' UNION ALL ')})`,
      `fu AS (SELECT key, (array_agg(grp ORDER BY n, o))[1] AS grp, (array_agg(d ORDER BY n, o))[1] AS d, (array_agg(ptr ORDER BY n, o))[1] AS ptr,
          (array_agg(flags ORDER BY n, o))[1] AS flags, sum(1::float8 / (${RRF_K} + o)::float8 ORDER BY n, o) AS score, min(n * ${CAP + 2} + o) AS first
        FROM c GROUP BY key)`,
      `gr AS (SELECT grp AS key, max(score) AS score, (array_agg(d ORDER BY first))[1] AS d FROM fu GROUP BY grp)`,
      `od AS (SELECT key, d, row_number() OVER (ORDER BY score DESC, coalesce(d, '') ${BYTES} DESC, key ${BYTES}) AS rn FROM gr)`);
    const from = p(opts.top.cursor), to = p(opts.top.cursor + opts.top.limit);
    const ascii = `NOT EXISTS (SELECT 1 FROM gr WHERE octet_length(d) <> char_length(d))`;
    out = `CASE WHEN ${ascii} THEN jsonb_build_object('total', (SELECT count(*) FROM fu), 'groups', (SELECT count(*) FROM gr),
        'truncated', jsonb_build_array(${names.map((_, n) => `(SELECT count(*) > ${CAP} FROM l${n})`).join(', ')}),
        'shown', (SELECT coalesce(jsonb_agg(jsonb_build_array(od.key, od.d, (SELECT coalesce(jsonb_agg(jsonb_build_array(k.ptr, k.flags) ORDER BY k.score DESC, k.key ${BYTES}), '[]'::jsonb)
            FROM (SELECT ptr, flags, score, key FROM fu WHERE fu.grp = od.key AND fu.key <> fu.grp ORDER BY score DESC, key ${BYTES} LIMIT 3) k)) ORDER BY od.rn), '[]'::jsonb)
          FROM od WHERE od.rn > ${from}::float8 AND od.rn <= ${to}::float8)) END AS ranked,
      CASE WHEN NOT ${ascii} THEN ${all} END AS lists`;
  }
  const sql = `WITH ${ctes.join(',\n')}
    SELECT ${VIEW}, ${pending} AS pending,
      CASE WHEN EXISTS (SELECT 1 FROM s) THEN (SELECT count(*) FROM brain.item_rev r JOIN brain.item i USING (item_id)
        WHERE i.kind = 'pr' AND ${vis('r')} AND (' ' || (r.meta->>'flags') || ' ') LIKE '% files-truncated %') ELSE 0 END AS files_truncated,
      ${out}`;
  const r = (await client.query(sql, params)).rows[0];
  const view = viewOf(r, noRun(opts.asOf));
  const facts = { pathRefsPending: Number(r.pending), filesTruncated: Number(r.files_truncated), githubPresent: view.sync !== null };
  if (r.ranked) {
    const k = r.ranked;
    return { ranked: { shown: k.shown.map(([key, d, kids]) => ({ key, d, kids: kids.map(([ptr, flags]) => ({ ptr, flags })) })), total: k.total,
      groups: k.groups, truncated: names.filter((_, n) => k.truncated[n]) }, facts, view };
  }
  return {
    lists: r.lists.map((l) => ({ name: l.name, rows: l.rows.slice(0, CAP).map(([key, grp, d, ptr, flags]) => ({ key, grp, d, ptr, flags })), truncated: l.rows.length > CAP })),
    facts,
    view,
  };
}

/** hydrate candidate keys ('c' + chunk_id, 'g' + item_id) at the run; unknown keys are left out */
async function rows(client, keys, opts = {}) {
  const ids = (c) => keys.map(String).filter((k) => k[0] === c && /^\d+$/.test(k.slice(1))).map((k) => k.slice(1));
  const { params, p } = statement();
  const sql = `WITH ${head(atRun(p, opts.asOf))}
    SELECT ${VIEW},
      (SELECT coalesce(jsonb_agg(${CHUNK('c', 'i', 'r')}), '[]'::jsonb) FROM brain.chunk c JOIN brain.item_rev r USING (rev_id) JOIN brain.item i USING (item_id)
        WHERE c.chunk_id = ANY(${p(ids('c'))}::bigint[]) AND i.origin = 'repo' AND ${vis('r')}) AS chunks,
      (SELECT coalesce(jsonb_agg(${ITEM('i', 'r')}), '[]'::jsonb) FROM brain.item_rev r JOIN brain.item i USING (item_id)
        WHERE r.item_id = ANY(${p(ids('g'))}::bigint[]) AND i.origin = 'github' AND ${vis('r')}) AS items`;
  const r = (await client.query(sql, params)).rows[0];
  const view = viewOf(r, noRun(opts.asOf));
  return { rows: [...r.chunks.map(chunkRow), ...r.items.map(itemRow)], view };
}

// ---------- get / source ----------

// what the statement looks up for one parsed pointer: an item ptr (or a commit SHA prefix), a revision, a line range
function specOf(p, i) {
  if (GH_TYPES.includes(p.type)) return { i, ptr: `${p.type}:${p.id}`, sha: null, rev: p.rev, a: null, b: null };
  if (p.type === 'commit') return { i, ptr: null, sha: p.sha, rev: p.rev, a: null, b: null };
  if (p.type === 'vault') return { i, ptr: null, sha: null, rev: null, a: null, b: null };
  return { i, ptr: `${p.type}:${p.path}`, sha: null, rev: p.rev, a: p.a, b: p.b };
}
const ptrText = (p) => (p.rev == null ? formatPtr(p) : formatRevPtr(p));

// detail (get): every revision up to R, the thread at R, and the refs of the revision with the ref_link and build of
// the last run it was visible in (e.run: R for the revision visible at R, else the last run before its valid_to)
const REVS = `(SELECT jsonb_agg(jsonb_build_object('rev', x.rev_no, 'run', x.valid_from, 'publishedAt', u.published_at, 'state', x.state) ORDER BY x.rev_no)
  FROM brain.item_rev x JOIN brain.run u ON u.run_id = x.valid_from WHERE x.item_id = i.item_id AND x.valid_from <= ${R})`;
const THREAD = `CASE WHEN i.kind IN ('pr', 'issue') THEN (SELECT coalesce(jsonb_agg(${ITEM('ti', 'tr', false)}
    ORDER BY coalesce(tr.meta->>'submitted_at', tr.meta->>'created_at') ${BYTES} NULLS FIRST, ti.item_id), '[]'::jsonb)
  FROM brain.item_rev tr JOIN brain.item ti USING (item_id)
  WHERE ti.kind IN ('review', 'review_comment', 'issue_comment') AND ${vis('tr')} AND tr.meta->>'parent_number' = r.meta->>'number') ELSE '[]'::jsonb END`;
const REFS = `(SELECT coalesce(jsonb_agg(jsonb_build_object('ptr', i.ptr, 'kind', f.kind, 'target', f.target, 'origin', f.origin, 'status', l.status,
    'reason', l.reason, 'resolved', l.resolved_raw, 'resolved_build', ${BUILD_OF('es.refs', 'i', 'f')},
    'stale', NOT coalesce(${BUILD_OF('es.refs', 'i', 'f')} = eb.meta->>'build_id', false)) ORDER BY f.ref_id), '[]'::jsonb)
  FROM brain.ref f LEFT JOIN brain.ref_link l ON l.ref_id = f.ref_id AND ${vis('l', 'e.run')} WHERE f.rev_id = r.rev_id)`;
const PR_OF_COMMIT = `CASE WHEN i.kind = 'commit' AND c.sha ~ '^[0-9a-f]{7,40}$' AND EXISTS (SELECT 1 FROM s) THEN (SELECT pi.ptr FROM brain.item_rev px
  JOIN brain.item pi USING (item_id) WHERE pi.kind = 'pr' AND ${vis('px')} AND px.state = 'merged' AND px.meta->>'merge_sha' = c.sha ORDER BY pi.item_id LIMIT 1) END`;

async function find(client, parsed, asOf, detail) {
  const { params, p } = statement();
  const sql = `WITH ${head(atRun(p, asOf))},
    q AS (SELECT * FROM jsonb_to_recordset(${p(JSON.stringify(parsed.map(specOf)))}::jsonb) AS x(i int, ptr text, sha text, rev int, a int, b int)),
    -- one revision per pointer: the one visible at R, or rev n if R has seen it; a SHA prefix two commits share finds nothing
    hit AS (SELECT q.i, q.a, q.b, i.item_id, r.rev_id, count(*) OVER (PARTITION BY q.i) AS n
      FROM q JOIN brain.item i ON i.ptr = q.ptr OR (i.kind = 'commit' AND starts_with(i.ptr, 'commit:' || q.sha))
      JOIN brain.item_rev r ON r.item_id = i.item_id
      WHERE CASE WHEN q.rev IS NULL THEN ${vis('r')} ELSE r.rev_no = q.rev AND r.valid_from <= ${R} END)
    SELECT ${VIEW}, (SELECT coalesce(jsonb_agg(jsonb_build_object('i', h.i, 'row', CASE
        WHEN i.origin = 'github' THEN ${ITEM('i', 'r')}${detail ? ` || jsonb_build_object('revs', ${REVS}, 'thread', ${THREAD}, 'refs', ${REFS})` : ''}
        WHEN c.chunk_id IS NOT NULL THEN ${CHUNK('c', 'i', 'r')}${detail ? ` || jsonb_build_object('revs', ${REVS}, 'prPtr', ${PR_OF_COMMIT})` : ''} END)), '[]'::jsonb)
      FROM hit h JOIN brain.item i ON i.item_id = h.item_id JOIN brain.item_rev r ON r.rev_id = h.rev_id
      LEFT JOIN LATERAL (SELECT * FROM brain.chunk c WHERE c.rev_id = r.rev_id
        AND CASE WHEN i.kind = 'commit' THEN c.ord = 0 ELSE c.start_line = h.a AND c.end_line = h.b END) c ON true
      CROSS JOIN LATERAL (SELECT CASE WHEN r.valid_to IS NULL OR r.valid_to > ${R} THEN ${R}
        ELSE (SELECT max(run_id) FROM brain.run WHERE run_id < r.valid_to) END AS run) e   -- run ids have gaps (a rolled-back publish)
      LEFT JOIN LATERAL (SELECT state->'refs' AS refs FROM brain.sync_state WHERE run_id = e.run AND source = 'github') es ON true
      LEFT JOIN brain.run eb ON eb.run_id = e.run
      WHERE h.n = 1) AS found,
    -- PRs and issues share numbers: for pr:N the issue:N visible at R, and back (named when pr:N is not found)
    (SELECT coalesce(jsonb_object_agg(q.i, o.ptr), '{}'::jsonb) FROM q JOIN brain.item o
      ON o.ptr = CASE split_part(q.ptr, ':', 1) WHEN 'pr' THEN 'issue:' WHEN 'issue' THEN 'pr:' END || split_part(q.ptr, ':', 2)
      WHERE EXISTS (SELECT 1 FROM brain.item_rev x WHERE x.item_id = o.item_id AND ${vis('x')})) AS also`;
  const r = (await client.query(sql, params)).rows[0];
  const view = viewOf(r, noRun(asOf));
  // a Phase 1 pointer (@<build>) names the state of one build: stale unless it is this run's (checked before any lookup)
  for (const x of parsed) {
    if (MEMORY_TYPES.includes(x.type) && x.type !== 'vault' && x.rev === null && x.build !== r.v.build) throw new StalePtrError(formatPtr(x), x.build, r.v.build ?? null);
  }
  const found = new Map(r.found.map((x) => [x.i, x.row]));
  return { rows: parsed.map((x, i) => { const j = found.get(i); if (!j) throw new NotFoundError(ptrText(x), r.also[i] ?? null); return j; }), view };
}

async function get(client, ptrs, opts = {}) {
  const parsed = ptrs.map(parseRevPtr);
  const { rows: found, view } = await find(client, parsed, opts.asOf, true);
  const items = found.map((j, i) => (GH_TYPES.includes(parsed[i].type)
    ? { ...itemRow(j), revs: revsOf(j.revs), thread: j.thread.map((x) => pick(x, ITEM_COLS)), refs: j.refs }
    : { ...chunkRow(j), revs: revsOf(j.revs), thread: [], refs: [], prPtr: j.prPtr ?? null }));
  return { items, view };
}

async function source(client, ptr, opts = {}) {
  const p = parseRevPtr(ptr);
  const { rows: [j], view } = await find(client, [p], opts.asOf, false);
  return { row: GH_TYPES.includes(p.type) ? itemRow(j) : chunkRow(j), view };
}

// ---------- --as-of ----------

const AS_OF = /^(?:run:([1-9]\d{0,15})|commit:([0-9a-f]{7,40})|(\d{4}-\d{2}-\d{2})([+-]\d{2}:\d{2})?)$/;
const badAsOf = (spec) => new BrainError('usage', `--as-of takes run:<n>, commit:<sha> or a date YYYY-MM-DD[+hh:mm] (got ${JSON.stringify(String(spec).slice(0, 40))})`);
/** the end of day d at offset off (UTC without one) */
function dayEnd(spec, d, off) {
  const start = Date.parse(`${d}T00:00:00${off ?? 'Z'}`);
  if (!Number.isFinite(start) || new Date(Date.parse(`${d}T00:00:00Z`)).toISOString().slice(0, 10) !== d) throw badAsOf(spec);
  return new Date(start + 86400e3).toISOString();
}

async function resolveAsOf(client, spec) {
  const { params, p } = statement();
  let run = '(SELECT max(run_id) FROM brain.run)', commits = 'NULL', m = null;
  if (spec != null) {
    m = AS_OF.exec(String(spec).trim());
    if (!m) throw badAsOf(spec);
    if (m[1]) run = `(SELECT run_id FROM brain.run WHERE run_id = ${p(m[1])}::bigint)`;
    else if (m[2]) {   // the newest run of that commit; a prefix of two commits is ambiguous
      const sha = p(m[2]);
      run = `(SELECT max(run_id) FROM brain.run WHERE starts_with(commit_sha, ${sha}))`;
      commits = `(SELECT count(DISTINCT commit_sha) FROM brain.run WHERE starts_with(commit_sha, ${sha}))`;
    } else run = `(SELECT max(run_id) FROM brain.run WHERE published_at < ${p(dayEnd(spec, m[3], m[4]))}::timestamptz)`;   // run ids follow publish order
  }
  const r = (await client.query(`WITH ${head(run)} SELECT ${VIEW}, ${commits} AS commits, (SELECT max(run_id) FROM brain.run) AS latest`, params)).rows[0];
  if (Number(r.commits) > 1) throw new BrainError('ambiguous', `--as-of commit:${m[2]} matches ${r.commits} published commits: give more of the SHA`);
  const view = viewOf(r, () => {
    if (spec == null) return new BrainError('not-found', 'the server has no published run yet');
    const e = new NotFoundError(String(spec));
    e.message = `no published run matches --as-of ${String(spec).trim()}`;
    return e;
  });
  return { run: view.run, latest: Number(r.latest), view };
}

/**
 * @param {import('pg').Client} client connected as brain_reader (src/cli.mjs checks the role); close() ends it
 * @returns {import('../pg/contract.mjs').Store}
 */
export function pgStore(client) {
  return {
    candidates: (q, o) => candidates(client, q, o),
    rows: (keys, o) => rows(client, keys, o),
    get: (ptrs, o) => get(client, ptrs, o),
    source: (ptr, o) => source(client, ptr, o),
    resolveAsOf: (spec) => resolveAsOf(client, spec),
    close: () => client.end(),
  };
}
